import { readSetting, writeSetting } from "@/server/settings";

/**
 * The game version last seen through RCON, remembered across restarts.
 *
 * Mods are chosen for a version of the game, and the panel learns it only
 * from a running server. Remembering it lets an administrator plan mod
 * changes while the server is stopped — the usual moment to do so.
 */

const KEY = "factorio.version";
const VERSION = /^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$/;

type Memory = { last: string | null };
const globalRef = globalThis as typeof globalThis & { __factorioVersion?: Memory };
const memory: Memory = (globalRef.__factorioVersion ??= { last: null });

/** Records a version read from `/version`; a write only when it changes. */
export function rememberFactorioVersion(version: string) {
  if (!VERSION.test(version) || version === memory.last) return;
  memory.last = version;
  try {
    if (readSetting<string | null>(KEY, null) !== version) writeSetting(KEY, version, "rcon");
  } catch {
    // The status bar must not fail because the database is busy: the next
    // reading tries again.
    memory.last = null;
  }
}

/** The last version seen, or null if the server never answered RCON. */
export function lastFactorioVersion(): string | null {
  const stored = readSetting<unknown>(KEY, null);
  return typeof stored === "string" && VERSION.test(stored) ? stored : null;
}

/** Forgets the in-process copy (tests). */
export function resetFactorioVersionMemory() {
  memory.last = null;
}
