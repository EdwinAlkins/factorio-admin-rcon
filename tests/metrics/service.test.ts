import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  purgeMetrics,
  readSeries,
  readSummary,
  recordSample,
  type MetricSample,
} from "@/server/metrics/service";
import { setDb } from "@/server/db";
import { niceCeil } from "@/lib/scale";
import { resetEnvCache, useMemoryDatabase, withEnv } from "../helpers";

const EMPTY: MetricSample = {
  cpuPercent: null,
  memBytes: null,
  memLimit: null,
  players: null,
  gameTick: null,
  ups: null,
};

function sample(overrides: Partial<MetricSample>): MetricSample {
  return { ...EMPTY, ...overrides };
}

describe("metric series", () => {
  beforeEach(() => {
    withEnv({ METRICS_RETENTION_DAYS: "7" });
    useMemoryDatabase();
  });

  afterEach(() => {
    withEnv({ METRICS_RETENTION_DAYS: undefined });
    resetEnvCache();
  });

  it("records and reads back a complete sample", () => {
    const now = Date.now();
    recordSample(
      sample({ cpuPercent: 42, memBytes: 1000, memLimit: 4000, players: 3, ups: 59.5 }),
      now,
    );

    const summary = readSummary("1h", now);
    expect(summary.cycles).toBe(1);
    expect(summary.cpu.current).toBe(42);
    expect(summary.memLimit).toBe(4000);
    expect(summary.players.current).toBe(3);
  });

  it("accepts a partial sample rather than losing it", () => {
    const now = Date.now();
    // Docker proxy unreachable but RCON up: the row must still exist.
    recordSample(sample({ players: 2, ups: 60 }), now);

    const summary = readSummary("1h", now);
    expect(summary.cycles).toBe(1);
    expect(summary.cpu.samples).toBe(0);
    expect(summary.cpu.current).toBeNull();
    expect(summary.players.current).toBe(2);
  });

  it("preserves an isolated spike despite bucket aggregation", () => {
    // Over 1 h, readSeries aggregates in 30 s slices; the clock is aligned to
    // that grid so the spike certainly lands in a populated bucket.
    const bucketMs = 30_000;
    const now = Math.floor(Date.now() / bucketMs) * bucketMs;

    // An hour of quiet samples and a single spike: exactly what the panel has
    // to make visible.
    for (let i = 0; i < 240; i += 1) {
      recordSample(sample({ cpuPercent: 10 }), now - 60 * 60 * 1000 + i * 15_000);
    }
    // Offset by 5 s to share a bucket with quiet samples without overwriting
    // their row (`ts` is the primary key).
    recordSample(sample({ cpuPercent: 95 }), now - 30 * 60 * 1000 + 5_000);

    const spike = readSeries("1h", now).find((bucket) => bucket.cpu.max === 95);
    expect(spike).toBeDefined();
    // The same bucket's average, by contrast, would have erased the spike.
    expect(spike?.cpu.avg).toBeLessThan(95);
    // And the minimum keeps a trace of the surrounding quiet.
    expect(spike?.cpu.min).toBe(10);
  });

  it("keeps the UPS minimum, which is the interesting extreme", () => {
    const now = Date.now();
    for (let i = 0; i < 20; i += 1) {
      recordSample(sample({ ups: 60 }), now - i * 15_000);
    }
    recordSample(sample({ ups: 22 }), now - 5 * 60 * 1000);

    expect(readSummary("1h", now).ups.min).toBe(22);
    expect(Math.min(...readSeries("1h", now).map((b) => b.ups.min ?? 60))).toBe(22);
  });

  it("keeps each metric's last known value separately", () => {
    const now = Date.now();
    // A complete reading, then a partial sample: Docker proxy down while RCON
    // still answers.
    recordSample(sample({ cpuPercent: 42, memBytes: 1000, players: 3 }), now - 30_000);
    recordSample(sample({ players: 5 }), now);

    const summary = readSummary("1h", now);
    // Without this the panel would show "—" for CPU when it was measured
    // thirty seconds ago.
    expect(summary.cpu.current).toBe(42);
    expect(summary.memory.current).toBe(1000);
    expect(summary.players.current).toBe(5);
  });

  it("does not invent a current value outside the range", () => {
    const now = Date.now();
    recordSample(sample({ cpuPercent: 42 }), now - 3 * 60 * 60 * 1000);

    expect(readSummary("1h", now).cpu.current).toBeNull();
    expect(readSummary("6h", now).cpu.current).toBe(42);
  });

  it("excludes samples outside the requested range", () => {
    const now = Date.now();
    recordSample(sample({ cpuPercent: 50 }), now - 3 * 60 * 60 * 1000);
    recordSample(sample({ cpuPercent: 10 }), now);

    expect(readSummary("1h", now).cycles).toBe(1);
    expect(readSummary("6h", now).cycles).toBe(2);
  });

  it("returns no bucket over an empty range", () => {
    const now = Date.now();
    expect(readSeries("1h", now)).toEqual([]);
    expect(readSummary("1h", now).cycles).toBe(0);
    expect(readSummary("1h", now).cpu.current).toBeNull();
  });

  it("deletes samples past the retention window", () => {
    const now = Date.now();
    recordSample(sample({ cpuPercent: 1 }), now - 8 * 24 * 60 * 60 * 1000);
    recordSample(sample({ cpuPercent: 2 }), now - 6 * 24 * 60 * 60 * 1000);
    recordSample(sample({ cpuPercent: 3 }), now);

    expect(purgeMetrics(now)).toBe(1);
    expect(readSummary("7d", now).cycles).toBe(2);
  });

  it("does not interrupt collection when the write fails", () => {
    const db = useMemoryDatabase();
    db.close();
    setDb(db);

    expect(() => recordSample(sample({ cpuPercent: 5 }))).not.toThrow();
  });
});

describe("rounding axis bounds", () => {
  it("rounds up to the next readable step", () => {
    // 202.4% of a dual-core CPU must give an axis at 250, not at 202.4.
    expect(niceCeil(202.4)).toBe(250);
    expect(niceCeil(23)).toBe(25);
    expect(niceCeil(0.7)).toBe(1);
    expect(niceCeil(1500)).toBe(2000);
  });

  it("leaves an already-round bound alone", () => {
    expect(niceCeil(100)).toBe(100);
    expect(niceCeil(50)).toBe(50);
  });

  it("never returns a zero or absurd scale", () => {
    // An axis of height 0 would divide by zero when scaling.
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(-5)).toBe(1);
    expect(niceCeil(Number.NaN)).toBe(1);
  });
});
