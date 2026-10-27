import { englishError } from "@/server/error-text";
import type { ErrorParams } from "@/lib/api-types";

/**
 * Agent error taxonomy, on the same model as `RconError`: `key` is the
 * translation key shown to the user, `detail` stays in the logs. The user sees
 * "control agent unreachable", the operator sees
 * `url=http://control-agent:8080 error=ECONNREFUSED`.
 *
 * Two agents, one class: `control_*` keys come from the control agent (Docker
 * socket), `data_*` and the save-specific ones from the data agent (files).
 */

export type AgentName = "control" | "data";

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
  | "checksum_mismatch";

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
};

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

  switch (code) {
    case "backup_not_found":
    case "no_save":
    case "invalid_archive":
    case "checksum_mismatch":
      return code;
    case "io_error":
      return "data_io";
  }
  return status >= 500 ? "data_io" : "data_protocol";
}
