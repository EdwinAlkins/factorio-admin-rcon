/**
 * Permission model, shared between client and server.
 * The interface uses it to hide what is forbidden, the API to refuse it.
 */

export const ROLES = ["viewer", "moderator", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "status:read",
  "action:info",
  "action:moderate",
  "action:server",
  // Commands from the operator's file that do not explicitly open themselves to
  // a lower role: they often run Lua, so administrator by default.
  "action:custom",
  "rcon:raw",
  "audit:read",
  // Server lifecycle, through the control agent. Reading the state is open to
  // every role; the logs are not: they carry player names and IP addresses.
  "server:read",
  "server:logs",
  "server:start",
  "server:stop",
  "server:restart",
  // server-settings.json: the game's name, password, visibility, autosaves.
  "server:configure",
  // Saves. Moderators can see what archives exist; acting on them —
  // including downloading a copy of the whole map — is for administrators.
  // An uploaded save carries its own scenario scripts, which the server runs.
  "saves:read",
  "saves:create",
  "saves:download",
  "saves:upload",
  "saves:restore",
  "saves:delete",
  "saves:configure",
  // Mods. Anyone may see what the server runs; changing it — which restarts
  // the server and downloads code it will execute — is for administrators.
  "mods:read",
  "mods:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: ["status:read", "action:info", "server:read", "mods:read"],
  moderator: ["status:read", "action:info", "action:moderate", "server:read", "saves:read", "mods:read"],
  admin: [
    "status:read",
    "action:info",
    "action:moderate",
    "action:server",
    "action:custom",
    "rcon:raw",
    "audit:read",
    "server:read",
    "server:logs",
    "server:start",
    "server:stop",
    "server:restart",
    "server:configure",
    "saves:read",
    "saves:create",
    "saves:download",
    "saves:upload",
    "saves:restore",
    "saves:delete",
    "saves:configure",
    "mods:read",
    "mods:manage",
  ],
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsOf(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
