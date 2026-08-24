import { env } from "@/server/config/env";
import { getDb } from "@/server/db";
import { errorFields, logger } from "@/server/log";
import type {
  MetricsAggregateDto,
  MetricsBucketDto,
  MetricsSummaryDto,
} from "@/lib/api-types";

/**
 * Séries temporelles de consommation : un échantillon toutes les
 * `METRICS_INTERVAL_MS`, purgé au-delà de `METRICS_RETENTION_DAYS`.
 *
 * Toutes les colonnes sont nullables à dessein : un échantillon partiel (Docker
 * joignable mais RCON muet, ou l'inverse) vaut mieux qu'un trou dans la série.
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

/** Nombre de points renvoyés au client : au-delà, le graphe ne gagne rien. */
const BUCKETS = 120;

/**
 * Écritures perdues depuis le démarrage.
 *
 * `recordSample` avale ses erreurs pour ne pas tuer le collecteur, mais sans ce
 * compteur une base cassée ferait disparaître les métriques en silence pendant
 * des heures, sans autre trace que des lignes de log.
 */
const globalRef = globalThis as typeof globalThis & { __factorioMetricsWriteFailures?: number };

export function storageFailures(): number {
  return globalRef.__factorioMetricsWriteFailures ?? 0;
}

/** N'échoue jamais : perdre un échantillon ne doit pas arrêter le collecteur. */
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

/** `COUNT(colonne)` ignore les NULL : c'est le nombre de mesures réelles. */
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
 * Agrégation faite en SQL plutôt qu'en mémoire : sur 7 jours la table contient
 * des dizaines de milliers de lignes qu'il serait absurde de transporter
 * jusqu'au navigateur.
 *
 * Chaque bucket porte `min`, `max`, `avg` **et le nombre de mesures**. Les
 * trois premiers décrivent la distribution ; le dernier dit à quel point on
 * peut s'y fier — un bucket d'une heure bâti sur un seul relevé produit une
 * courbe d'aspect identique à un bucket complet, et rien ne le signalerait.
 *
 * Les bornes sont neutres (`min`/`max`) et non orientées : c'est la couche de
 * présentation qui sait que le CPU s'inquiète du maximum et l'UPS du minimum.
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

  // Nombre de relevés qu'un bucket entièrement couvert devrait contenir.
  const expected = Math.max(1, Math.round(bucketMs / env().METRICS_INTERVAL_MS));

  return rows.map((row) => ({
    // Début réel de la tranche, pas le premier échantillon qu'elle contient :
    // sur des données clairsemées, `MIN(ts)` déplacerait le point vers la
    // droite et laisserait croire que la mesure est plus récente qu'elle ne l'est.
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
 * Dernière valeur connue de chaque colonne, cherchée **indépendamment**.
 *
 * Prendre la dernière ligne en bloc ne marche pas : un échantillon partiel
 * (proxy Docker coupé, RCON muet) suffirait à afficher « — » partout alors que
 * la série contient des heures de mesures. Chaque métrique remonte donc à son
 * propre dernier relevé exploitable.
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

/** Chiffres d'en-tête : ils restent lisibles même sans regarder les courbes. */
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
    // Nombre de tours du collecteur, à ne pas confondre avec le nombre de
    // mesures : un tour où Docker et RCON sont muets écrit quand même sa ligne.
    // Chaque métrique porte donc son propre compteur.
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
    // Dernière limite connue, pas le maximum de la fenêtre : un conteneur
    // recréé avec une limite plus basse afficherait sinon l'ancienne, qui est
    // historiquement exacte mais actuellement fausse.
    memLimit: latestOf("mem_limit", from),
  };
}

export function purgeMetrics(now = Date.now()): number {
  const cutoff = now - env().METRICS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const result = getDb().prepare(`DELETE FROM metrics WHERE ts < ?`).run(cutoff);
  return Number(result.changes ?? 0);
}
