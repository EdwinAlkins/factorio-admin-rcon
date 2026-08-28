import { env } from "@/server/config/env";
import { getDb } from "@/server/db";
import { errorFields, logger } from "@/server/log";
import type {
  MetricsAggregateDto,
  MetricsBucketDto,
  MetricsSummaryDto,
} from "@/lib/api-types";

/**
 * Consumption time series: one sample every `METRICS_INTERVAL_MS`, purged past
 * `METRICS_RETENTION_DAYS`.
 *
 * Every column is nullable on purpose: a partial sample (Docker reachable but
 * RCON silent, or the other way round) beats a hole in the series.
 */

export type MetricSample = {
  cpuPercent: number | null;
  memBytes: number | null;
  memLimit: number | null;
  players: number | null;
  gameTick: number | null;
  ups: number | null;
};

export const RANGES = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
} as const;

export type RangeKey = keyof typeof RANGES;

/** Points returned to the client: beyond this the chart gains nothing. */
const BUCKETS = 120;

/**
 * Writes lost since startup.
 *
 * `recordSample` swallows its errors so as not to kill the collector, but
 * without this counter a broken database would make metrics vanish silently
 * for hours, leaving nothing behind but log lines.
 */
const globalRef = globalThis as typeof globalThis & { __factorioMetricsWriteFailures?: number };

export function storageFailures(): number {
  return globalRef.__factorioMetricsWriteFailures ?? 0;
}

/** Never throws: losing one sample must not stop the collector. */
export function recordSample(sample: MetricSample, now = Date.now()): void {
  try {
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO metrics
           (ts, cpu_percent, mem_bytes, mem_limit, players, game_tick, ups)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now,
        sample.cpuPercent,
        sample.memBytes,
        sample.memLimit,
        sample.players,
        sample.gameTick,
        sample.ups,
      );
  } catch (error) {
    globalRef.__factorioMetricsWriteFailures = storageFailures() + 1;
    logger.error("metrics write failed", errorFields(error));
  }
}

type BucketRow = {
  bucket: number;
  cpuSamples: number;
  cpuAvg: number | null;
  cpuMin: number | null;
  cpuMax: number | null;
  memSamples: number;
  memAvg: number | null;
  memMin: number | null;
  memMax: number | null;
  playersSamples: number;
  playersAvg: number | null;
  playersMin: number | null;
  playersMax: number | null;
  upsSamples: number;
  upsAvg: number | null;
  upsMin: number | null;
  upsMax: number | null;
};

/** `COUNT(column)` ignores NULLs, so this is the number of real readings. */
const AGGREGATES = (["cpu_percent", "mem_bytes", "players", "ups"] as const)
  .map((column) => {
    const prefix = { cpu_percent: "cpu", mem_bytes: "mem", players: "players", ups: "ups" }[column];
    return `COUNT(${column}) AS ${prefix}Samples,
              AVG(${column})   AS ${prefix}Avg,
              MIN(${column})   AS ${prefix}Min,
              MAX(${column})   AS ${prefix}Max`;
  })
  .join(",\n              ");

/**
 * Aggregated in SQL rather than in memory: over 7 days the table holds tens of
 * thousands of rows it would be absurd to ship to the browser.
 *
 * Each bucket carries `min`, `max`, `avg` **and the number of readings**. The
 * first three describe the distribution; the last says how much to trust it —
 * an hour-long bucket built from a single reading draws exactly like a full
 * one, and nothing else would give it away.
 *
 * The bounds are neutral (`min`/`max`) rather than opinionated: it is the
 * presentation layer that knows CPU worries about the maximum and UPS about
 * the minimum.
 */
