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

describe("séries de métriques", () => {
  beforeEach(() => {
    withEnv({ METRICS_RETENTION_DAYS: "7" });
    useMemoryDatabase();
  });

  afterEach(() => {
    withEnv({ METRICS_RETENTION_DAYS: undefined });
    resetEnvCache();
  });

  it("enregistre et relit un échantillon complet", () => {
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

  it("accepte un échantillon partiel plutôt que de le perdre", () => {
    const now = Date.now();
    // Proxy Docker injoignable mais RCON debout : la ligne doit exister.
    recordSample(sample({ players: 2, ups: 60 }), now);

    const summary = readSummary("1h", now);
    expect(summary.cycles).toBe(1);
    expect(summary.cpu.samples).toBe(0);
    expect(summary.cpu.current).toBeNull();
    expect(summary.players.current).toBe(2);
  });

  it("conserve un pic isolé malgré l'agrégation par buckets", () => {
    // Sur 1 h, readSeries agrège par tranches de 30 s ; l'horloge est calée sur
    // cette grille pour que le pic tombe avec certitude dans un bucket peuplé.
    const bucketMs = 30_000;
    const now = Math.floor(Date.now() / bucketMs) * bucketMs;

    // Une heure d'échantillons calmes, un seul pic : c'est exactement ce que le
    // panneau doit rendre visible.
    for (let i = 0; i < 240; i += 1) {
      recordSample(sample({ cpuPercent: 10 }), now - 60 * 60 * 1000 + i * 15_000);
    }
    // Décalé de 5 s pour partager un bucket avec des échantillons calmes sans
    // écraser leur ligne (`ts` est la clé primaire).
    recordSample(sample({ cpuPercent: 95 }), now - 30 * 60 * 1000 + 5_000);

    const spike = readSeries("1h", now).find((bucket) => bucket.cpu.max === 95);
    expect(spike).toBeDefined();
    // La moyenne du même bucket, elle, aurait effacé le pic.
    expect(spike?.cpu.avg).toBeLessThan(95);
    // Et le minimum garde la trace du calme environnant.
    expect(spike?.cpu.min).toBe(10);
  });

  it("garde le minimum d'UPS, qui est l'extrême intéressant", () => {
    const now = Date.now();
    for (let i = 0; i < 20; i += 1) {
      recordSample(sample({ ups: 60 }), now - i * 15_000);
    }
    recordSample(sample({ ups: 22 }), now - 5 * 60 * 1000);

    expect(readSummary("1h", now).ups.min).toBe(22);
    expect(Math.min(...readSeries("1h", now).map((b) => b.ups.min ?? 60))).toBe(22);
  });

  it("garde la dernière valeur connue de chaque métrique séparément", () => {
    const now = Date.now();
    // Mesure complète, puis un échantillon partiel : proxy Docker coupé alors
    // que RCON répond encore.
    recordSample(sample({ cpuPercent: 42, memBytes: 1000, players: 3 }), now - 30_000);
    recordSample(sample({ players: 5 }), now);

    const summary = readSummary("1h", now);
    // Sans cela, le panneau afficherait « — » pour le CPU alors qu'il vient
    // d'être mesuré il y a trente secondes.
    expect(summary.cpu.current).toBe(42);
    expect(summary.memory.current).toBe(1000);
    expect(summary.players.current).toBe(5);
  });

  it("n'invente pas de valeur courante hors de la plage", () => {
    const now = Date.now();
    recordSample(sample({ cpuPercent: 42 }), now - 3 * 60 * 60 * 1000);

    expect(readSummary("1h", now).cpu.current).toBeNull();
    expect(readSummary("6h", now).cpu.current).toBe(42);
  });

  it("exclut les échantillons hors de la plage demandée", () => {
    const now = Date.now();
    recordSample(sample({ cpuPercent: 50 }), now - 3 * 60 * 60 * 1000);
    recordSample(sample({ cpuPercent: 10 }), now);

    expect(readSummary("1h", now).cycles).toBe(1);
    expect(readSummary("6h", now).cycles).toBe(2);
  });

  it("ne renvoie aucun bucket sur une plage vide", () => {
    const now = Date.now();
    expect(readSeries("1h", now)).toEqual([]);
    expect(readSummary("1h", now).cycles).toBe(0);
    expect(readSummary("1h", now).cpu.current).toBeNull();
  });

  it("supprime les échantillons au-delà de la rétention", () => {
    const now = Date.now();
    recordSample(sample({ cpuPercent: 1 }), now - 8 * 24 * 60 * 60 * 1000);
    recordSample(sample({ cpuPercent: 2 }), now - 6 * 24 * 60 * 60 * 1000);
    recordSample(sample({ cpuPercent: 3 }), now);

    expect(purgeMetrics(now)).toBe(1);
    expect(readSummary("7d", now).cycles).toBe(2);
  });

  it("n'interrompt pas la collecte si l'écriture échoue", () => {
    const db = useMemoryDatabase();
    db.close();
    setDb(db);

    expect(() => recordSample(sample({ cpuPercent: 5 }))).not.toThrow();
  });
});

describe("arrondi des bornes d'axe", () => {
  it("remonte au palier lisible supérieur", () => {
    // 202,4 % d'un CPU bicœur doit donner un axe à 250, pas à 202,4.
    expect(niceCeil(202.4)).toBe(250);
    expect(niceCeil(23)).toBe(25);
    expect(niceCeil(0.7)).toBe(1);
    expect(niceCeil(1500)).toBe(2000);
  });

  it("laisse intacte une borne déjà ronde", () => {
    expect(niceCeil(100)).toBe(100);
    expect(niceCeil(50)).toBe(50);
  });

  it("ne renvoie jamais une échelle nulle ou absurde", () => {
    // Un axe de hauteur 0 ferait une division par zéro à l'échelle.
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(-5)).toBe(1);
    expect(niceCeil(Number.NaN)).toBe(1);
  });
});
