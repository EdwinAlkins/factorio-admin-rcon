import { env } from "@/server/config/env";
import { getRcon, rconTarget } from "@/server/rcon";
import { parseOnlinePlayers, parseVersion } from "@/server/rcon/parse";

/**
 * Statut du serveur, mis en cache côté serveur.
 *
 * Sans cela, chaque onglet ouvert déclencherait deux commandes RCON toutes les
 * quelques secondes dans une file volontairement sérialisée. Le cache et la
 * déduplication des requêtes en vol garantissent au plus une mesure par TTL,
 * quel que soit le nombre de clients.
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
  // Séquentiel et assumé : la file RCON sérialise de toute façon les commandes.
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

/** Invalide le cache après une commande susceptible d'avoir changé l'état. */
export function invalidateStatusCache() {
  cache.snapshot = null;
}
