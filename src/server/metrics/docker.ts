import { agentStats } from "@/server/control/client";

/**
 * Container CPU and memory, computed from the Docker stats reading.
 *
 * The panel never talks to the Docker socket: the reading comes from the
 * control agent (`GET /v1/server/stats`), which resolves the Factorio
 * container itself and returns only the fields below.
 */

/** The subset of the Docker stats reading the agent returns. */
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

/** One reading of the Factorio container. Throws a `ControlError` on failure. */
export async function readStats(): Promise<DockerStats> {
  return agentStats();
}
