import { env } from "@/server/config/env";
import { getDb } from "@/server/db";
import { errorFields, logger } from "@/server/log";
import type { AuditEntryDto } from "@/lib/api-types";

/**
 * Journal d'audit : qui a fait quoi, avec quel résultat.
 *
 * Écrit systématiquement, y compris pour les refus (permission, rate-limit) :
 * c'est la seule trace durable de l'activité du panneau.
 */

export type AuditKind = "auth" | "rcon" | "action";
export type AuditStatus = "success" | "denied" | "error";

export type AuditInput = {
  username: string;
  role: string;
  kind: AuditKind;
  action: string;
  command?: string | null;
  status: AuditStatus;
  detail?: string | null;
  durationMs?: number | null;
  ip?: string | null;
  requestId?: string | null;
};

/** N'échoue jamais : un problème d'audit ne doit pas casser l'action en cours. */
export function recordAudit(input: AuditInput, now = Date.now()): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO audit_log
           (ts, username, role, kind, action, command, status, detail, duration_ms, ip, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now,
        input.username,
        input.role,
        input.kind,
        input.action,
        input.command ?? null,
        input.status,
        input.detail ?? null,
        input.durationMs ?? null,
        input.ip ?? null,
        input.requestId ?? null,
      );
  } catch (error) {
    logger.error("audit write failed", errorFields(error));
  }
}

export function listAudit(limit = 100): AuditEntryDto[] {
  const rows = getDb()
    .prepare(
      `SELECT id, ts, username, role, kind, action, command, status, detail,
              duration_ms AS durationMs, ip
       FROM audit_log
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(Math.min(Math.max(limit, 1), 500)) as unknown as AuditEntryDto[];

  return rows;
}

export function purgeAudit(now = Date.now()): number {
  const cutoff = now - env().AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const result = getDb().prepare(`DELETE FROM audit_log WHERE ts < ?`).run(cutoff);
  return Number(result.changes ?? 0);
}
