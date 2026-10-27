import { getDb } from "@/server/db";
import { errorFields, logger } from "@/server/log";

/**
 * Settings changed from the interface rather than the environment — the
 * backup schedule, for now. Stored as JSON per key; a value that no longer
 * parses falls back to the default instead of breaking the page.
 */

export function readSetting<T>(key: string, fallback: T): T {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch (error) {
    logger.warn("unreadable setting, default used", { key, ...errorFields(error) });
    return fallback;
  }
}

export function writeSetting(key: string, value: unknown, updatedBy: string | null, now = Date.now()) {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    )
    .run(key, JSON.stringify(value), now, updatedBy);
}
