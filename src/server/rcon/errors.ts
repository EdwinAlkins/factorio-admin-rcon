import { englishError } from "@/server/error-text";
import type { ErrorParams } from "@/lib/api-types";

/**
 * RCON error taxonomy.
 *
 * `code` carries the technical semantics (HTTP status, retry policy), `key` the
 * translation key shown to the user: several distinct situations can share a
 * code without sharing a message. `detail` stays reserved for the logs: the
 * user sees "server unreachable", the operator sees
 * `host=factorio port=27015 error=ECONNREFUSED`.
 */

export type RconErrorCode =
  | "configuration"
  | "authentication"
  | "connection"
  | "timeout"
  | "protocol"
  | "invalid_command"
  | "backpressure"
  | "unavailable"
  | "internal";

export type RconErrorKey =
  | "config_password"
  | "connection_refused"
  | "connection_lost"
  | "timeout"
  | "auth_rejected"
  | "protocol"
  | "command_empty"
  | "command_too_long"
  | "backpressure"
  | "service_stopping"
  | "probe_failed"
  | "internal";

export const RCON_ERROR_CODE: Record<RconErrorKey, RconErrorCode> = {
  config_password: "configuration",
  connection_refused: "connection",
  connection_lost: "connection",
  timeout: "timeout",
  auth_rejected: "authentication",
  protocol: "protocol",
  command_empty: "invalid_command",
  command_too_long: "invalid_command",
  backpressure: "backpressure",
  service_stopping: "unavailable",
  probe_failed: "internal",
  internal: "internal",
};

export const RCON_HTTP_STATUS: Record<RconErrorCode, number> = {
  configuration: 500,
  authentication: 502,
  connection: 502,
  timeout: 504,
  protocol: 502,
  invalid_command: 400,
  backpressure: 503,
  unavailable: 503,
  internal: 500,
};

/**
 * Recognition mark, taken from the **global** symbol registry.
 *
 * `instanceof` compares class references, so it fails as soon as the module is
 * instantiated twice — which `next dev` does routinely (the metrics collector
 * and the API routes do not share a module graph, yet they share the RCON
 * service through `globalThis`). The error was then treated as an internal
 * failure: a 500 "internal" instead of its real code.
 *
 * `Symbol.for` resolves in a registry shared by the whole process, so two
 * copies of the module get the same symbol and recognise each other.
 */
const BRAND = Symbol.for("factorio-admin.RconError");

export function isRconError(value: unknown): value is RconError {
  return typeof value === "object" && value !== null && BRAND in value;
}

export class RconError extends Error {
  readonly [BRAND] = true;
  readonly key: RconErrorKey;
  readonly code: RconErrorCode;
  readonly detail: string;
  readonly params?: ErrorParams;

  constructor(key: RconErrorKey, options?: { detail?: string; params?: ErrorParams }) {
    super(englishError(key, options?.params));
    this.name = "RconError";
    this.key = key;
    this.code = RCON_ERROR_CODE[key];
    this.detail = options?.detail ?? this.message;
    this.params = options?.params;
  }
}

/** Node errno code (ECONNREFUSED, ENOTFOUND…) when the error carries one. */
export function errnoOf(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : null;
}
