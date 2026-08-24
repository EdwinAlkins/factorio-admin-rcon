import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSeries, readSummary, recordSample, type MetricSample } from "@/server/metrics/service";
import { resetEnvCache, useMemoryDatabase, withEnv } from "../helpers";

/**
 * La couverture est ce qui distingue « le serveur était calme » de « on n'a
 * presque rien mesuré » : deux situations qui produisent la même courbe.
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

describe("couverture des mesures", () => {
  beforeEach(() => {
    withEnv({ METRICS_RETENTION_DAYS: "7", METRICS_INTERVAL_MS: "15000" });
    useMemoryDatabase();
  });

  afterEach(() => {
    withEnv({ METRICS_RETENTION_DAYS: undefined, METRICS_INTERVAL_MS: undefined });
    resetEnvCache();
  });

  it("compte les mesures réelles, pas les tours du collecteur", () => {
    const now = Date.now();
    // Dix tours, mais Docker n'a répondu que deux fois.
    for (let i = 0; i < 10; i += 1) {
      recordSample(sample(i < 2 ? { cpuPercent: 50, players: 1 } : { players: 1 }), now - i * 15_000);
    }

    const summary = readSummary("1h", now);
    expect(summary.cycles).toBe(10);
    expect(summary.cpu.samples).toBe(2);
    expect(summary.players.samples).toBe(10);
  });

  it("distingue un bucket clairsemé d'un bucket complet portant la même moyenne", () => {
    const bucketMs = 30_000; // plage 1 h → 120 buckets
    const now = Math.floor(Date.now() / bucketMs) * bucketMs;

    // Bucket A : les deux mesures attendues. Bucket B : une seule.
    recordSample(sample({ cpuPercent: 80 }), now - 10 * 60 * 1000);
    recordSample(sample({ cpuPercent: 80 }), now - 10 * 60 * 1000 + 15_000);
    recordSample(sample({ cpuPercent: 80 }), now - 5 * 60 * 1000);

    const buckets = readSeries("1h", now);
    const full = buckets.find((b) => b.cpu.samples === 2);
    const sparse = buckets.find((b) => b.cpu.samples === 1);

    // Les deux ont exactement la même moyenne : seule la couverture les sépare.
    expect(full?.cpu.avg).toBe(80);
    expect(sparse?.cpu.avg).toBe(80);
    expect(full?.expectedSamples).toBe(2);
    expect(sparse?.expectedSamples).toBe(2);
  });

  it("annonce des mesures attendues cohérentes avec l'intervalle configuré", () => {
    withEnv({ METRICS_INTERVAL_MS: "30000" });
    const now = Date.now();
    recordSample(sample({ cpuPercent: 1 }), now);

    // Plage 1 h ÷ 120 buckets = 30 s par bucket, soit une mesure attendue.
    expect(readSeries("1h", now)[0].expectedSamples).toBe(1);
    // Et sur la fenêtre entière : 3600 s ÷ 30 s.
    expect(readSummary("1h", now).expectedSamples).toBe(120);
  });

  it("date chaque bucket sur son début, pas sur son premier échantillon", () => {
    const bucketMs = 30_000;
    const now = Math.floor(Date.now() / bucketMs) * bucketMs;
    // Unique mesure, tardive dans sa tranche.
    const late = now - 10 * 60 * 1000 + 27_000;
    recordSample(sample({ cpuPercent: 30 }), late);

    const [bucket] = readSeries("1h", now).filter((b) => b.cpu.samples === 1);
    // `MIN(ts)` aurait renvoyé `late` et décalé le point vers la droite.
    expect(bucket.ts).toBe(Math.floor(late / bucketMs) * bucketMs);
    expect(bucket.ts).toBeLessThan(late);
  });

  it("expose min et max, sans orienter l'extrême", () => {
    const bucketMs = 30_000;
    const now = Math.floor(Date.now() / bucketMs) * bucketMs;
    recordSample(sample({ cpuPercent: 10, ups: 60 }), now - 10 * 60 * 1000);
    recordSample(sample({ cpuPercent: 95, ups: 22 }), now - 10 * 60 * 1000 + 15_000);

    const bucket = readSeries("1h", now).find((b) => b.cpu.samples === 2);
    // Le modèle ne sait pas que le CPU s'inquiète du haut et l'UPS du bas.
    expect(bucket?.cpu).toMatchObject({ min: 10, max: 95 });
    expect(bucket?.ups).toMatchObject({ min: 22, max: 60 });
  });
});
