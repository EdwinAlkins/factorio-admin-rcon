const LUA_COMMANDS = ["/c", "/command", "/silent-command", "/measured-command"];

/**
 * Commandes console Lua : elles désactivent définitivement les succès de la
 * partie. Sert à demander confirmation dans l'interface — ce n'est **pas** une
 * barrière de sécurité : l'API reste ouverte à qui possède `rcon:raw`.
 */
export function isLuaCommand(command: string): boolean {
  const head = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return LUA_COMMANDS.includes(head);
}
