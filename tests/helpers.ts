import { openDatabase, setDb } from "@/server/db";
import { resetLimiters } from "@/server/auth/limiters";

/** Resets the configuration cached for the lifetime of the process. */
export function resetEnvCache() {
  (globalThis as Record<string, unknown>).__factorioEnv = undefined;
  resetLimiters();
}

/** In-memory SQLite database, isolated per test. */
export function useMemoryDatabase() {
  const db = openDatabase(":memory:");
  setDb(db);
  return db;
}

export function withEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache();
}
