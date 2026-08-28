import { env } from "@/server/config/env";
import { getRcon, rconTarget } from "@/server/rcon";
import { parseOnlinePlayers, parseVersion } from "@/server/rcon/parse";

/**
 * Server status, cached server-side.
 *
 * Without it, every open tab would fire two RCON commands every few seconds
 * into a deliberately serialised queue. The cache and the in-flight
 * deduplication guarantee at most one reading per TTL, however many clients
 * there are.
 */

export type ServerStatusSnapshot = {
  online: string[];
  count: number;
  version: string;
  target: string;
  cachedAt: number;
};

type CacheState = {
  snapshot: ServerStatusSnapshot | null;
  inFlight: Promise<ServerStatusSnapshot> | null;
};

const globalRef = globalThis as typeof globalThis & { __factorioStatusCache?: CacheState };
const cache: CacheState = (globalRef.__factorioStatusCache ??= { snapshot: null, inFlight: null });

async function measure(): Promise<ServerStatusSnapshot> {
  const rcon = getRcon();
  // Sequential on purpose: the RCON queue serialises commands anyway.
  const players = await rcon.execute("/players online");
  const version = await rcon.execute("/version");
  const online = parseOnlinePlayers(players.output);

  return {
    online,
    count: online.length,
    version: parseVersion(version.output),
    target: rconTarget(),
    cachedAt: Date.now(),
  };
}

export async function getServerStatus(options: { force?: boolean } = {}): Promise<ServerStatusSnapshot> {
  const ttl = env().STATUS_CACHE_MS;
  const now = Date.now();

  if (!options.force && cache.snapshot && now - cache.snapshot.cachedAt < ttl) {
    return cache.snapshot;
  }

  if (cache.inFlight) return cache.inFlight;

  cache.inFlight = measure()
    .then((snapshot) => {
      cache.snapshot = snapshot;
      return snapshot;
    })
    .finally(() => {
      cache.inFlight = null;
    });

  return cache.inFlight;
}

/** Invalidates the cache after a command that may have changed the state. */
export function invalidateStatusCache() {
  cache.snapshot = null;
}
