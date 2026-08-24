import { env } from "@/server/config/env";

/**
 * Client minimal de l'API Docker Engine, sans dépendance.
 *
 * Le panneau ne parle jamais au socket Docker : il interroge un proxy en
 * lecture seule (`tecnativa/docker-socket-proxy`, `CONTAINERS=1 POST=0`) placé
 * devant lui. Le proxy expose de l'HTTP sur un hôte du réseau Compose, donc un
 * `fetch` suffit — inutile d'embarquer `dockerode` pour deux requêtes GET.
 *
 * Aucune fonction de ce module ne lève : une panne du proxy doit dégrader les
 * métriques, pas interrompre la collecte.
 */

/** Sous-ensemble de `GET /containers/{id}/stats` réellement utilisé. */
export type DockerStats = {
  cpu_stats?: CpuStats;
  precpu_stats?: CpuStats;
  memory_stats?: {
    usage?: number;
    limit?: number;
    // cgroup v2 expose `inactive_file`, cgroup v1 `total_inactive_file`.
    stats?: { inactive_file?: number; total_inactive_file?: number };
  };
};

type CpuStats = {
  cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
  system_cpu_usage?: number;
  online_cpus?: number;
};

export type MemoryUsage = { bytes: number; limit: number | null };

/**
 * Charge CPU en pourcentage d'un cœur × nombre de cœurs (même convention que
 * `docker stats` : 100 % = un cœur saturé, 400 % = quatre).
 *
 * `stream=false` fait remplir `precpu_stats` par le démon lui-même avec le
 * relevé qu'il vient d'effectuer ~1 s plus tôt : les deux bornes du delta sont
 * donc dans la **même** réponse. Conserver un relevé précédent entre deux
 * échantillons donnerait un delta décalé d'un cran, et donc faux.
 */
export function cpuPercent(stats: DockerStats): number | null {
  const current = stats.cpu_stats;
  const previous = stats.precpu_stats;
  if (!current || !previous) return null;

  // Un `system_cpu_usage` antérieur absent ou nul signale l'absence de point de
  // comparaison (tout premier relevé du conteneur). Sans ce garde, les `?? 0`
  // ci-dessous mesureraient le delta depuis le démarrage de la machine et
  // renverraient un pourcentage inventé.
  if (!previous.system_cpu_usage) return null;

  const cpuDelta = (current.cpu_usage?.total_usage ?? 0) - (previous.cpu_usage?.total_usage ?? 0);
  const systemDelta = (current.system_cpu_usage ?? 0) - previous.system_cpu_usage;

  if (systemDelta <= 0 || cpuDelta < 0) return null;

  const cores = current.online_cpus || current.cpu_usage?.percpu_usage?.length || 1;
  return (cpuDelta / systemDelta) * cores * 100;
}

/**
 * Mémoire réellement utilisée, au sens de `docker stats`.
 *
 * `memory_stats.usage` inclut le cache de fichiers inactifs, que le noyau peut
 * récupérer à tout moment : sans le retrancher, la valeur affichée dérive vers
 * la limite et ne veut plus rien dire.
 *
 * `limit` n'est qu'indicatif : faute de limite propre au conteneur, le démon y
 * renvoie la RAM de l'hôte. Le graphe s'échelonne donc sur le maximum observé
 * et n'affiche la limite qu'en repère chiffré.
 */
export function memoryUsage(stats: DockerStats): MemoryUsage | null {
  const memory = stats.memory_stats;
  if (!memory || typeof memory.usage !== "number") return null;

  const inactive = memory.stats?.inactive_file ?? memory.stats?.total_inactive_file ?? 0;
  const bytes = Math.max(0, memory.usage - inactive);
  const limit = typeof memory.limit === "number" && memory.limit > 0 ? memory.limit : null;

  return { bytes, limit };
}

type ContainerSummary = { Id: string };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function dockerGet<T>(path: string): Promise<T | null> {
  const { DOCKER_API_URL, DOCKER_TIMEOUT_MS } = env();

  const response = await fetch(`${DOCKER_API_URL}${path}`, {
    signal: AbortSignal.timeout(DOCKER_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    // Consommer le corps évite de laisser la socket en attente côté undici.
    await response.body?.cancel();
    if (response.status === 404) return null;
    throw new Error(`docker ${path} → HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}

const globalRef = globalThis as typeof globalThis & { __factorioContainerId?: string };

/**
 * Identifiant du conteneur surveillé, mémorisé entre les échantillons.
 *
 * Recherche d'abord par label Compose, puis par nom : la pile peut avoir été
 * démarrée autrement que par `docker compose`, auquel cas le label est absent.
 */
export async function findContainerId(): Promise<string | null> {
  if (globalRef.__factorioContainerId) return globalRef.__factorioContainerId;

  const service = env().METRICS_CONTAINER;
  const filters = [
    { label: [`com.docker.compose.service=${service}`] },
    // Le filtre `name` de Docker est une expression rationnelle appliquée en
    // sous-chaîne : « factorio » attraperait aussi « factorio-admin-panel », et
    // le panneau finirait par se mesurer lui-même. On l'ancre donc au nom exact
    // (l'API préfixe les noms d'un « / »).
    { name: [`^/${escapeRegExp(service)}$`] },
  ];

  for (const filter of filters) {
    const query = encodeURIComponent(JSON.stringify(filter));
    const found = await dockerGet<ContainerSummary[]>(`/containers/json?filters=${query}`);
    const id = found?.[0]?.Id;
    if (id) {
      globalRef.__factorioContainerId = id;
      return id;
    }
  }

  return null;
}

/** À appeler dès qu'une lecture échoue : le conteneur a pu être recréé. */
export function forgetContainerId() {
  globalRef.__factorioContainerId = undefined;
}

export async function readStats(id: string): Promise<DockerStats | null> {
  return dockerGet<DockerStats>(`/containers/${id}/stats?stream=false`);
}
