import { describe, expect, it } from "vitest";
import { cpuPercent, memoryUsage, type DockerStats } from "@/server/metrics/docker";

/** A typical reading from `GET /containers/{id}/stats?stream=false`. */
function statsWith(overrides: Partial<DockerStats> = {}): DockerStats {
  return {
    cpu_stats: {
      cpu_usage: { total_usage: 2_000_000_000 },
      system_cpu_usage: 40_000_000_000,
      online_cpus: 4,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 1_800_000_000 },
      system_cpu_usage: 39_000_000_000,
      online_cpus: 4,
    },
    ...overrides,
  };
}

describe("computing CPU load", () => {
  it("scales the delta by core count, like docker stats", () => {
    // 0.2 s of CPU per 1 s of system across 4 cores → 80%.
    expect(cpuPercent(statsWith())).toBeCloseTo(80, 5);
  });

  it("takes both ends from the same response", () => {
    // precpu_stats is filled in by the daemon: the result must not depend on
    // any state kept between two samples.
    const first = cpuPercent(statsWith());
    const second = cpuPercent(statsWith());
    expect(second).toBe(first);
  });

  it("returns null rather than NaN when the system did not advance", () => {
    const stats = statsWith();
    stats.precpu_stats!.system_cpu_usage = stats.cpu_stats!.system_cpu_usage;
    expect(cpuPercent(stats)).toBeNull();
  });

  it("falls back to percpu_usage when online_cpus is absent", () => {
    const stats = statsWith();
    delete stats.cpu_stats!.online_cpus;
    stats.cpu_stats!.cpu_usage!.percpu_usage = [1, 2];
    expect(cpuPercent(stats)).toBeCloseTo(40, 5);
  });

  it("assumes a single core with no indication at all", () => {
    const stats = statsWith();
    delete stats.cpu_stats!.online_cpus;
    expect(cpuPercent(stats)).toBeCloseTo(20, 5);
  });

  it("ignores the very first reading, where precpu_stats is empty", () => {
    expect(cpuPercent(statsWith({ precpu_stats: {} }))).toBeNull();
    expect(cpuPercent(statsWith({ precpu_stats: undefined }))).toBeNull();
  });
});

describe("computing memory", () => {
  it("subtracts cgroup v2's inactive cache", () => {
    const usage = memoryUsage({
      memory_stats: { usage: 1000, limit: 4000, stats: { inactive_file: 400 } },
    });
    expect(usage).toEqual({ bytes: 600, limit: 4000 });
  });

  it("subtracts total_inactive_file on cgroup v1 too", () => {
    const usage = memoryUsage({
      memory_stats: { usage: 1000, limit: 4000, stats: { total_inactive_file: 250 } },
    });
    expect(usage?.bytes).toBe(750);
  });

  it("accepts a reading with no stats block", () => {
    expect(memoryUsage({ memory_stats: { usage: 900, limit: 4000 } })?.bytes).toBe(900);
  });

  it("never goes below zero", () => {
    const usage = memoryUsage({
      memory_stats: { usage: 100, limit: 4000, stats: { inactive_file: 500 } },
    });
    expect(usage?.bytes).toBe(0);
  });

  it("reports a missing limit rather than inventing a scale", () => {
    expect(memoryUsage({ memory_stats: { usage: 900, limit: 0 } })?.limit).toBeNull();
  });

  it("returns null when the memory reading is absent", () => {
    expect(memoryUsage({})).toBeNull();
    expect(memoryUsage({ memory_stats: {} })).toBeNull();
  });
});
