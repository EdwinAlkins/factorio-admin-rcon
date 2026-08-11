import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "@/server/config/env";
import type { Role } from "@/lib/permissions";

/**
 * Comptes dérivés de la configuration : un mot de passe par rôle.
 * `ADMIN_PASSWORD` garde le comportement historique (accès complet).
 */

export type User = { username: string; role: Role };

type Account = User & { password: string };

export function accounts(): Account[] {
  const config = env();
  const list: Account[] = [];

  if (config.ADMIN_PASSWORD) {
    list.push({ username: "admin", role: "admin", password: config.ADMIN_PASSWORD });
  }
  if (config.MODERATOR_PASSWORD) {
    list.push({ username: "moderator", role: "moderator", password: config.MODERATOR_PASSWORD });
  }
  if (config.VIEWER_PASSWORD) {
    list.push({ username: "viewer", role: "viewer", password: config.VIEWER_PASSWORD });
  }

  return list;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Compare le mot de passe fourni à tous les comptes configurés, sans court-circuit :
 * la durée ne dépend ni du compte trouvé ni de la longueur des mots de passe.
 */
export function authenticate(candidate: string): User | null {
  const given = digest(candidate);
  let match: User | null = null;

  for (const account of accounts()) {
    if (timingSafeEqual(digest(account.password), given)) {
      match = { username: account.username, role: account.role };
    }
  }

  return match;
}

export function hasAnyAccount(): boolean {
  return accounts().length > 0;
}
