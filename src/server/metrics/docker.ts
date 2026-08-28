import { env } from "@/server/config/env";

/**
 * Minimal Docker Engine API client, with no dependency.
 *
 * The panel never talks to the Docker socket: it queries a read-only proxy
 * (`tecnativa/docker-socket-proxy`, `CONTAINERS=1 POST=0`) sitting in front of
 * it. The proxy speaks HTTP on a Compose-network host, so `fetch` is enough —
 * no need to pull in `dockerode` for two GET requests.
 *
 * No function in this module throws: a proxy outage must degrade the metrics,
 * not interrupt collection.
 */

/** The subset of `GET /containers/{id}/stats` actually used. */
export type DockerStats = {
  cpu_stats?: CpuStats;
  precpu_stats?: CpuStats;
  memory_stats?: {
    usage?: number;
    limit?: number;
    // cgroup v2 exposes `inactive_file`, cgroup v1 `total_inactive_file`.
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
 * CPU load as a percentage of one core × core count (same convention as
 * `docker stats`: 100% = one saturated core, 400% = four).
 *
 * `stream=false` makes the daemon fill `precpu_stats` itself with the reading
 * it took ~1 s earlier, so both ends of the delta come from the **same**
 * response. Keeping a previous reading between two samples would yield a delta
 * shifted by one step, and therefore wrong.
 */
export function cpuPercent(stats: DockerStats): number | null {
  const current = stats.cpu_stats;
  const previous = stats.precpu_stats;
  if (!current || !previous) return null;

  // A missing or zero previous `system_cpu_usage` means there is nothing to
  // compare against (the container's very first reading). Without this guard
  // the `?? 0` below would measure the delta since the machine booted and
  // return an invented percentage.
  if (!previous.system_cpu_usage) return null;

  const cpuDelta = (current.cpu_usage?.total_usage ?? 0) - (previous.cpu_usage?.total_usage ?? 0);
  const systemDelta = (current.system_cpu_usage ?? 0) - previous.system_cpu_usage;

  if (systemDelta <= 0 || cpuDelta < 0) return null;

  const cores = current.online_cpus || current.cpu_usage?.percpu_usage?.length || 1;
  return (cpuDelta / systemDelta) * cores * 100;
}

/**
 * Memory actually in use, in the sense `docker stats` means it.
 *
 * `memory_stats.usage` includes the inactive file cache, which the kernel can
 * reclaim at any time: without subtracting it, the displayed value drifts
 * towards the limit and stops meaning anything.
 *
 * `limit` is indicative only: absent a container-specific limit, the daemon
 * returns the host's RAM there. The chart therefore scales on the observed
 * maximum and shows the limit as a numeric reference only.
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
    // Draining the body keeps undici from leaving the socket hanging.
    await response.body?.cancel();
    if (response.status === 404) return null;
    throw new Error(`docker ${path} → HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}

const globalRef = globalThis as typeof globalThis & { __factorioContainerId?: string };

/**
 * Id of the watched container, remembered between samples.
 *
 * Looked up by Compose label first, then by name: the stack may have been
 * started by something other than `docker compose`, in which case the label is
 * absent.
 */
export async function findContainerId(): Promise<string | null> {
  if (globalRef.__factorioContainerId) return globalRef.__factorioContainerId;

  const service = env().METRICS_CONTAINER;
  const filters = [
    { label: [`com.docker.compose.service=${service}`] },
    // Docker's `name` filter is a regular expression matched as a substring:
    // "factorio" would also catch "factorio-admin-panel", and the panel would
    // end up measuring itself. So it is anchored to the exact name (the API
    // prefixes names with a "/").
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

/** Call this whenever a read fails: the container may have been recreated. */
export function forgetContainerId() {
  globalRef.__factorioContainerId = undefined;
}

export async function readStats(id: string): Promise<DockerStats | null> {
  return dockerGet<DockerStats>(`/containers/${id}/stats?stream=false`);
}
