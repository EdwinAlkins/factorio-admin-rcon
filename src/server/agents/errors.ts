import { englishError } from "@/server/error-text";
import type { ErrorParams } from "@/lib/api-types";

/**
 * Agent error taxonomy, on the same model as `RconError`: `key` is the
 * translation key shown to the user, `detail` stays in the logs. The user sees
 * "control agent unreachable", the operator sees
 * `url=http://control-agent:8080 error=ECONNREFUSED`.
 *
 * Three agents, one class: `control_*` keys come from the control agent
 * (Docker socket), `data_*` and the save-specific ones from the data agent
 * (files), `world_*` and the world-specific ones from the world agent (the
 * game's binary).
 */

export type AgentName = "control" | "data" | "world";

/** Failures any agent call can meet, per agent. */
type TransportKey = "disabled" | "config" | "unreachable" | "timeout" | "rejected" | "busy" | "rate_limited" | "protocol";

export type AgentErrorKey =
  | `${AgentName}_${TransportKey}`
  // Control agent.
  | "control_target_missing"
  | "control_target_ambiguous"
  | "control_docker"
  // Data agent.
  | "data_io"
  | "backup_not_found"
  | "no_save"
  | "invalid_archive"
  | "checksum_mismatch"
  // Data agent, uploads.
  | "upload_not_found"
  | "upload_busy"
  | "upload_offset"
  | "upload_too_large"
  | "upload_incomplete"
  | "uploads_disabled"
  | "chunk_too_large"
  // Data agent, server settings.
  | "server_settings_unavailable"
  | "server_settings_missing"
  | "server_settings_unreadable"
  | "invalid_setting"
  | "settings_changed"
  | "settings_tx_not_found"
  | "public_needs_credentials"
  // Data agent, mods.
  | "mods_conflict"
  | "plan_changed"
  | "mods_nothing_to_do"
  | "tx_not_found"
  | "tx_already_committed"
  | "mods_unavailable"
  | "invalid_mod_archive"
  | "mod_not_found"
  | "portal_credentials_missing"
  | "portal_rejected"
  | "portal_unreachable"
  | "download_too_large"
  | "download_checksum"
  // Data agent, worlds.
  | "world_not_found"
  | "worlds_unavailable"
  // World agent.
  | "world_io"
  | "factorio_refused"
  | "factorio_timeout"
  | "invalid_world_settings"
  | "preview_not_found";

const TRANSPORT_STATUS: Record<TransportKey, number> = {
  disabled: 404,
  config: 500,
  unreachable: 502,
  timeout: 504,
  // The agent refused the token: a deployment fault, not the user's.
  rejected: 500,
  busy: 409,
  rate_limited: 429,
  protocol: 502,
};

const SPECIFIC_STATUS: Partial<Record<AgentErrorKey, number>> = {
  control_target_missing: 503,
  control_target_ambiguous: 503,
  control_docker: 502,
  data_io: 500,
  backup_not_found: 404,
  no_save: 409,
  invalid_archive: 422,
  checksum_mismatch: 422,
  upload_not_found: 404,
  upload_busy: 409,
  upload_offset: 409,
  upload_too_large: 413,
  upload_incomplete: 409,
  uploads_disabled: 404,
  chunk_too_large: 413,
  server_settings_unavailable: 404,
  server_settings_missing: 404,
  server_settings_unreadable: 422,
  invalid_setting: 400,
  settings_changed: 409,
  settings_tx_not_found: 404,
  public_needs_credentials: 422,
  mods_conflict: 409,
  plan_changed: 409,
  mods_nothing_to_do: 409,
  tx_not_found: 404,
  tx_already_committed: 409,
  mods_unavailable: 409,
  invalid_mod_archive: 422,
  mod_not_found: 404,
  portal_credentials_missing: 409,
  portal_rejected: 502,
  portal_unreachable: 502,
  download_too_large: 422,
  download_checksum: 422,
  world_not_found: 404,
  worlds_unavailable: 404,
  world_io: 500,
  factorio_refused: 422,
  factorio_timeout: 504,
  invalid_world_settings: 400,
  preview_not_found: 404,
};

