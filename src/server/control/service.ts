import { env } from "@/server/config/env";
import { recordAudit } from "@/server/audit/service";
import { errorFields, logger } from "@/server/log";
import { ApiFailure, isApiFailure } from "@/server/http/errors";
import { getRcon } from "@/server/rcon";
import { isRconError } from "@/server/rcon/errors";
import { getServerStatus, invalidateStatusCache } from "@/server/rcon/status";
import { agentLogs, agentRestart, agentStart, agentStatus, agentStop } from "@/server/control/client";
import { isControlError } from "@/server/control/errors";
import {
  createOperation,
  finishOperation,
  getOperation,
  recentOperations,
  setOperationStep,
} from "@/server/control/operations";
import type {
  ContainerStatusDto,
  ServerOperationDto,
  ServerOperationType,
  ServerResult,
  ServerState,
} from "@/lib/api-types";

/**
 * Server lifecycle: start, stop, restart.
 *
 * Two sources of truth, never confused: Docker (through the control agent)
 * says whether the container runs, RCON says whether the game answers. That is
 * what tells "stopped on purpose" apart from "running but RCON is down".
 *
 * An operation outlives the HTTP request that asked for it: a stop waits for
 * the save, then for Factorio to quit, which can take minutes on a large map.
 * The route answers 202 with the operation, and the interface follows it
 * through `GET /api/server`. One operation at a time, process-wide.
 */

/** Delays of the polling loops, overridable by the tests. */
export const timing = {
  /** Between two reads of the logs while waiting for the save to finish. */
  savePollMs: 1000,
  /** Between two RCON probes while waiting for the map to load. */
  rconPollMs: 2000,
  /**
   * How long a start may take before RCON answers. Generous: a large modded
   * map can take minutes to load, and giving up early would report a failure
   * for a server that comes up a minute later.
   */
  rconWaitMs: 10 * 60 * 1000,
};

/**
 * A running container whose RCON stays silent for longer than this is
 * reported as `error` rather than `starting`.
 */
const STARTING_GRACE_MS = 10 * 60 * 1000;

/**
 * Lines Factorio writes when a save is complete. A blocking save (the one
 * `/server-save` triggers) ends with "Saving progress: 100%"; a background
 * autosave with "Saving finished".
 */
const SAVE_DONE = /Saving finished|Saving progress: 100(?:\.0+)?%/;

type Running = { operation: ServerOperationDto; done: Promise<void> };

type ContainerReading = { container: ContainerStatusDto | null; controlError: string | null; at: number };

type ControlState = {
  /** `reserved` covers the pre-checks, before the operation row exists. */
  current: Running | "reserved" | null;
  /** Last container reading, shared by every client polling `GET /api/server`. */
  reading: ContainerReading | null;
  inFlight: Promise<ContainerReading> | null;
};

const globalRef = globalThis as typeof globalThis & { __factorioControl?: ControlState };
const control: ControlState = (globalRef.__factorioControl ??= {
  current: null,
  reading: null,
  inFlight: null,
});

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

export type OperationRequest = {
  type: ServerOperationType;
  force: boolean;
  username: string;
  role: string;
  ip: string | null;
  requestId: string;
};

/** Code recorded for a failure: the translation key the interface will show. */
function errorCodeOf(error: unknown): string {
  if (isControlError(error) || isRconError(error)) return error.key;
  if (isApiFailure(error)) return error.code;
  return "internal";
}

