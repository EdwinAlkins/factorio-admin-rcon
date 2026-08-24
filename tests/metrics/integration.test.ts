import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSeries, readSummary, recordSample } from "@/server/metrics/service";
import { cpuPercent, memoryUsage } from "@/server/metrics/docker";
import { deriveUps } from "@/server/metrics/collector";
import { resetEnvCache, useMemoryDatabase, withEnv } from "../helpers";

/**
 * Chaîne complète relevé Docker → échantillon → SQLite → agrégation.
 *
 * Les tests unitaires valident chaque maillon isolément ; celui-ci vérifie que
 * les unités et la sémantique survivent au passage de l'un à l'autre.
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

describe("chaîne complète Docker → base → agrégation", () => {
  beforeEach(() => {
    withEnv({ METRICS_RETENTION_DAYS: "7", METRICS_INTERVAL_MS: "15000" });
    useMemoryDatabase();
  });

  afterEach(() => {
    withEnv({ METRICS_RETENTION_DAYS: undefined, METRICS_INTERVAL_MS: undefined });
    resetEnvCache();
    vi.restoreAllMocks();
  });

  it("conserve les unités du relevé Docker jusqu'au résumé", () => {
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
    // 0,2 s de CPU sur 1 s de système et 2 cœurs → 40 %.
    expect(summary.cpu.current).toBeCloseTo(40, 5);
    // Le cache inactif a bien été retranché avant l'écriture.
    expect(summary.memory.current).toBe(1_500_000_000);
    expect(summary.memLimit).toBe(4 * 1024 ** 3);
  });

  it("reflète une limite mémoire modifiée par la recréation du conteneur", () => {
    const now = Date.now();
    const base = (limit: number, ts: number) =>
      recordSample(
        { cpuPercent: 10, memBytes: 1000, memLimit: limit, players: null, gameTick: null, ups: null },
        ts,
      );

    base(4 * 1024 ** 3, now - 60_000);
    base(1 * 1024 ** 3, now); // conteneur recréé avec une limite plus basse

    // `MAX(mem_limit)` aurait renvoyé 4 Gio : exact historiquement, faux à présent.
    expect(readSummary("1h", now).memLimit).toBe(1 * 1024 ** 3);
  });

  it("traverse une panne Docker sans perdre les mesures RCON", () => {
    const now = Date.now();
    const partial = (cpu: number | null, players: number, ts: number) =>
      recordSample(
        { cpuPercent: cpu, memBytes: cpu === null ? null : 1000, memLimit: null, players, gameTick: null, ups: null },
        ts,
      );

    partial(40, 2, now - 45_000);
    partial(null, 3, now - 30_000); // proxy tombé
    partial(null, 4, now - 15_000);
    partial(55, 5, now); // proxy revenu

    const summary = readSummary("1h", now);
    expect(summary.cycles).toBe(4);
    expect(summary.cpu.samples).toBe(2);
    expect(summary.players.samples).toBe(4);
    expect(summary.cpu.current).toBe(55);
    expect(summary.players.current).toBe(5);
  });

  it("dérive une UPS cohérente à partir de deux relevés successifs stockés", () => {
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
    // Le premier relevé n'a pas d'UPS : il n'avait pas de point de comparaison.
    expect(summary.ups.samples).toBe(1);
    expect(summary.cycles).toBe(2);
  });

  it("agrège en buckets ce que le collecteur a écrit tour par tour", () => {
    const bucketMs = 30_000;
    const now = Math.floor(Date.now() / bucketMs) * bucketMs;

    // Une heure de tours réguliers, avec une bouffée de charge au milieu.
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
    // Chaque bucket est plein : deux relevés à 15 s pour 30 s de tranche.
    expect(buckets.every((b) => b.cpu.samples === b.expectedSamples)).toBe(true);

    const busy = buckets.filter((b) => (b.cpu.max ?? 0) > 100);
    expect(busy.length).toBe(4); // 8 relevés ÷ 2 par bucket
    expect(busy.every((b) => b.ups.min === 41)).toBe(true);
    expect(readSummary("1h", now).ups.min).toBe(41);
  });
});
