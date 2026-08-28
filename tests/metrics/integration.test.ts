import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSeries, readSummary, recordSample } from "@/server/metrics/service";
import { cpuPercent, memoryUsage } from "@/server/metrics/docker";
import { deriveUps } from "@/server/metrics/collector";
import { resetEnvCache, useMemoryDatabase, withEnv } from "../helpers";

/**
 * The full chain: Docker reading → sample → SQLite → aggregation.
 *
 * The unit tests validate each link in isolation; this one checks that units
 * and semantics survive the passage from one to the next.
 */

function dockerStats(totalUsage: number, systemUsage: number, memBytes: number) {
  return {
    cpu_stats: {
      cpu_usage: { total_usage: totalUsage },
      system_cpu_usage: systemUsage,
      online_cpus: 2,
    },
    precpu_stats: {
      cpu_usage: { total_usage: totalUsage - 200_000_000 },
      system_cpu_usage: systemUsage - 1_000_000_000,
      online_cpus: 2,
    },
    memory_stats: {
      usage: memBytes + 50_000_000,
      limit: 4 * 1024 ** 3,
      stats: { inactive_file: 50_000_000 },
    },
  };
}

describe("full chain: Docker → database → aggregation", () => {
  beforeEach(() => {
    withEnv({ METRICS_RETENTION_DAYS: "7", METRICS_INTERVAL_MS: "15000" });
    useMemoryDatabase();
  });

  afterEach(() => {
    withEnv({ METRICS_RETENTION_DAYS: undefined, METRICS_INTERVAL_MS: undefined });
    resetEnvCache();
    vi.restoreAllMocks();
  });

  it("keeps the Docker reading's units all the way to the summary", () => {
    const now = Date.now();
    const stats = dockerStats(2_000_000_000, 40_000_000_000, 1_500_000_000);

    const memory = memoryUsage(stats);
    recordSample(
      {
        cpuPercent: cpuPercent(stats),
        memBytes: memory?.bytes ?? null,
        memLimit: memory?.limit ?? null,
        players: 3,
        gameTick: 1000,
        ups: null,
      },
      now,
    );

    const summary = readSummary("1h", now);
    // 0.2 s of CPU per 1 s of system across 2 cores → 40%.
    expect(summary.cpu.current).toBeCloseTo(40, 5);
    // The inactive cache was indeed subtracted before writing.
    expect(summary.memory.current).toBe(1_500_000_000);
    expect(summary.memLimit).toBe(4 * 1024 ** 3);
  });

  it("reflects a memory limit changed by recreating the container", () => {
    const now = Date.now();
    const base = (limit: number, ts: number) =>
      recordSample(
        { cpuPercent: 10, memBytes: 1000, memLimit: limit, players: null, gameTick: null, ups: null },
        ts,
      );

    base(4 * 1024 ** 3, now - 60_000);
    base(1 * 1024 ** 3, now); // container recreated with a lower limit

    // `MAX(mem_limit)` would have returned 4 GiB: historically exact, wrong now.
    expect(readSummary("1h", now).memLimit).toBe(1 * 1024 ** 3);
  });

  it("rides out a Docker outage without losing the RCON readings", () => {
    const now = Date.now();
    const partial = (cpu: number | null, players: number, ts: number) =>
      recordSample(
        { cpuPercent: cpu, memBytes: cpu === null ? null : 1000, memLimit: null, players, gameTick: null, ups: null },
        ts,
      );

    partial(40, 2, now - 45_000);
    partial(null, 3, now - 30_000); // proxy down
    partial(null, 4, now - 15_000);
    partial(55, 5, now); // proxy revenu

    const summary = readSummary("1h", now);
    expect(summary.cycles).toBe(4);
    expect(summary.cpu.samples).toBe(2);
    expect(summary.players.samples).toBe(4);
    expect(summary.cpu.current).toBe(55);
    expect(summary.players.current).toBe(5);
  });

  it("derives a consistent UPS from two successive stored readings", () => {
    const now = Date.now();
    const first = { tick: 100_000, at: now - 15_000 };
    const second = { tick: 100_900, at: now };

    recordSample(
      { cpuPercent: null, memBytes: null, memLimit: null, players: null, gameTick: first.tick, ups: null },
      first.at,
    );
    recordSample(
      {
        cpuPercent: null,
        memBytes: null,
        memLimit: null,
        players: null,
        gameTick: second.tick,
        ups: deriveUps(first, second, 15_000),
      },
      second.at,
    );

    const summary = readSummary("1h", now);
    expect(summary.ups.current).toBeCloseTo(60, 5);
    // The first reading has no UPS: it had nothing to compare against.
    expect(summary.ups.samples).toBe(1);
    expect(summary.cycles).toBe(2);
  });

  it("aggregates into buckets what the collector wrote round by round", () => {
    const bucketMs = 30_000;
    const now = Math.floor(Date.now() / bucketMs) * bucketMs;

    // An hour of regular rounds, with a burst of load in the middle.
    for (let i = 0; i < 240; i += 1) {
      const ts = now - 60 * 60 * 1000 + i * 15_000;
      const busy = i >= 120 && i < 128;
      recordSample(
        {
          cpuPercent: busy ? 180 : 25,
          memBytes: 1_000_000_000,
          memLimit: 4 * 1024 ** 3,
          players: busy ? 8 : 2,
          gameTick: i * 900,
          ups: busy ? 41 : 60,
        },
        ts,
      );
    }

    const buckets = readSeries("1h", now);
    expect(buckets.length).toBeGreaterThan(50);
    // Every bucket is full: two readings at 15 s for a 30 s slice.
    expect(buckets.every((b) => b.cpu.samples === b.expectedSamples)).toBe(true);

    const busy = buckets.filter((b) => (b.cpu.max ?? 0) > 100);
    expect(busy.length).toBe(4); // 8 readings ÷ 2 per bucket
    expect(busy.every((b) => b.ups.min === 41)).toBe(true);
    expect(readSummary("1h", now).ups.min).toBe(41);
  });
});
