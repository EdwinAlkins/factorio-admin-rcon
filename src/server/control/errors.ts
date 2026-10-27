import { englishError } from "@/server/error-text";
import type { ErrorParams } from "@/lib/api-types";

/**
 * Control agent error taxonomy, on the same model as `RconError`: `key` is the
 * translation key shown to the user, `detail` stays in the logs. The user sees
 * "control agent unreachable", the operator sees
 * `url=http://control-agent:8080 error=ECONNREFUSED`.
 */

export type ControlErrorKey =
  | "control_disabled"
  | "control_config"
  | "control_unreachable"
  | "control_timeout"
  | "control_rejected"
  | "control_target_missing"
  | "control_target_ambiguous"
  | "control_busy"
  | "control_rate_limited"
  | "control_docker"
  | "control_protocol";

export const CONTROL_HTTP_STATUS: Record<ControlErrorKey, number> = {
  control_disabled: 404,
  control_config: 500,
  control_unreachable: 502,
  control_timeout: 504,
  // The agent refused the token: a deployment fault, not the user's.
  control_rejected: 500,
  control_target_missing: 503,
  control_target_ambiguous: 503,
  control_busy: 409,
  control_rate_limited: 429,
  control_docker: 502,
  control_protocol: 502,
};

/** See `isRconError`: `instanceof` does not survive a duplicated module. */
const BRAND = Symbol.for("factorio-admin.ControlError");

export function isControlError(value: unknown): value is ControlError {
  return typeof value === "object" && value !== null && BRAND in value;
}

export class ControlError extends Error {
  readonly [BRAND] = true;
  readonly key: ControlErrorKey;
  readonly status: number;
  readonly detail: string;
  readonly params?: ErrorParams;

  constructor(key: ControlErrorKey, options?: { detail?: string; params?: ErrorParams }) {
    super(englishError(key, options?.params));
    this.name = "ControlError";
    this.key = key;
    this.status = CONTROL_HTTP_STATUS[key];
    this.detail = options?.detail ?? this.message;
    this.params = options?.params;
  }
}

/** Maps the agent's own error codes onto the panel's. */
export function fromAgentCode(code: string | undefined, status: number): ControlErrorKey {
  switch (code) {
    case "unauthorized":
      return "control_rejected";
    case "target_missing":
      return "control_target_missing";
    case "target_ambiguous":
      return "control_target_ambiguous";
    case "busy":
      return "control_busy";
    case "rate_limited":
      return "control_rate_limited";
    case "docker_timeout":
      return "control_timeout";
    case "docker_error":
      return "control_docker";
    default:
      return status >= 500 ? "control_docker" : "control_protocol";
  }
}