/** Codes the data agent answers for uploads and mods, passed through as they are. */
const PASSTHROUGH_CODES = new Set<AgentErrorKey>([
  "upload_not_found",
  "upload_busy",
  "upload_offset",
  "upload_too_large",
  "upload_incomplete",
  "uploads_disabled",
  "chunk_too_large",
  "server_settings_unavailable",
  "server_settings_missing",
  "server_settings_unreadable",
  "invalid_setting",
  "settings_changed",
  "settings_tx_not_found",
  "public_needs_credentials",
  "mods_conflict",
  "plan_changed",
  "mods_nothing_to_do",
  "tx_not_found",
  "tx_already_committed",
  "mods_unavailable",
  "invalid_mod_archive",
  "mod_not_found",
  "portal_credentials_missing",
  "portal_rejected",
  "portal_unreachable",
  "download_too_large",
  "download_checksum",
  "world_not_found",
  "worlds_unavailable",
]);

/** World agent codes passed through as they are. */
const WORLD_CODES = new Set<AgentErrorKey>([
  "world_not_found",
  "factorio_refused",
  "factorio_timeout",
  "invalid_world_settings",
  "preview_not_found",
]);

/**
 * Refusals whose agent message is meant for the operator: the game's own
 * ("\"nope\" is not a valid autoplace control name.") or the member a
 * setting is wrong in. Shown as `{reason}`.
 */
const REASONED = new Set<AgentErrorKey>(["factorio_refused", "invalid_world_settings"]);

export function agentErrorParams(key: AgentErrorKey, message: string | undefined): ErrorParams | undefined {
  return REASONED.has(key) && message ? { reason: message.slice(0, 500) } : undefined;
}

export function agentHttpStatus(key: AgentErrorKey): number {
  const specific = SPECIFIC_STATUS[key];
  if (specific !== undefined) return specific;
  const transport = key.slice(key.indexOf("_") + 1) as TransportKey;
  return TRANSPORT_STATUS[transport] ?? 502;
}

/** See `isRconError`: `instanceof` does not survive a duplicated module. */
const BRAND = Symbol.for("factorio-admin.AgentError");

export function isAgentError(value: unknown): value is AgentError {
  return typeof value === "object" && value !== null && BRAND in value;
}

export class AgentError extends Error {
  readonly [BRAND] = true;
  readonly key: AgentErrorKey;
  readonly status: number;
  readonly detail: string;
  readonly params?: ErrorParams;

  constructor(key: AgentErrorKey, options?: { detail?: string; params?: ErrorParams }) {
    super(englishError(key, options?.params));
    this.name = "AgentError";
    this.key = key;
    this.status = agentHttpStatus(key);
    this.detail = options?.detail ?? this.message;
    this.params = options?.params;
  }
}

/** Maps an agent's own error codes onto the panel's. */
export function fromAgentCode(agent: AgentName, code: string | undefined, status: number): AgentErrorKey {
  switch (code) {
    case "unauthorized":
      return `${agent}_rejected`;
    case "busy":
      return `${agent}_busy`;
    case "rate_limited":
      return `${agent}_rate_limited`;
  }

  if (agent === "control") {
    switch (code) {
      case "target_missing":
        return "control_target_missing";
      case "target_ambiguous":
        return "control_target_ambiguous";
      case "docker_timeout":
        return "control_timeout";
      case "docker_error":
        return "control_docker";
    }
    return status >= 500 ? "control_docker" : "control_protocol";
  }

  if (agent === "world") {
    if (code === "io_error") return "world_io";
    if (code && WORLD_CODES.has(code as AgentErrorKey)) return code as AgentErrorKey;
    return status >= 500 ? "world_io" : "world_protocol";
  }

  switch (code) {
    case "backup_not_found":
    case "no_save":
    case "invalid_archive":
    case "checksum_mismatch":
      return code;
    case "io_error":
      return "data_io";
  }
  if (code && PASSTHROUGH_CODES.has(code as AgentErrorKey)) return code as AgentErrorKey;
  return status >= 500 ? "data_io" : "data_protocol";
}
