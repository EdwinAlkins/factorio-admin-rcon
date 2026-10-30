import { env } from "@/server/config/env";
import { getDb } from "@/server/db";
import type {
  ServerOperationDto,
  ServerOperationStatus,
  ServerOperationStep,
  ServerOperationType,
} from "@/lib/api-types";

/**
 * History of server operations (start, stop, restart).
 *
 * Distinct from the audit log, which records who asked for what: a row here
 * follows one operation through its steps, so the interface can show where a
 * stop stands while it runs, and an operator can see afterwards that a
 * restart was cut short by the panel itself going down.
 */

type Row = {
  id: number;
  type: ServerOperationType;
  status: ServerOperationStatus;
  step: ServerOperationStep | null;
  username: string;
  forced: number;
  started_at: number;
  finished_at: number | null;
  error_code: string | null;
};

function toDto(row: Row): ServerOperationDto {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    step: row.step,
    username: row.username,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code,
    forced: row.forced === 1,
  };
}

const COLUMNS = "id, type, status, step, username, forced, started_at, finished_at, error_code";

export function createOperation(
  input: { type: ServerOperationType; username: string; role: string; forced: boolean },
  now = Date.now(),
): ServerOperationDto {
  const row = getDb()
    .prepare(
      `INSERT INTO server_operations (type, status, username, role, forced, started_at)
       VALUES (?, 'running', ?, ?, ?, ?)
       RETURNING ${COLUMNS}`,
    )
    .get(input.type, input.username, input.role, input.forced ? 1 : 0, now) as unknown as Row;
  return toDto(row);
}

export function setOperationStep(id: number, step: ServerOperationStep) {
  getDb().prepare("UPDATE server_operations SET step = ? WHERE id = ?").run(step, id);
}

export function finishOperation(
  id: number,
  outcome: { status: "success" | "error"; errorCode?: string | null; detail?: string | null },
  now = Date.now(),
) {
  getDb()
    .prepare(
      `UPDATE server_operations
       SET status = ?, step = NULL, finished_at = ?, error_code = ?, detail = ?
       WHERE id = ?`,
    )
    .run(outcome.status, now, outcome.errorCode ?? null, outcome.detail ?? null, id);
}

export function getOperation(id: number): ServerOperationDto | null {
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM server_operations WHERE id = ?`).get(id);
  return row ? toDto(row as unknown as Row) : null;
}

export function recentOperations(limit = 5): ServerOperationDto[] {
  const rows = getDb()
    .prepare(`SELECT ${COLUMNS} FROM server_operations ORDER BY started_at DESC, id DESC LIMIT ?`)
    .all(limit) as unknown as Row[];
  return rows.map(toDto);
}

/**
 * Operations left `running` belong to a previous process: the panel went down
 * mid-operation. Their real outcome is unknown, so they are marked as such
 * rather than left to look like they are still in progress. Called at startup.
 */
export function markInterruptedOperations(now = Date.now()): number {
  const result = getDb()
    .prepare(
      `UPDATE server_operations
       SET status = 'interrupted', step = NULL, finished_at = ?
       WHERE status = 'running'`,
    )
    .run(now);
  return Number(result.changes);
}

/** Same retention as the audit log, which records the same operations. */
export function purgeOperations(now = Date.now()): number {
  const cutoff = now - env().AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const result = getDb().prepare("DELETE FROM server_operations WHERE started_at < ?").run(cutoff);
  return Number(result.changes);
}
