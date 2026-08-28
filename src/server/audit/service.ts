import { createHash } from "node:crypto";
import { env } from "@/server/config/env";
import { getDb } from "@/server/db";
import { errorFields, logger } from "@/server/log";
import type { AuditEntryDto } from "@/lib/api-types";

/**
 * Audit log: who did what, with which outcome.
 *
 * Always written, refusals included (permission, rate limit): it is the only
 * durable trace of the panel's activity.
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

/** Characters of a raw command kept in clear. */
export const RAW_COMMAND_PREVIEW = 48;

function digest(command: string): string {
  return `sha256:${createHash("sha256").update(command, "utf8").digest("hex")}`;
}

/**
 * A raw-console command can contain anything — a token, a key, a password
 * pasted by mistake. Keeping it in full would make the audit log a **second**
 * place where that secret lives on, volume backups included.
 *
 * So we keep enough to investigate without copying it: a prefix, which shows
 * the command without its arguments, and a fingerprint, which lets you match
 * two entries or confirm a specific command by re-hashing it.
 *
 * Catalogue actions escape this treatment: they are built by the server from
 * validated, bounded fields, and seeing the command actually sent is exactly
 * their audit value.
 */
function redact(input: AuditInput): { command: string | null; hash: string | null } {
  const command = input.command ?? null;
  if (command === null || input.kind !== "rcon") return { command, hash: null };

  const hash = digest(command);
  if (env().AUDIT_FULL_COMMANDS) return { command, hash };

  const head = command.slice(0, RAW_COMMAND_PREVIEW);
  return { command: head.length < command.length ? `${head}…` : head, hash };
}

/** Never throws: an audit problem must not break the action in progress. */
export function recordAudit(input: AuditInput, now = Date.now()): void {
  try {
    const { command, hash } = redact(input);

    getDb()
      .prepare(
        `INSERT INTO audit_log
           (ts, username, role, kind, action, command, command_hash, status, detail,
            duration_ms, ip, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now,
        input.username,
        input.role,
        input.kind,
        input.action,
        command,
        hash,
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
      `SELECT id, ts, username, role, kind, action, command,
              command_hash AS commandHash, status, detail,
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
