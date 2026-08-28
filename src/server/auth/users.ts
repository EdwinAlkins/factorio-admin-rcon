import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "@/server/config/env";
import type { Role } from "@/lib/permissions";

/**
 * Accounts derived from the configuration: one password per role.
 * `ADMIN_PASSWORD` keeps its historical behaviour (full access).
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
 * Compares the supplied password against every configured account without
 * short-circuiting: the duration depends neither on which account matched nor
 * on the length of the passwords.
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
