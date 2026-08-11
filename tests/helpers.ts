import { openDatabase, setDb } from "@/server/db";
import { resetLimiters } from "@/server/auth/limiters";

/** Réinitialise la configuration mise en cache pour la durée du processus. */
export function resetEnvCache() {
  (globalThis as Record<string, unknown>).__factorioEnv = undefined;
  (globalThis as Record<string, unknown>).__factorioFallbackKey = undefined;
  resetLimiters();
}

/** Base SQLite en mémoire, isolée pour chaque test. */
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
