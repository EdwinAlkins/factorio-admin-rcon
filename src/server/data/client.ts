import { env } from "@/server/config/env";
import { agentTransport } from "@/server/agents/transport";
import type {
  BackupDto,
  BackupSource,
  InstalledModDto,
  ModChangeDto,
  ModDetailsDto,
  ModDto,
  ModPlanDto,
  ModSearchHitDto,
  SaveFileDto,
  SecretChangeDto,
  ServerSettingsDto,
  UploadStateDto,
} from "@/lib/api-types";

/**
 * Client of the data agent (services/agents, cmd/data-agent): the only
 * component that writes the game's files. It never sees the Docker socket;
 * stopping the server around a restore is done through the control agent.
 */

/**
 * Deadline of an archive or a restore: the agent copies and fully verifies a
 * save, which on a large map is hundreds of megabytes read twice.
 */
const FILE_OPERATION_TIMEOUT_MS = 15 * 60 * 1000;

const transport = agentTransport("data", () => {
  const config = env();
  return {
    url: config.DATA_AGENT_URL,
    token: config.DATA_AGENT_TOKEN,
    tokenFile: config.DATA_AGENT_TOKEN_FILE,
    timeoutMs: config.DATA_AGENT_TIMEOUT_MS,
  };
});

export async function dataSaves(): Promise<{ saves: SaveFileDto[]; mods: ModDto[]; maxUploadBytes: number }> {
  return transport.call({ method: "GET", path: "/v1/saves" });
}

export async function dataBackups(): Promise<BackupDto[]> {
  const result = await transport.call<{ backups: BackupDto[] }>({ method: "GET", path: "/v1/backups" });
  return result.backups;
}

export async function dataCreateBackup(request: {
  source: BackupSource;
  label?: string;
  createdBy: string;
  factorioVersion?: string;
}): Promise<BackupDto> {
  const result = await transport.call<{ backup: BackupDto }>({
    method: "POST",
    path: "/v1/backups",
    body: request,
    timeoutMs: FILE_OPERATION_TIMEOUT_MS,
  });
  return result.backup;
}

export type RestoreResultDto = { saveName: string; replacedDir?: string; replaced: string[] };

export async function dataRestore(id: string): Promise<RestoreResultDto> {
  const result = await transport.call<{ restore: RestoreResultDto }>({
    method: "POST",
    path: `/v1/backups/${encodeURIComponent(id)}/restore`,
    timeoutMs: FILE_OPERATION_TIMEOUT_MS,
  });
  return result.restore;
}

/** Checksum and full read of an archive; throws `checksum_mismatch` or `invalid_archive`. */
export async function dataVerify(id: string): Promise<void> {
  await transport.call({
    method: "GET",
    path: `/v1/backups/${encodeURIComponent(id)}/verify`,
    timeoutMs: FILE_OPERATION_TIMEOUT_MS,
  });
}

export async function dataDeleteBackup(id: string): Promise<void> {
  await transport.call({ method: "DELETE", path: `/v1/backups/${encodeURIComponent(id)}` });
}

export async function dataPrune(policy: {
  sources: BackupSource[];
  keepLast: number;
  maxAgeDays: number;
}): Promise<string[]> {
  const result = await transport.call<{ removed: string[] }>({ method: "POST", path: "/v1/backups/prune", body: policy });
  return result.removed;
}

/**
 * Opens an archive for download. The answer's body is streamed straight to
 * the browser: a whole map never sits in the panel's memory.
 */
export function dataDownload(id: string): Promise<Response> {
  return transport.send({
    method: "GET",
    path: `/v1/backups/${encodeURIComponent(id)}/download`,
    timeoutMs: FILE_OPERATION_TIMEOUT_MS,
  });
}

// --- Uploads --------------------------------------------------------------

/** Deadline of one chunk: a few megabytes written to disk. */
const CHUNK_TIMEOUT_MS = 2 * 60 * 1000;

type UploadAnswer = { upload: UploadStateDto; chunkBytes: number };

export async function dataUploadBegin(size: number, name: string): Promise<UploadAnswer> {
  return transport.call({ method: "POST", path: "/v1/uploads", body: { size, name } });
}

export async function dataUploadOffset(id: string): Promise<UploadAnswer> {
  return transport.call({ method: "GET", path: `/v1/uploads/${encodeURIComponent(id)}` });
}

