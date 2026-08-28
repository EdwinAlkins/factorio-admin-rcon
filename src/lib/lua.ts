const LUA_COMMANDS = ["/c", "/command", "/silent-command", "/measured-command"];

/**
 * Lua console commands: they permanently disable the save's achievements. Used
 * to ask for confirmation in the interface — this is **not** a security
 * barrier: the API stays open to whoever holds `rcon:raw`.
 */
export function isLuaCommand(command: string): boolean {
  const head = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return LUA_COMMANDS.includes(head);
}
