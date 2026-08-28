import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSeries, readSummary, recordSample, type MetricSample } from "@/server/metrics/service";
import { resetEnvCache, useMemoryDatabase, withEnv } from "../helpers";

/**
 * Coverage is what tells "the server was quiet" apart from "we barely measured
 * anything": two situations that draw the same curve.
 */

const EMPTY: MetricSample = {
  cpuPercent: null,
  memBytes: null,
  memLimit: null,
  players: null,
  gameTick: null,
  ups: null,
};

const sample = (o: Partial<MetricSample>): MetricSample => ({ ...EMPTY, ...o });

describe("reading coverage", () => {
  beforeEach(() => {
    withEnv({ METRICS_RETENTION_DAYS: "7", METRICS_INTERVAL_MS: "15000" });
    useMemoryDatabase();
  });

  afterEach(() => {
    withEnv({ METRICS_RETENTION_DAYS: undefined, METRICS_INTERVAL_MS: undefined });
    resetEnvCache();
  });

  it("counts real readings, not collector rounds", () => {
    const now = Date.now();
    // Ten rounds, but Docker only answered twice.
    for (let i = 0; i < 10; i += 1) {
      recordSample(sample(i < 2 ? { cpuPercent: 50, players: 1 } : { players: 1 }), now - i * 15_000);
    }

    const summary = readSummary("1h", now);
    expect(summary.cycles).toBe(10);
    expect(summary.cpu.samples).toBe(2);
    expect(summary.players.samples).toBe(10);
  });

  it("tells a sparse bucket from a full one with the same average", () => {
    const bucketMs = 30_000; // plage 1 h → 120 buckets
    const now = Math.floor(Date.now() / bucketMs) * bucketMs;

    // Bucket A: both expected readings. Bucket B: only one.
    recordSample(sample({ cpuPercent: 80 }), now - 10 * 60 * 1000);
    recordSample(sample({ cpuPercent: 80 }), now - 10 * 60 * 1000 + 15_000);
    recordSample(sample({ cpuPercent: 80 }), now - 5 * 60 * 1000);

    const buckets = readSeries("1h", now);
    const full = buckets.find((b) => b.cpu.samples === 2);
    const sparse = buckets.find((b) => b.cpu.samples === 1);

    // Both have exactly the same average: only coverage separates them.
    expect(full?.cpu.avg).toBe(80);
    expect(sparse?.cpu.avg).toBe(80);
    expect(full?.expectedSamples).toBe(2);
    expect(sparse?.expectedSamples).toBe(2);
  });

  it("announces expected readings consistent with the configured interval", () => {
    withEnv({ METRICS_INTERVAL_MS: "30000" });
    const now = Date.now();
    recordSample(sample({ cpuPercent: 1 }), now);

    // A 1 h range ÷ 120 buckets = 30 s per bucket, so one expected reading.
    expect(readSeries("1h", now)[0].expectedSamples).toBe(1);
    // And over the whole window: 3600 s ÷ 30 s.
    expect(readSummary("1h", now).expectedSamples).toBe(120);
  });

  it("dates each bucket on its start, not on its first sample", () => {
    const bucketMs = 30_000;
    const now = Math.floor(Date.now() / bucketMs) * bucketMs;
    // A single reading, late within its slice.
    const late = now - 10 * 60 * 1000 + 27_000;
    recordSample(sample({ cpuPercent: 30 }), late);

    const [bucket] = readSeries("1h", now).filter((b) => b.cpu.samples === 1);
    // `MIN(ts)` would have returned `late` and shifted the point right.
    expect(bucket.ts).toBe(Math.floor(late / bucketMs) * bucketMs);
    expect(bucket.ts).toBeLessThan(late);
  });

  it("exposes min and max without picking a side", () => {
    const bucketMs = 30_000;
    const now = Math.floor(Date.now() / bucketMs) * bucketMs;
    recordSample(sample({ cpuPercent: 10, ups: 60 }), now - 10 * 60 * 1000);
    recordSample(sample({ cpuPercent: 95, ups: 22 }), now - 10 * 60 * 1000 + 15_000);

    const bucket = readSeries("1h", now).find((b) => b.cpu.samples === 2);
    // The model does not know CPU worries about the top and UPS the bottom.
    expect(bucket?.cpu).toMatchObject({ min: 10, max: 95 });
    expect(bucket?.ups).toMatchObject({ min: 22, max: 60 });
  });
});
