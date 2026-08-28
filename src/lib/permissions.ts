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
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: ["status:read", "action:info"],
  moderator: ["status:read", "action:info", "action:moderate"],
  admin: [
    "status:read",
    "action:info",
    "action:moderate",
    "action:server",
    "action:custom",
    "rcon:raw",
    "audit:read",
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