function detailOf(error: unknown): string {
  if (isControlError(error) || isRconError(error)) return error.detail;
  return errorFields(error).error as string;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Validates and launches an operation, then returns without waiting for it.
 *
 * Everything that can be refused is refused here, synchronously with the
 * request, so the operator gets the reason as an HTTP error rather than as a
 * failed operation a second later.
 */
export async function requestOperation(request: OperationRequest): Promise<ServerOperationDto> {
  // Checked and taken before the first `await`: Node runs this synchronously,
  // so two simultaneous requests cannot both pass.
  if (control.current !== null) {
    deny(request, "operation_in_progress");
    throw new ApiFailure(409, "operation_in_progress");
  }
  control.current = "reserved";

  let rconOk = false;
  let operation: ServerOperationDto;
  try {
    const container = await agentStatus();

    if (request.type === "start" && (container.state === "running" || container.state === "restarting")) {
      deny(request, "server_already_running");
      throw new ApiFailure(409, "server_already_running");
    }
    if (request.type !== "start" && container.state !== "running") {
      deny(request, "server_not_running");
      throw new ApiFailure(409, "server_not_running");
    }

    if (request.type !== "start") {
      rconOk = await checkPlayers(request);
    }

    operation = createOperation({
      type: request.type,
      username: request.username,
      role: request.role,
      forced: request.force,
    });
  } catch (error) {
    control.current = null;
    throw error;
  }

  logger.info("server operation started", { id: operation.id, type: operation.type, force: request.force });

  const done = run(operation, request, rconOk).finally(() => {
    control.current = null;
    invalidateStatusCache();
    invalidateContainerCache();
  });
  control.current = { operation, done };

  return operation;
}

/**
 * Bringing the server down disconnects whoever is playing, and without RCON
 * the panel can neither count them nor save first. Both need an explicit
 * `force` from the operator. Returns whether RCON answered.
 */
async function checkPlayers(request: OperationRequest): Promise<boolean> {
  let count: number;
  try {
    count = (await getServerStatus({ force: true })).count;
  } catch {
    if (!request.force) {
      deny(request, "rcon_unavailable_force_required");
      throw new ApiFailure(409, "rcon_unavailable_force_required");
    }
    return false;
  }

  if (count > 0 && !request.force) {
    deny(request, "players_online", `${count} online`);
    throw new ApiFailure(409, "players_online", { count });
  }
  return true;
}

function deny(request: OperationRequest, code: string, extra?: string) {
  recordAudit({
    username: request.username,
    role: request.role,
    kind: "server",
    action: request.type,
    status: "denied",
    detail: extra ? `${code}: ${extra}` : code,
    ip: request.ip,
    requestId: request.requestId,
  });
}

async function run(operation: ServerOperationDto, request: OperationRequest, rconOk: boolean) {
  const startedAt = Date.now();

  try {
    if (operation.type !== "start") {
      // Without RCON (forced), there is nothing to ask: Factorio still saves
      // on its own when it receives SIGTERM, within Docker's grace period.
      if (rconOk) {
        setOperationStep(operation.id, "saving");
        await saveAndWait();
      }
      setOperationStep(operation.id, "stopping");
      if (operation.type === "stop") {
        await agentStop();
      } else {
        await agentRestart();
      }
      // The socket points at a process that no longer exists: the next
      // command must open a fresh one.
      await getRcon().disconnect();
    } else {
      setOperationStep(operation.id, "starting");
      await agentStart();
    }

    if (operation.type !== "stop") {
      setOperationStep(operation.id, "waiting_rcon");
      await waitForRcon();
    }

    finishOperation(operation.id, { status: "success" });
    recordAudit({
      username: request.username,
      role: request.role,
      kind: "server",
      action: operation.type,
      status: "success",
      detail: request.force ? "forced" : null,
      durationMs: Date.now() - startedAt,
      ip: request.ip,
      requestId: request.requestId,
    });
    logger.info("server operation done", { id: operation.id, type: operation.type });
  } catch (error) {
    const code = errorCodeOf(error);
    const detail = detailOf(error);

    finishOperation(operation.id, { status: "error", errorCode: code, detail });
    recordAudit({
      username: request.username,
      role: request.role,
      kind: "server",
      action: operation.type,
      status: "error",
      detail: `${code}: ${detail}`,
      durationMs: Date.now() - startedAt,
      ip: request.ip,
      requestId: request.requestId,
    });
    logger.warn("server operation failed", { id: operation.id, type: operation.type, code, detail });
  }
}

/**
 * Asks Factorio to save, then waits until its log says the save is written.
 *
 * `/server-save` returns as soon as the save is scheduled, not when it is on
 * disk: stopping right after could cut it short. The logs are read from just
 * before the command, so a save finishing before the first read still counts.
 */
async function saveAndWait() {
  const since = Math.floor(Date.now() / 1000) - 1;
  await getRcon().execute("/server-save");

  const deadline = Date.now() + env().CONTROL_SAVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const lines = await agentLogs({ tail: 200, since });
    if (lines.some((line) => SAVE_DONE.test(line.text))) return;
    await sleep(timing.savePollMs);
  }

  // The server is left running: stopping it now could lose the save in
  // progress, which is exactly what this step exists to prevent.
  throw new ApiFailure(504, "save_timeout");
}

/** Waits until the freshly started server answers RCON. */
async function waitForRcon() {
  const deadline = Date.now() + timing.rconWaitMs;
  while (Date.now() < deadline) {
    const probe = await getRcon().healthCheck();
    if (probe.ok) return;
    await sleep(timing.rconPollMs);
  }
  throw new ApiFailure(504, "rcon_not_back");
}

/** The running operation, if any (tests await `done`). */
export function currentOperation(): Running | null {
  return typeof control.current === "object" ? control.current : null;
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