export function readSeries(range: RangeKey, now = Date.now()): MetricsBucketDto[] {
  const from = now - RANGES[range];
  const bucketMs = Math.max(1, Math.floor(RANGES[range] / BUCKETS));

  const rows = getDb()
    .prepare(
      `SELECT ts / CAST(? AS INTEGER) AS bucket,
              ${AGGREGATES}
       FROM metrics
       WHERE ts >= ?
       -- CAST indispensable : node:sqlite lie les nombres JS en REAL, ce qui
       -- ferait une division flottante — chaque échantillon formerait alors
       -- son propre bucket et l'agrégation ne servirait plus à rien.
       GROUP BY bucket
       ORDER BY bucket`,
    )
    .all(bucketMs, from) as unknown as BucketRow[];

  // How many readings a fully covered bucket should hold.
  const expected = Math.max(1, Math.round(bucketMs / env().METRICS_INTERVAL_MS));

  return rows.map((row) => ({
    // The slice's actual start, not the first sample it holds: on sparse data
    // `MIN(ts)` would shift the point to the right and suggest the reading is
    // more recent than it really is.
    ts: row.bucket * bucketMs,
    bucketMs,
    expectedSamples: expected,
    cpu: metric(row.cpuSamples, row.cpuAvg, row.cpuMin, row.cpuMax),
    memory: metric(row.memSamples, row.memAvg, row.memMin, row.memMax),
    players: metric(row.playersSamples, row.playersAvg, row.playersMin, row.playersMax),
    ups: metric(row.upsSamples, row.upsAvg, row.upsMin, row.upsMax),
  }));
}

function metric(
  samples: number,
  avg: number | null,
  min: number | null,
  max: number | null,
): MetricsAggregateDto {
  return { samples, avg, min, max };
}

type SummaryRow = {
  cycles: number;
  cpuSamples: number;
  cpuAvg: number | null;
  cpuMin: number | null;
  cpuMax: number | null;
  memSamples: number;
  memAvg: number | null;
  memMin: number | null;
  memMax: number | null;
  playersSamples: number;
  playersAvg: number | null;
  playersMin: number | null;
  playersMax: number | null;
  upsSamples: number;
  upsAvg: number | null;
  upsMin: number | null;
  upsMax: number | null;
};

/**
 * Last known value of each column, looked up **independently**.
 *
 * Taking the last row wholesale does not work: one partial sample (Docker
 * proxy down, RCON silent) would be enough to show "—" everywhere while the
 * series holds hours of readings. Each metric therefore walks back to its own
 * last usable reading.
 */
function latestOf(column: string, from: number): number | null {
  const row = getDb()
    .prepare(
      `SELECT ${column} AS value
       FROM metrics
       WHERE ts >= ? AND ${column} IS NOT NULL
       ORDER BY ts DESC
       LIMIT 1`,
    )
    .get(from) as unknown as { value: number } | undefined;

  return row?.value ?? null;
}

/** Headline figures: they stay readable without looking at the charts. */
export function readSummary(range: RangeKey, now = Date.now()): MetricsSummaryDto {
  const from = now - RANGES[range];

  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS cycles,
              ${AGGREGATES}
       FROM metrics
       WHERE ts >= ?`,
    )
    .get(from) as unknown as SummaryRow | undefined;

  const expected = Math.max(1, Math.round(RANGES[range] / env().METRICS_INTERVAL_MS));

  return {
    // Collector rounds, not to be confused with the number of readings: a
    // round where both Docker and RCON are silent still writes its row. Each
    // metric therefore carries its own counter.
    cycles: row?.cycles ?? 0,
    expectedSamples: expected,
    cpu: {
      ...metric(row?.cpuSamples ?? 0, row?.cpuAvg ?? null, row?.cpuMin ?? null, row?.cpuMax ?? null),
      current: latestOf("cpu_percent", from),
    },
    memory: {
      ...metric(row?.memSamples ?? 0, row?.memAvg ?? null, row?.memMin ?? null, row?.memMax ?? null),
      current: latestOf("mem_bytes", from),
    },
    players: {
      ...metric(
        row?.playersSamples ?? 0,
        row?.playersAvg ?? null,
        row?.playersMin ?? null,
        row?.playersMax ?? null,
      ),
      current: latestOf("players", from),
    },
    ups: {
      ...metric(row?.upsSamples ?? 0, row?.upsAvg ?? null, row?.upsMin ?? null, row?.upsMax ?? null),
      current: latestOf("ups", from),
    },
    // Last known limit, not the window's maximum: a container recreated with
    // a lower limit would otherwise show the old one, which is historically
    // accurate but currently wrong.
    memLimit: latestOf("mem_limit", from),
  };
}

export function purgeMetrics(now = Date.now()): number {
  const cutoff = now - env().METRICS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const result = getDb().prepare(`DELETE FROM metrics WHERE ts < ?`).run(cutoff);
  return Number(result.changes ?? 0);
}