export async function dataUploadChunk(id: string, offset: number, chunk: Uint8Array<ArrayBuffer>): Promise<UploadAnswer> {
  return transport.call({
    method: "PUT",
    path: `/v1/uploads/${encodeURIComponent(id)}?offset=${offset}`,
    raw: chunk,
    timeoutMs: CHUNK_TIMEOUT_MS,
  });
}

/** Verifies the whole upload as a save, then publishes it as an archive. */
export async function dataUploadComplete(id: string, request: { label?: string; createdBy: string }): Promise<BackupDto> {
  const result = await transport.call<{ backup: BackupDto }>({
    method: "POST",
    path: `/v1/uploads/${encodeURIComponent(id)}/complete`,
    body: request,
    timeoutMs: FILE_OPERATION_TIMEOUT_MS,
  });
  return result.backup;
}

export async function dataUploadAbort(id: string): Promise<void> {
  await transport.call({ method: "DELETE", path: `/v1/uploads/${encodeURIComponent(id)}` });
}

// --- Server settings --------------------------------------------------------

export async function dataServerSettings(): Promise<ServerSettingsDto> {
  return transport.call({ method: "GET", path: "/v1/server-settings" });
}

/** Writes a change; answers the id the previous file is kept under, for a rollback. */
export async function dataServerSettingsUpdate(change: {
  settings: Record<string, unknown>;
  secrets: Record<string, SecretChangeDto>;
  hash: string;
}): Promise<ServerSettingsDto & { tx: string }> {
  return transport.call({ method: "PUT", path: "/v1/server-settings", body: change });
}

export async function dataServerSettingsRollback(tx: string): Promise<void> {
  await transport.call({ method: "POST", path: "/v1/server-settings/rollback", body: { tx } });
}

// --- Mods -----------------------------------------------------------------

/**
 * Deadline of a stage: every release of the basket is downloaded from the
 * portal and fully read back.
 */
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;

/** Deadline of the calls that wait on the portal (plan, search, a mod's page). */
const PORTAL_TIMEOUT_MS = 60 * 1000;

export async function dataMods(factorioVersion: string | null): Promise<{
  mods: InstalledModDto[];
  credentials: boolean;
  portalError?: string;
}> {
  const query = factorioVersion ? `?factorioVersion=${encodeURIComponent(factorioVersion)}` : "";
  return transport.call({ method: "GET", path: `/v1/mods${query}`, timeoutMs: PORTAL_TIMEOUT_MS });
}

export async function dataModSearch(
  query: string,
  page: number,
  factorioVersion: string,
): Promise<{ hits: ModSearchHitDto[]; page: number; pageCount: number }> {
  const params = new URLSearchParams({ q: query, page: String(page), factorioVersion });
  return transport.call({ method: "GET", path: `/v1/mods/search?${params}`, timeoutMs: PORTAL_TIMEOUT_MS });
}

export async function dataModDetails(name: string, factorioVersion: string): Promise<ModDetailsDto> {
  const result = await transport.call<{ mod: ModDetailsDto }>({
    method: "GET",
    path: `/v1/mods/portal/${encodeURIComponent(name)}?factorioVersion=${encodeURIComponent(factorioVersion)}`,
    timeoutMs: PORTAL_TIMEOUT_MS,
  });
  return result.mod;
}

export async function dataModsPlan(changes: ModChangeDto[], factorioVersion: string): Promise<ModPlanDto> {
  const result = await transport.call<{ plan: ModPlanDto }>({
    method: "POST",
    path: "/v1/mods/plan",
    body: { changes, factorioVersion },
    timeoutMs: PORTAL_TIMEOUT_MS,
  });
  return result.plan;
}

/** Downloads and verifies a confirmed plan; the mods folder is not touched. */
export async function dataModsStage(changes: ModChangeDto[], factorioVersion: string, planHash: string): Promise<string> {
  const result = await transport.call<{ tx: string }>({
    method: "POST",
    path: "/v1/mods/stage",
    body: { changes, factorioVersion, planHash },
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
  });
  return result.tx;
}

/** Swaps a staged transaction in. The server must be stopped. */
export async function dataModsCommit(tx: string): Promise<void> {
  await transport.call({ method: "POST", path: "/v1/mods/commit", body: { tx }, timeoutMs: FILE_OPERATION_TIMEOUT_MS });
}

/** Undoes a commit, from its journal; harmless on one never committed. */
export async function dataModsRollback(tx: string): Promise<void> {
  await transport.call({ method: "POST", path: "/v1/mods/rollback", body: { tx }, timeoutMs: FILE_OPERATION_TIMEOUT_MS });
}

export const dataHealthy = transport.healthy;
