import { z } from "zod";
import { env } from "@/server/config/env";
import { AgentError, isAgentError } from "@/server/agents/errors";
import { ApiFailure } from "@/server/http/errors";
import { errorFields, logger } from "@/server/log";
import { getServerStatus } from "@/server/rcon/status";
import { agentStatus } from "@/server/control/client";
import { afterServerOperation } from "@/server/control/service";
import { checkPlayers, saveGame, startServer, stopServer, waitForRcon } from "@/server/control/steps";
import {
  dataBackups,
  dataCreateBackup,
  dataRestore,
  dataSaves,
  dataUploadComplete,
  dataUploadOffset,
  dataVerify,
} from "@/server/data/client";
import { currentOperation, errorCodeOf, launch, type OperationActor } from "@/server/operations/engine";
import { getOperation } from "@/server/operations/store";
import { readSetting, writeSetting } from "@/server/settings";
import type {
  BackupDto,
  BackupSettingsDto,
  BackupSource,
  ModDto,
  SavesResult,
  ServerOperationDto,
  ServerOperationStep,
  UploadStateDto,
} from "@/lib/api-types";

/**
 * Saves: archives taken on demand or on a schedule, downloads, and restores.
 *
 * The files are the data agent's business; this module orchestrates around
 * them — saving through RCON first, stopping and restarting the server
 * through the control agent — as recipes of the operations engine, so a
 * restore can never run while the server is being restarted or another
 * archive is being taken.
 */

/** Archive ids as the data agent generates them; anything else is refused before any call. */
export const BACKUP_ID = /^[0-9]{8}-[0-9]{6}-(manual|scheduled|pre-restore|pre-mods|upload|world)(-[0-9]{1,3})?$/;

/** Upload ids as the data agent generates them. */
export const UPLOAD_ID = /^[0-9a-f]{32}$/;

/** SAVES_ENABLED=false: the endpoints answer as if they did not exist. */
export function requireSaves() {
  if (!env().SAVES_ENABLED) throw new AgentError("data_disabled");
}

// --- Settings -----------------------------------------------------------

const SETTINGS_KEY = "saves.schedule";

export const BackupSettingsInput = z
  .object({
    enabled: z.boolean(),
    // Floored at 15 min: each run copies and verifies a whole save.
    intervalMinutes: z.number().int().min(15).max(7 * 24 * 60),
    keepLast: z.number().int().min(0).max(1000),
    maxAgeDays: z.number().int().min(0).max(365),
    triggerSave: z.boolean(),
  })
  .strict();

const DEFAULT_SETTINGS: BackupSettingsDto = {
  enabled: false,
  intervalMinutes: 60,
  keepLast: 48,
  maxAgeDays: 7,
  triggerSave: false,
  lastRunAt: null,
};

export function backupSettings(): BackupSettingsDto {
  const { lastRunAt, ...stored } = readSetting<Partial<BackupSettingsDto>>(SETTINGS_KEY, {});
  // Re-validated on read: a value stored by an older version, or edited by
  // hand, falls back to the defaults rather than driving the scheduler.
  const parsed = BackupSettingsInput.partial().safeParse(stored);
  return {
    ...DEFAULT_SETTINGS,
    ...(parsed.success ? parsed.data : {}),
    lastRunAt: typeof lastRunAt === "number" ? lastRunAt : null,
  };
}

export function updateBackupSettings(input: z.infer<typeof BackupSettingsInput>, updatedBy: string): BackupSettingsDto {
  const next: BackupSettingsDto = { ...backupSettings(), ...input };
  writeSetting(SETTINGS_KEY, next, updatedBy);
  return next;
}

export function markScheduledRun(at: number) {
  writeSetting(SETTINGS_KEY, { ...backupSettings(), lastRunAt: at }, "scheduler");
}

// --- Listing --------------------------------------------------------------

export async function listSaves(): Promise<Omit<SavesResult, "ok">> {
  const [{ saves, mods, maxUploadBytes }, backups] = await Promise.all([dataSaves(), dataBackups()]);
  const running = currentOperation();
  return {
    saves,
    backups,
    mods,
    settings: backupSettings(),
    operation: running ? getOperation(running.operation.id) : null,
    maxUploadBytes: maxUploadBytes ?? 0,
  };
}

// --- Backup ---------------------------------------------------------------

export type ServerSnapshot = { running: boolean; rconOk: boolean; version: string | undefined };

