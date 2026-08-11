import { RconError } from "@/server/rcon/errors";

export { isLuaCommand } from "@/lib/lua";

/** Le client C du dépôt plafonne le corps d'un paquet à ~4078 octets. */
export const MAX_COMMAND_BYTES = 4000;

/**
 * Normalise une commande : espaces superflus et retours à la ligne écrasés,
 * pour qu'une saisie ne puisse pas en déclencher deux.
 *
 * Ce n'est PAS un filtrage de sécurité — le contenu reste libre. La restriction
 * de ce qu'un rôle peut envoyer est faite par les permissions (`rcon:raw`).
 */
export function normalizeCommand(input: string): string {
  const command = input.replace(/[\r\n]+/g, " ").trim();

  if (!command) {
    throw new RconError("invalid_command", "Commande vide.");
  }

  if (Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES) {
    throw new RconError(
      "invalid_command",
      `Commande trop longue (maximum ${MAX_COMMAND_BYTES} octets).`,
    );
  }

  return command;
}
