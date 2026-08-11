import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { env } from "@/server/config/env";
import { getDb } from "@/server/db";
import { accounts, type User } from "@/server/auth/users";
import { isRole, type Role } from "@/lib/permissions";

/**
 * Sessions persistées en SQLite : le cookie ne porte qu'un identifiant signé,
 * l'état fait autorité. Une déconnexion révoque donc réellement la session,
 * y compris si le cookie a été volé — ce qu'un JWT/HMAC stateless ne permet pas.
 */

export type Session = {
  id: string;
  username: string;
  role: Role;
  expiresAt: number;
};

const globalRef = globalThis as typeof globalThis & { __factorioFallbackKey?: Buffer };

function signingKey(): Buffer {
  const secret = env().SESSION_SECRET;
  if (secret) return Buffer.from(secret, "utf8");

  // Sans SESSION_SECRET, la clé dérive des mots de passe configurés : changer
  // un mot de passe invalide les sessions existantes.
  const material = accounts()
    .map((account) => `${account.username}:${account.password}`)
    .join("|");

  if (!material) {
    // Aucun compte : personne ne peut se connecter, une clé aléatoire suffit.
    return (globalRef.__factorioFallbackKey ??= randomBytes(32));
  }

  return createHash("sha256").update(`session-key:${material}`, "utf8").digest();
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

/** Vérifie la signature du cookie puis l'état en base (expiration, révocation). */
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

/** Utilisé quand la configuration change : coupe tout le monde. */
export function revokeAllSessions(now = Date.now()) {
  getDb().prepare(`UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL`).run(now);
}

export function purgeExpiredSessions(now = Date.now()) {
  // On garde une journée de sessions expirées pour l'analyse post-mortem.
  getDb().prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(now - 24 * 60 * 60 * 1000);
}

export function sessionIdFromToken(token: string): string {
  const separator = token.lastIndexOf(".");
  return separator > 0 ? token.slice(0, separator) : "";
}