/**
 * Where the server stands, for deciding whether to save first. Without the
 * control agent (CONTROL_ENABLED=false) the panel cannot read the save's
 * completion from the logs, so it archives the newest file as it is.
 */
export async function snapshot(): Promise<ServerSnapshot> {
  if (!env().CONTROL_ENABLED) return { running: false, rconOk: false, version: undefined };

  const container = await agentStatus();
  if (container.state !== "running") return { running: false, rconOk: false, version: undefined };
  try {
    const status = await getServerStatus({ force: true });
    return { running: true, rconOk: true, version: status.version };
  } catch {
    return { running: true, rconOk: false, version: undefined };
  }
}

export type BackupRequest = OperationActor & {
  source: Extract<BackupSource, "manual" | "scheduled">;
  label?: string;
  /** Ask Factorio to save first (always for a manual backup). */
  triggerSave: boolean;
};

export function requestBackup(request: BackupRequest): Promise<ServerOperationDto> {
  return launch(
    {
      type: "backup",
      auditKind: "saves",
      forced: false,
      prepare: () => snapshot(),

      async run(server, step) {
        if (request.triggerSave && server.rconOk) {
          step("saving");
          await saveGame();
        }
        step("archiving");
        await dataCreateBackup({
          source: request.source,
          label: request.label,
          createdBy: request.username,
          factorioVersion: server.version,
        });
      },
    },
    request,
  );
}

// --- Import -----------------------------------------------------------------

export type ImportRequest = OperationActor & { uploadId: string; label?: string };

/**
 * Publishes a fully received upload as an archive. An operation of the
 * engine, like a backup: the agent reads the whole file back to verify it,
 * which on a large map takes a while, and must not interleave with a
 * restore. Putting the map in play is then an ordinary restore.
 */
export function requestImport(request: ImportRequest): Promise<ServerOperationDto> {
  let published: BackupDto | null = null;
  return launch(
    {
      type: "import",
      auditKind: "saves",
      forced: false,

      async prepare(deny) {
        let upload: UploadStateDto;
        try {
          ({ upload } = await dataUploadOffset(request.uploadId));
        } catch (error) {
          if (isAgentError(error)) deny(error.key);
          throw error;
        }
        if (upload.offset !== upload.size) {
          deny("upload_incomplete");
          throw new AgentError("upload_incomplete");
        }
      },

      async run(_, step) {
        step("verifying");
        published = await dataUploadComplete(request.uploadId, {
          label: request.label,
          createdBy: request.username,
        });
      },

      describe: () =>
        published && `${published.id} ${published.saveName} ${published.size} B sha256:${published.sha256.slice(0, 12)}`,
    },
    request,
  );
}

// --- Restore ----------------------------------------------------------------

function enabledMods(mods: ModDto[]): Map<string, string> {
  return new Map(mods.filter((mod) => mod.enabled).map((mod) => [mod.name, mod.version ?? ""]));
}

/** The game a map was made by: an archive, or a world of the library. */
type MapOrigin = { factorioVersion?: string; mods: ModDto[] };

/**
 * What differs between the game an archive was taken from and the game now.
 * Loading a map into another version or mod set can fail, or migrate the map
 * in a way that cannot be undone: the operator confirms it knowingly.
 */
export function compatibilityGaps(origin: MapOrigin, currentVersion: string | undefined, currentMods: ModDto[]): string[] {
  const gaps: string[] = [];
  if (origin.factorioVersion && currentVersion && origin.factorioVersion !== currentVersion) {
    gaps.push(`Factorio ${origin.factorioVersion} → ${currentVersion}`);
  }
  // An archive taken without the mods folder records no set: nothing to compare.
  if (origin.mods.length > 0 && currentMods.length > 0) {
    const then = enabledMods(origin.mods);
    const now = enabledMods(currentMods);
    for (const [name, version] of then) {
      if (!now.has(name)) gaps.push(`−${name}`);
      else if (now.get(name) !== version) gaps.push(`${name} ${version || "?"} → ${now.get(name) || "?"}`);
    }
    for (const name of now.keys()) {
      if (!then.has(name)) gaps.push(`+${name}`);
    }
  }
  return gaps;
}

export type RestoreRequest = OperationActor & { id: string; force: boolean };

/** Refusals the data agent issues before moving any file. */
const UNTOUCHED = new Set(["backup_not_found", "invalid_archive", "checksum_mismatch"]);

