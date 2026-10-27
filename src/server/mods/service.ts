import { z } from "zod";
import { env } from "@/server/config/env";
import { AgentError, isAgentError } from "@/server/agents/errors";
import { ApiFailure } from "@/server/http/errors";
import { limiters } from "@/server/auth/limiters";
import { recordAudit } from "@/server/audit/service";
import { errorFields, logger } from "@/server/log";
import { getServerStatus } from "@/server/rcon/status";
import { agentStatus } from "@/server/control/client";
import { afterServerOperation } from "@/server/control/service";
import { checkPlayers, saveGame, startServer, stopServer, waitForRcon } from "@/server/control/steps";
import {
  dataCreateBackup,
  dataModDetails,
  dataMods,
  dataModSearch,
  dataModsCommit,
  dataModsPlan,
  dataModsRollback,
  dataModsStage,
} from "@/server/data/client";
import { lastFactorioVersion, rememberFactorioVersion } from "@/server/factorio-version";
import { currentOperation, errorCodeOf, launch, type OperationActor } from "@/server/operations/engine";
import { getOperation } from "@/server/operations/store";
import type { Session } from "@/server/auth/session";
import type {
  ModChangeDto,
  ModDetailsDto,
  ModPlanDto,
  ModSearchResult,
  ModsResult,
  ServerOperationDto,
} from "@/lib/api-types";

/**
 * Mods: the installed set, updates, search, and changes applied as one
 * operation with a single restart.
 *
 * The files and the portal are the data agent's business — it is the only
 * component that reaches the Internet. This module orchestrates around it:
 * stopping and restarting the server through the control agent, archiving
 * the map first, and rolling the mods back if the server does not come back.
 */

/** MODS_ENABLED=false: the endpoints answer as if they did not exist. */
export function requireMods() {
  if (!env().MODS_ENABLED) throw ApiFailure.notFound("mods_disabled");
}

/** Mod names as the portal allows them; anything else never reaches the agent. */
export const MOD_NAME = /^[A-Za-z0-9._ -]{1,100}$/;

export const ModChanges = z
  .array(
    z
      .object({
        action: z.enum(["install", "update", "enable", "disable", "remove"]),
        name: z.string().regex(MOD_NAME),
        version: z
          .string()
          .regex(/^[0-9]{1,5}\.[0-9]{1,5}(\.[0-9]{1,5})?$/)
          .optional(),
      })
      .strict(),
  )
  .min(1)
  .max(50);

/** Same budget as start/stop/restart: an apply restarts the server. */
export function limitModsMutation(session: Session, ip: string | null, requestId: string) {
  const verdict = limiters().serverPerSession.consume(`session:${session.id}`);
  if (verdict.allowed) return;
  recordAudit({
    username: session.username,
    role: session.role,
    kind: "mods",
    action: "mods_apply",
    status: "denied",
    detail: "rate limit",
    ip,
    requestId,
  });
  throw ApiFailure.tooManyRequests("rate_limited_session", verdict.retryAfter);
}

// --- Game version -----------------------------------------------------------

/**
 * The version mods are chosen for: the running server's when it answers,
 * otherwise the last one seen. The status bar polls RCON constantly, so the
 * remembered one is current whenever the server has run.
 */
async function knownVersion(fresh: boolean): Promise<string | null> {
  if (fresh || !lastFactorioVersion()) {
    try {
      rememberFactorioVersion((await getServerStatus({ force: fresh })).version);
    } catch {
      // Stopped, or RCON down: fall back to what was seen last.
    }
  }
  return lastFactorioVersion();
}

async function requireVersion(fresh = false): Promise<string> {
  const version = await knownVersion(fresh);
  if (!version) throw new ApiFailure(409, "factorio_version_unknown");
  return version;
}

// --- Reading --------------------------------------------------------------

export async function listMods(): Promise<Omit<ModsResult, "ok">> {
  const factorioVersion = await knownVersion(false);
  const result = await dataMods(factorioVersion);
  const running = currentOperation();
  return {
    mods: result.mods,
    credentials: result.credentials,
    portalError: result.portalError ?? null,
    factorioVersion,
    operation: running ? getOperation(running.operation.id) : null,
  };
}

export async function searchMods(query: string, page: number): Promise<Omit<ModSearchResult, "ok">> {
  return dataModSearch(query, page, await requireVersion());
}

export async function modDetails(name: string): Promise<ModDetailsDto> {
  return dataModDetails(name, await requireVersion());
}

