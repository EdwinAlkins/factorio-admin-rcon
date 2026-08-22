/**
 * Modèle de permissions, partagé client/serveur.
 * L'interface s'en sert pour masquer ce qui est interdit, l'API pour le refuser.
 */

export const ROLES = ["viewer", "moderator", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "status:read",
  "action:info",
  "action:moderate",
  "action:server",
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