type RestorePlan = { backup: BackupDto; server: ServerSnapshot };

/**
 * The checks a restore makes before stopping anything, once the map to load
 * is known: same game version and mod set (unless forced), and nobody playing
 * (unless forced). Shared with putting a world in play. Throws to refuse,
 * after `deny`.
 */
export async function checkRestore(
  origin: MapOrigin,
  force: boolean,
  deny: (code: string, extra?: string) => void,
): Promise<ServerSnapshot> {
  const server = await snapshot();
  const { mods } = await dataSaves();
  const gaps = compatibilityGaps(origin, server.version, mods);
  if (gaps.length > 0 && !force) {
    deny("restore_incompatible", gaps.join(", "));
    throw new ApiFailure(409, "restore_incompatible", { gaps: gaps.join(", ") });
  }

  if (server.running) {
    server.rconOk = await checkPlayers(force, deny);
  }
  return server;
}

/**
 * Puts an archive back as the server's save:
 *
 *   save (if running) → stop → safety archive of the current state →
 *   restore → start (if it was running) → wait for RCON.
 *
 * If anything fails once the files have been touched, the safety archive is
 * restored the same way and the server brought back as it was; the operation
 * still ends in error, saying whether that rollback worked.
 *
 * `force` overrides the two refusals: a version or mod-set mismatch, and
 * players online / RCON unavailable.
 */
export function requestRestore(request: RestoreRequest): Promise<ServerOperationDto> {
  return launch<RestorePlan>(
    {
      type: "restore",
      auditKind: "saves",
      forced: request.force,
      onSettled: afterServerOperation,

      async prepare(deny) {
        const backups = await dataBackups();
        const backup = backups.find((candidate) => candidate.id === request.id);
        if (!backup) {
          deny("backup_not_found");
          throw new AgentError("backup_not_found");
        }
        // Before anything else: a damaged archive must not cost the players
        // a disconnection.
        try {
          await dataVerify(backup.id);
        } catch (error) {
          if (isAgentError(error)) deny(error.key);
          throw error;
        }
        return { backup, server: await checkRestore(backup, request.force, deny) };
      },

      run: ({ backup, server }, step) => runRestore(backup, server, request.username, step),
    },
    request,
  );
}

/** The work of a restore, once checked; see requestRestore. */
export async function runRestore(
  backup: BackupDto,
  server: ServerSnapshot,
  username: string,
  step: (step: ServerOperationStep) => void,
): Promise<void> {
  if (server.running) {
    if (server.rconOk) {
      step("saving");
      await saveGame();
    }
    step("stopping");
    await stopServer();
  }

  step("archiving");
  let safety: BackupDto | null = null;
  try {
    safety = await dataCreateBackup({
      source: "pre-restore",
      label: `before ${backup.id}`,
      createdBy: username,
      factorioVersion: server.version,
    });
  } catch (error) {
    // A server that never saved has nothing to protect; anything else
    // stops the restore before a single file is touched.
    if (!(isAgentError(error) && error.key === "no_save")) throw error;
  }

  try {
    step("restoring");
    await dataRestore(backup.id);
    if (server.running) {
      step("starting");
      await startServer();
      step("waiting_rcon");
      await waitForRcon();
    }
  } catch (error) {
    // The agent refuses a damaged archive before touching any file:
    // there is nothing to roll back, only the server to bring back.
    if (isAgentError(error) && UNTOUCHED.has(error.key)) {
      if (server.running) {
        step("starting");
        await startServer();
        await waitForRcon();
      }
      throw error;
    }
    step("rolling_back");
    await rollBack(safety, server.running, error);
  }
}

/**
 * Brings the server back to where it was before a failed restore, then
 * throws: the operation ends in error either way, and its code says whether
 * the rollback itself worked.
 */
async function rollBack(safety: BackupDto | null, wasRunning: boolean, cause: unknown): Promise<never> {
  const reason = errorCodeOf(cause);
  try {
    if (!safety) throw new Error("no safety archive to roll back to");
    const container = await agentStatus().catch(() => null);
    if (container?.state === "running") await stopServer();
    await dataRestore(safety.id);
    if (wasRunning) {
      await startServer();
      await waitForRcon();
    }
  } catch (error) {
    logger.error("restore rollback failed", { reason, ...errorFields(error) });
    throw new ApiFailure(500, "restore_rollback_failed", { reason });
  }
  throw new ApiFailure(502, "restore_rolled_back", { reason });
}
