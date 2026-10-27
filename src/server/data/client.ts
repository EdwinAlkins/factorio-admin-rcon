import { env } from "@/server/config/env";
import { agentTransport } from "@/server/agents/transport";
import type { BackupDto, BackupSource, ModDto, SaveFileDto } from "@/lib/api-types";

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

export async function dataSaves(): Promise<{ saves: SaveFileDto[]; mods: ModDto[] }> {
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

export const dataHealthy = transport.healthy;
