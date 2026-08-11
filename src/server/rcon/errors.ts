/**
 * Taxonomie d'erreurs RCON.
 *
 * `message` est destiné au client (aucun détail d'infrastructure), `detail`
 * aux logs serveur : l'utilisateur voit « serveur inaccessible », l'exploitant
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
  readonly code: RconErrorCode;
  readonly detail: string;

  constructor(code: RconErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "RconError";
    this.code = code;
    this.detail = detail ?? message;
  }
}

/** Code errno Node (ECONNREFUSED, ENOTFOUND…) si l'erreur en porte un. */
export function errnoOf(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : null;
}
