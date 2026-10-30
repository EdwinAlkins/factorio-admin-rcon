import { z } from "zod";
import { env } from "@/server/config/env";
import { AgentError, isAgentError } from "@/server/agents/errors";
import { ApiFailure } from "@/server/http/errors";
import { recordAudit } from "@/server/audit/service";
import { limiters } from "@/server/auth/limiters";
import { getServerStatus } from "@/server/rcon/status";
import { afterServerOperation } from "@/server/control/service";
import { dataArchiveWorld } from "@/server/data/client";
import { checkRestore, runRestore, type ServerSnapshot } from "@/server/saves/service";
import { currentOperation, launch, type OperationActor } from "@/server/operations/engine";
import { getOperation } from "@/server/operations/store";
import { worldCatalog, worldCreate, worldDelete, worldList, worldPreview } from "@/server/worlds/client";
import { PREVIEW_SIZES, Seed, WorldSettingsInput } from "@/server/worlds/schema";
import type { Session } from "@/server/auth/session";
import type {
  ModDto,
  ServerOperationDto,
  WorldCatalogDto,
  WorldDto,
  WorldPreviewDto,
  WorldsResult,
} from "@/lib/api-types";

/**
 * Worlds: terrain previews, new maps and their library — the world agent's
 * business, which runs the game's binary and never touches the server's
 * saves — and putting a world in play, which is a restore: the world is
 * copied into the archives by the data agent, then restored with the same
 * checks, safety archive and rollback as any other.
 */

/** World ids as the world agent generates them. */
export const WORLD_ID = /^[0-9]{8}-[0-9]{6}(-[0-9]{1,3})?$/;

/** Preview ids as the world agent generates them. */
export const PREVIEW_ID = /^[0-9a-f]{32}$/;

/** WORLDS_ENABLED=false: the endpoints answer as if they did not exist. */
export function requireWorlds() {
  if (!env().WORLDS_ENABLED) throw new AgentError("world_disabled");
}

/** Who acted, for the audit log. */
type Actor = { session: Session; ip: string | null; requestId: string };

function audit(actor: Actor, action: string, status: "success" | "denied" | "error", detail: string | null) {
  recordAudit({
    username: actor.session.username,
    role: actor.session.role,
    kind: "worlds",
    action,
    status,
    detail,
    ip: actor.ip,
    requestId: actor.requestId,
  });
}

// --- Listing ----------------------------------------------------------------

/** The server's version, when RCON answers; a stopped server has none. */
async function serverVersion(): Promise<string | null> {
  try {
    return (await getServerStatus()).version ?? null;
  } catch {
    return null;
  }
}

export async function listWorlds(): Promise<Omit<WorldsResult, "ok">> {
  const [{ worlds, factorioVersion }, version] = await Promise.all([worldList(), serverVersion()]);
  const running = currentOperation();
  return {
    worlds,
    agentVersion: factorioVersion,
    serverVersion: version,
    operation: running ? getOperation(running.operation.id) : null,
  };
}

export function catalog(): Promise<WorldCatalogDto> {
  return worldCatalog();
}

// --- Preview ----------------------------------------------------------------

export const PreviewInput = z
  .object({
    settings: WorldSettingsInput,
    seed: Seed.optional(),
    size: z
      .number()
      .refine((size) => (PREVIEW_SIZES as readonly number[]).includes(size))
      .default(1024),
    planet: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
      .default("nauvis"),
    offset: z
      .object({ x: z.number().int().min(-1_000_000).max(1_000_000), y: z.number().int().min(-1_000_000).max(1_000_000) })
      .strict()
      .default({ x: 0, y: 0 }),
  })
  .strict();

/**
 * Renders a preview. The resources counted under it are the planet's, from
 * the catalogue: the operator does not pick them.
 */
export async function preview(input: z.infer<typeof PreviewInput>, actor: Actor): Promise<WorldPreviewDto> {
  const verdict = limiters().worldPreviewsPerSession.consume(`session:${actor.session.id}`);
  if (!verdict.allowed) {
    audit(actor, "preview", "denied", "rate limit");
    throw ApiFailure.tooManyRequests("rate_limited_session", verdict.retryAfter);
  }
  const planet = (await worldCatalog()).planets.find((candidate) => candidate.name === input.planet);
  if (!planet) throw ApiFailure.badRequest("invalid_body");

  return worldPreview({
    settings: input.settings,
    seed: input.seed,
    size: input.size,
    planet: planet.name,
    offset: input.offset,
    report: planet.resources.slice(0, 16),
  });
}

// --- Create, delete -----------------------------------------------------------

export const CreateInput = z
  .object({
    name: z
      .string()
      .min(1)
      .max(60)
      .refine((name) => name.trim() === name && !/[\u0000-\u001f\u007f]/.test(name)),
    settings: WorldSettingsInput,
    seed: Seed.optional(),
  })
  .strict();

/**
 * Generates a map into the library. It does not touch the server: a few
 * seconds of the world agent's CPU, while players play on.
 */
export async function createWorld(input: z.infer<typeof CreateInput>, actor: Actor): Promise<WorldDto> {
  try {
    const world = await worldCreate({ ...input, createdBy: actor.session.username });
    audit(actor, "create", "success", `${world.id} "${world.name}" seed ${world.seed}`);
    return world;
  } catch (error) {
    audit(actor, "create", "error", isAgentError(error) ? error.key : "internal");
    throw error;
  }
}

export async function deleteWorld(id: string, actor: Actor): Promise<void> {
  try {
    await worldDelete(id);
    audit(actor, "delete", "success", id);
  } catch (error) {
    audit(actor, "delete", "error", `${id} ${isAgentError(error) ? error.key : "internal"}`);
    throw error;
  }
}

// --- Activate -----------------------------------------------------------------

export type ActivateRequest = OperationActor & { id: string; force: boolean };

type ActivatePlan = { world: WorldDto; server: ServerSnapshot };

/** A world's mod set, in the data agent's shape, to compare with the server's. */
function modSet(world: WorldDto): ModDto[] {
  return world.mods.map((mod) => ({ name: mod.name, version: mod.version, enabled: true, builtin: !mod.version }));
}

/**
 * Puts a world in play:
 *
 *   archive the world (copied and verified by the data agent) → then a
 *   restore of that archive: save → stop → safety archive of the current map
 *   → restore → start → wait for RCON, with a rollback if it fails.
 *
 * The current map is never lost: it is in the safety archive, and the world
 * stays in the library. Refused, unless `force`, when the world was made
 * with another game version or mod set, or when players are online.
 */
export function requestActivate(request: ActivateRequest): Promise<ServerOperationDto> {
  let archived: string | null = null;
  return launch<ActivatePlan>(
    {
      type: "world_activate",
      auditKind: "worlds",
      forced: request.force,
      onSettled: afterServerOperation,

      async prepare(deny) {
        const { worlds } = await worldList();
        const world = worlds.find((candidate) => candidate.id === request.id);
        if (!world) {
          deny("world_not_found");
          throw new AgentError("world_not_found");
        }
        const server = await checkRestore(
          { factorioVersion: world.factorioVersion, mods: modSet(world) },
          request.force,
          deny,
        );
        return { world, server };
      },

      async run({ world, server }, step) {
        // Before the server is touched: a world changed on disk since it was
        // made is refused without disconnecting anyone.
        step("archiving");
        const backup = await dataArchiveWorld(world.id, request.username);
        archived = `${world.id} "${world.name}" → ${backup.id}`;
        await runRestore(backup, server, request.username, step);
      },

      describe: () => archived,
    },
    request,
  );
}
