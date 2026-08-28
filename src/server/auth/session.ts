import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { env } from "@/server/config/env";
import { getDb } from "@/server/db";
import type { User } from "@/server/auth/users";
import { isRole, type Role } from "@/lib/permissions";

/**
 * Sessions persisted in SQLite: the cookie carries only a signed id, and state
 * is authoritative. Signing out therefore really revokes the session, even if
 * the cookie was stolen — something a stateless JWT/HMAC cannot do.
 */

export type Session = {
  id: string;
  username: string;
  role: Role;
  expiresAt: number;
};

/**
 * Cookie signing key. `SESSION_SECRET` is **required**: there is no fallback
 * derived from the passwords. Such a fallback conflated two independent
 * rotations — changing one password signed everybody out — and backed session
 * signatures with a human-chosen secret.
 */
function signingKey(): Buffer {
  return Buffer.from(env().SESSION_SECRET, "utf8");
}

function sign(sessionId: string): string {
  return createHmac("sha256", signingKey()).update(sessionId).digest("base64url");
}

function ttlMs(): number {
  return env().SESSION_TTL_HOURS * 60 * 60 * 1000;
}

export function createSession(user: User, now = Date.now()): { token: string; expiresAt: number } {
  const db = getDb();
  const id = randomUUID();
  const expiresAt = now + ttlMs();

  db.prepare(
    `INSERT INTO sessions (id, username, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, user.username, user.role, now, expiresAt);

  purgeExpiredSessions(now);

  return { token: `${id}.${sign(id)}`, expiresAt };
}

/** Checks the cookie signature, then the stored state (expiry, revocation). */
export function verifySessionToken(token: string | undefined, now = Date.now()): Session | null {
  if (!token) return null;

  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;

  const id = token.slice(0, separator);
  const given = Buffer.from(token.slice(separator + 1), "base64url");
  const expected = Buffer.from(sign(id), "base64url");

  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  const row = getDb()
    .prepare(
      `SELECT id, username, role, expires_at AS expiresAt, revoked_at AS revokedAt
       FROM sessions WHERE id = ?`,
    )
    .get(id) as
    | { id: string; username: string; role: string; expiresAt: number; revokedAt: number | null }
    | undefined;

  if (!row || row.revokedAt !== null || row.expiresAt <= now) return null;
  if (!isRole(row.role)) return null;

  return { id: row.id, username: row.username, role: row.role, expiresAt: row.expiresAt };
}

export function revokeSession(id: string, now = Date.now()) {
  getDb().prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(now, id);
}

/** Used when the configuration changes: signs everybody out. */
export function revokeAllSessions(now = Date.now()) {
  getDb().prepare(`UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL`).run(now);
}

export function purgeExpiredSessions(now = Date.now()) {
  // One day of expired sessions is kept for post-mortem analysis.
  getDb().prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(now - 24 * 60 * 60 * 1000);
}

export function sessionIdFromToken(token: string): string {
  const separator = token.lastIndexOf(".");
  return separator > 0 ? token.slice(0, separator) : "";
}
