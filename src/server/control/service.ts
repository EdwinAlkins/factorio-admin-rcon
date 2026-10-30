import { env } from "@/server/config/env";
import { ApiFailure } from "@/server/http/errors";
import { getServerStatus, invalidateStatusCache } from "@/server/rcon/status";
import { agentStatus } from "@/server/control/client";
import {
  checkPlayers,
  restartServer,
  saveGame,
  startServer,
  stopServer,
  waitForRcon,
} from "@/server/control/steps";
import { currentOperation, errorCodeOf, launch, type OperationActor } from "@/server/operations/engine";
import { getOperation, recentOperations } from "@/server/operations/store";
import type {
  ContainerStatusDto,
  ServerOperationDto,
  ServerResult,
  ServerState,
} from "@/lib/api-types";

export { currentOperation } from "@/server/operations/engine";
export { timing } from "@/server/control/steps";

/**
 * Server lifecycle: start, stop, restart — three recipes of the operations
 * engine (`src/server/operations/engine.ts`), which provides the lock, the
 * background run, the history and the audit.
 *
 * Two sources of truth, never confused: Docker (through the control agent)
 * says whether the container runs, RCON says whether the game answers. That is
 * what tells "stopped on purpose" apart from "running but RCON is down".
 */

/**
 * A running container whose RCON stays silent for longer than this is
 * reported as `error` rather than `starting`.
 */
const STARTING_GRACE_MS = 10 * 60 * 1000;

type ContainerReading = { container: ContainerStatusDto | null; controlError: string | null; at: number };

type ControlState = {
  /** Last container reading, shared by every client polling `GET /api/server`. */
  reading: ContainerReading | null;
  inFlight: Promise<ContainerReading> | null;
};

const globalRef = globalThis as typeof globalThis & { __factorioControl?: ControlState };
const control: ControlState = (globalRef.__factorioControl ??= { reading: null, inFlight: null });

/**
 * Container state, cached for STATUS_CACHE_MS with in-flight deduplication —
 * the same contract as the RCON status cache. Every open tab polls
 * `GET /api/server`; without this, each poll of each tab would cost one call
 * to the agent and one inspect on the Docker daemon. A failure is cached too:
 * an agent that is down is not hammered by every client.
 *
 * Not used by the pre-checks of an operation, which must see the state now.
 */
function readContainer(): Promise<ContainerReading> {
  const cached = control.reading;
  if (cached && Date.now() - cached.at < env().STATUS_CACHE_MS) return Promise.resolve(cached);
  if (control.inFlight) return control.inFlight;

  control.inFlight = agentStatus()
    .then(
      (container) => ({ container, controlError: null }),
      (error: unknown) => ({ container: null, controlError: errorCodeOf(error) }),
    )
    .then((reading) => (control.reading = { ...reading, at: Date.now() }))
    .finally(() => {
      control.inFlight = null;
    });

  return control.inFlight;
}

/** Drops the cached container state, after an operation changed it. */
export function invalidateContainerCache() {
  control.reading = null;
}

/** Called when any operation touching the server ends, whatever its outcome. */
export function afterServerOperation() {
  invalidateStatusCache();
  invalidateContainerCache();
}

export type OperationRequest = OperationActor & {
  type: "start" | "stop" | "restart";
  force: boolean;
};

/**
 * Validates and launches a start, stop or restart, then returns without
 * waiting for it.
 */
export function requestOperation(request: OperationRequest): Promise<ServerOperationDto> {
  return launch(
    {
      type: request.type,
      auditKind: "server",
      forced: request.force,
      onSettled: afterServerOperation,

      async prepare(deny) {
        const container = await agentStatus();

        if (request.type === "start") {
          if (container.state === "running" || container.state === "restarting") {
            deny("server_already_running");
            throw new ApiFailure(409, "server_already_running");
          }
          return { rconOk: false };
        }

        if (container.state !== "running") {
          deny("server_not_running");
          throw new ApiFailure(409, "server_not_running");
        }
        return { rconOk: await checkPlayers(request.force, deny) };
      },

      async run({ rconOk }, step) {
        if (request.type === "start") {
          step("starting");
          await startServer();
        } else {
          // Without RCON (forced), there is nothing to ask: Factorio still
          // saves on its own when it receives SIGTERM, within Docker's grace
          // period.
          if (rconOk) {
            step("saving");
            await saveGame();
          }
          step("stopping");
          await (request.type === "stop" ? stopServer() : restartServer());
        }

        if (request.type !== "stop") {
          step("waiting_rcon");
          await waitForRcon();
        }
      },
    },
    request,
  );
}

/**
 * The panel's state, derived from the container, RCON and the operation in
 * progress. Pure, so every combination can be tested.
 */
export function deriveState(
  container: ContainerStatusDto | null,
  rconOk: boolean,
  operation: ServerOperationDto | null,
  now = Date.now(),
): ServerState {
  if (operation?.status === "running") {
    if (operation.step === "starting" || operation.step === "waiting_rcon") return "starting";
    return operation.type === "start" ? "starting" : "stopping";
  }

  if (!container) return "unknown";

  switch (container.state) {
    case "running": {
      if (rconOk) return "running";
      const started = container.startedAt ? Date.parse(container.startedAt) : Number.NaN;
      return Number.isFinite(started) && now - started < STARTING_GRACE_MS ? "starting" : "error";
    }
    case "restarting":
      return "starting";
    case "created":
    case "exited":
      return "stopped";
    case "removing":
      return "stopping";
    default:
      // dead, paused: nothing the panel can explain.
      return "error";
  }
}

export async function getServerState(): Promise<Omit<ServerResult, "ok">> {
  const { container, controlError } = await readContainer();

  // RCON is only probed when there is a game to answer: a stopped server
  // would otherwise log a connection error on every poll.
  const rcon: ServerResult["rcon"] = { ok: false, count: null, version: null };
  if (container?.state === "running") {
    try {
      const status = await getServerStatus();
      Object.assign(rcon, { ok: true, count: status.count, version: status.version });
    } catch {
      // Reported as `rcon.ok: false`; the RCON service already logged why.
    }
  }

  const running = currentOperation();
  // Re-read so the step is current: it changes while the operation runs.
  const operation = running ? getOperation(running.operation.id) : null;

  return {
    state: deriveState(container, rcon.ok, operation),
    container,
    controlError,
    rcon,
    operation,
    recent: recentOperations(5),
  };
}