/** What a basket would do; nothing is written. */
export async function planMods(changes: ModChangeDto[]): Promise<ModPlanDto> {
  return dataModsPlan(changes, await requireVersion());
}

// --- Apply ----------------------------------------------------------------

export type ModsApplyRequest = OperationActor & {
  changes: ModChangeDto[];
  /** The plan the operator confirmed: refused if it changed since. */
  planHash: string;
  force: boolean;
};

type Prepared = { plan: ModPlanDto; version: string; running: boolean; rconOk: boolean };

/** A short description of the plan, for the safety archive's label. */
function describe(plan: ModPlanDto): string {
  const sign = { install: "+", update: "↑", enable: "+", disable: "−", remove: "−" } as const;
  const text = plan.steps.map((step) => `${sign[step.action]}${step.name}`).join(" ");
  return `before mods: ${text}`.slice(0, 100);
}

/**
 * Applies a confirmed basket, with a single restart:
 *
 *   download and verify (server still running) → save → stop →
 *   safety archive of the map → swap the mods in → start → wait for RCON.
 *
 * Downloading first means a slow portal, a bad checksum or a crafted archive
 * fails the operation without disconnecting anyone. If the server does not
 * come back with the new mods, they are rolled back and the server restarted
 * as it was; the safety archive (`pre-mods`) stays available either way.
 *
 * `force` overrides the players-online and RCON-unavailable refusals.
 */
export function requestModsApply(request: ModsApplyRequest): Promise<ServerOperationDto> {
  return launch<Prepared>(
    {
      type: "mods_apply",
      auditKind: "mods",
      forced: request.force,
      onSettled: afterServerOperation,

      async prepare(deny) {
        // Mods are swapped while the server is stopped: without the control
        // agent the panel can neither stop nor restart it.
        if (!env().CONTROL_ENABLED) {
          deny("control_disabled");
          throw new AgentError("control_disabled");
        }

        const version = await requireVersion(true);
        let plan: ModPlanDto;
        try {
          plan = await dataModsPlan(request.changes, version);
        } catch (error) {
          if (isAgentError(error)) deny(error.key);
          throw error;
        }
        if (plan.conflicts.length > 0) {
          deny("mods_conflict", plan.conflicts.map((c) => `${c.mod}: ${c.code}`).join(", "));
          throw new AgentError("mods_conflict");
        }
        if (plan.hash !== request.planHash) {
          deny("plan_changed");
          throw new AgentError("plan_changed");
        }
        if (plan.steps.length === 0) {
          deny("mods_nothing_to_do");
          throw new AgentError("mods_nothing_to_do");
        }

        const container = await agentStatus();
        const running = container.state === "running";
        const rconOk = running ? await checkPlayers(request.force, deny) : false;
        return { plan, version, running, rconOk };
      },

      async run({ plan, version, running, rconOk }, step) {
        step("downloading");
        const tx = await dataModsStage(request.changes, version, plan.hash);

        if (running) {
          if (rconOk) {
            step("saving");
            await saveGame();
          }
          step("stopping");
          await stopServer();
        }

        step("archiving");
        try {
          await dataCreateBackup({
            source: "pre-mods",
            label: describe(plan),
            createdBy: request.username,
            factorioVersion: version,
          });
        } catch (error) {
          // A server that never saved has no map to protect.
          if (!(isAgentError(error) && error.key === "no_save")) {
            if (running) {
              step("starting");
              await startServer();
              await waitForRcon();
            }
            throw error;
          }
        }

        try {
          step("installing");
          await dataModsCommit(tx);
          // A stopped server stays stopped: the mods load at its next start.
          if (running) {
            step("starting");
            await startServer();
            step("waiting_rcon");
            await waitForRcon();
          }
        } catch (error) {
          step("rolling_back");
          await rollBack(tx, running, error);
        }
      },
    },
    request,
  );
}

/**
 * Puts the previous mods back after a failed apply and brings the server
 * back as it was, then throws: the operation ends in error either way, and
 * its code says whether the rollback itself worked.
 */
async function rollBack(tx: string, wasRunning: boolean, cause: unknown): Promise<never> {
  const reason = errorCodeOf(cause);
  try {
    const container = await agentStatus().catch(() => null);
    if (container?.state === "running") await stopServer();
    await dataModsRollback(tx);
    if (wasRunning) {
      await startServer();
      await waitForRcon();
    }
  } catch (error) {
    logger.error("mods rollback failed", { tx, reason, ...errorFields(error) });
    throw new ApiFailure(500, "mods_rollback_failed", { reason });
  }
  throw new ApiFailure(502, "mods_rolled_back", { reason });
}
