import { RconError } from "@/server/rcon/errors";

export { isLuaCommand } from "@/lib/lua";

/** The repository's C client caps a packet body at ~4078 bytes. */
export const MAX_COMMAND_BYTES = 4000;

/**
 * Normalises a command: stray whitespace and line breaks are flattened, so one
 * input cannot trigger two commands.
 *
 * This is NOT a security filter — the content stays free-form. What a role may
 * send is restricted by permissions (`rcon:raw`).
 */
export function normalizeCommand(input: string): string {
  const command = input.replace(/[\r\n]+/g, " ").trim();

  if (!command) {
    throw new RconError("command_empty");
  }

  if (Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES) {
    throw new RconError("command_too_long", { params: { max: MAX_COMMAND_BYTES } });
  }

  return command;
}
