import { englishError } from "@/server/error-text";
import type { ErrorParams } from "@/lib/api-types";

/**
 * Taxonomie d'erreurs RCON.
 *
 * `code` porte la sémantique technique (statut HTTP, politique de réessai),
 * `key` la clé de traduction affichée à l'utilisateur : plusieurs situations
 * distinctes peuvent partager un code sans partager un message. `detail` reste
 * réservé aux logs : l'utilisateur voit « serveur inaccessible », l'exploitant
 * voit `host=factorio port=27015 error=ECONNREFUSED`.
 */

export type RconErrorCode =
  | "configuration"
  | "authentication"
  | "connection"
  | "timeout"
  | "protocol"
  | "invalid_command"
  | "backpressure"
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
  internal: 500,
};

export class RconError extends Error {
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

/** Code errno Node (ECONNREFUSED, ENOTFOUND…) si l'erreur en porte un. */
export function errnoOf(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : null;
}
