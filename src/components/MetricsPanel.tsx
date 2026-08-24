"use client";

import { useCallback, useMemo, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import MetricsChart, { type ChartPoint } from "@/components/MetricsChart";
import { niceCeil } from "@/lib/scale";
import { usePolling } from "@/hooks/usePolling";
import { useErrorMessage } from "@/hooks/useErrorMessage";
import { fetchJson } from "@/lib/fetch-json";
import type {
  MetricsAggregateDto,
  MetricsBucketDto,
  MetricsRange,
  MetricsResult,
} from "@/lib/api-types";

/**
 * Historique de consommation du serveur.
 *
 * Le panneau reste monté quand l'onglet Console est actif (pour ne pas perdre
 * la saisie en cours côté Console) : c'est `active` qui coupe le sondage, pas
 * le démontage.
 */

const RANGES: MetricsRange[] = ["1h", "6h", "24h", "7d"];

/** Cadence cible du moteur Factorio. */
const NOMINAL_UPS = 60;
/** En dessous, le serveur ne tient plus la cadence : la courbe passe au rouge. */
const DEGRADED_UPS = 55;
const REFRESH_MS = 30_000;

type Props = {
  active: boolean;
  onUnauthorized: () => void;
  className?: string;
};

type Load =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; data: MetricsResult };

export default function MetricsPanel({ active, onUnauthorized, className }: Props) {
  const t = useTranslations("metrics");
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const [range, setRange] = useState<MetricsRange>("6h");
  const [state, setState] = useState<Load>({ kind: "loading" });

  const tick = useCallback(() => {
    void fetchJson<MetricsResult>(`/api/metrics?range=${range}`).then((outcome) => {
      if (outcome.kind === "unauthorized") return onUnauthorized();
      if (outcome.kind === "error") return setState({ kind: "error", message: errorMessage(outcome) });
      setState({ kind: "ok", data: outcome.data });
    });
  }, [errorMessage, onUnauthorized, range]);

  usePolling(tick, { enabled: active, intervalMs: REFRESH_MS });

  const data = state.kind === "ok" ? state.data : null;
  const summary = data?.summary;

  const series = useMemo(() => {
    const buckets = data?.buckets ?? [];
    const pick = (metric: (b: MetricsBucketDto) => MetricsAggregateDto): ChartPoint[] =>
      buckets.map((bucket) => {
        const { samples, avg, min, max } = metric(bucket);
        return {
          ts: bucket.ts,
          value: avg,
          min,
          max,
          coverage: samples / bucket.expectedSamples,
        };
      });

    return {
      cpu: pick((b) => b.cpu),
      memory: pick((b) => b.memory),
      players: pick((b) => b.players),
      ups: pick((b) => b.ups),
    };
  }, [data]);

  const percent = (value: number | null) =>
    value === null ? "—" : `${format.number(value, { maximumFractionDigits: 1 })} %`;

  /**
   * Mise en forme d'un nombre d'octets.
   *
   * `scale` fige l'unité sur une valeur de référence. Sans lui, chaque
   * graduation choisit la sienne et l'axe finit par afficher « 2,33 Gio » puis
   * « 0 Mio » — deux échelles différentes sur la même règle.
   */
  const bytesOn = (scale: number) => (value: number | null) => {
    if (value === null) return "—";
    return scale >= 1024 ** 3
      ? `${format.number(value / 1024 ** 3, { maximumFractionDigits: 2 })} Gio`
      : `${format.number(value / 1024 ** 2, { maximumFractionDigits: 0 })} Mio`;
  };

  /** Pour les chiffres d'en-tête, isolés : l'unité s'adapte à chaque valeur. */
  const bytes = (value: number | null) => bytesOn(value ?? 0)(value);

  const plain = (value: number | null, digits = 0) =>
    value === null ? "—" : format.number(value, { maximumFractionDigits: digits });

  const noData = data !== null && data.summary.cycles === 0;

  /**
   * Bornes hautes des ordonnées.
   *
   * Le CPU n'est volontairement pas plafonné à 100 % : la convention de
   * `docker stats` compte 100 % par cœur, et un serveur Factorio sur quatre
   * cœurs monte légitimement à 400 %. Le plancher à 100 évite seulement qu'un
   * serveur au repos affiche une échelle de 3 %.
   */
  const cpuMax = niceCeil(Math.max(100, summary?.cpu.max ?? 0));
  const memMax = niceCeil(summary?.memory.max ?? 0);
  const playersMax = niceCeil(Math.max(1, summary?.players.max ?? 0));
  /**
   * 60 est la cadence nominale de Factorio, donc une borne d'axe en soi : la
   * passer par `niceCeil` la ferait remonter à 100 et écraserait les creux dans
   * les deux tiers inférieurs du cadre. On ne réarrondit que si le serveur
   * dépasse réellement la cadence.
   */
  const upsPeak = summary?.ups.max ?? 0;
  const upsMax = upsPeak > NOMINAL_UPS ? niceCeil(upsPeak) : NOMINAL_UPS;

  /**
   * État de la source Docker, affiché **à côté** des courbes et non à leur
   * place : une source tombée n'invalide pas l'historique déjà mesuré, qui
   * reste précisément ce qu'on vient consulter après une panne.
   */
  const dockerNotice = !data
    ? null
    : !data.health.docker.enabled
      ? t("dockerDisabled")
      : !data.health.docker.healthy
        ? t("dockerUnavailable")
        : null;

  /**
   * Un bloc par métrique. La liste porte les seules différences réelles entre
   * eux : l'unité, la couleur, et de quel côté se trouve l'extrême qui inquiète.
   */
  const blocks = summary
    ? ([
        {
          key: "cpu" as const,
          headline: percent(summary.cpu.current),
          stats: summary.cpu,
          points: series.cpu,
          color: "var(--color-accent)",
          yMax: cpuMax,
          extreme: "max" as const,
          format: percent,
          legend: `${t("average")} ${percent(summary.cpu.avg)} · ${t("peak")} ${percent(summary.cpu.max)}`,
          notice: dockerNotice,
        },
        {
          key: "memory" as const,
          headline: summary.memLimit
            ? t("memoryOf", {
                used: bytes(summary.memory.current),
                limit: bytes(summary.memLimit),
              })
            : bytes(summary.memory.current),
          stats: summary.memory,
          points: series.memory,
          color: "var(--color-ok)",
          yMax: memMax,
          extreme: "max" as const,
          format: bytesOn(memMax),
          legend: `${t("average")} ${bytes(summary.memory.avg)} · ${t("peak")} ${bytes(summary.memory.max)}`,
          notice: dockerNotice,
        },
        {
          key: "players" as const,
          headline: plain(summary.players.current),
          stats: summary.players,
          points: series.players,
          color: "var(--color-muted)",
          yMax: playersMax,
          extreme: "max" as const,
          format: (value: number | null) => plain(value),
          legend: `${t("average")} ${plain(summary.players.avg, 1)} · ${t("peak")} ${plain(summary.players.max)}`,
          notice: null,
        },
        {
          key: "ups" as const,
          headline: plain(summary.ups.current, 1),
          stats: summary.ups,
          points: series.ups,
          // Sous 55 UPS le serveur ne tient plus la cadence : la courbe doit le
          // dire sans qu'on ait à lire l'échelle.
          color:
            (summary.ups.min ?? NOMINAL_UPS) < DEGRADED_UPS
              ? "var(--color-danger)"
              : "var(--color-ok)",
          yMax: upsMax,
          extreme: "min" as const,
          format: (value: number | null) => plain(value, 1),
          legend: `${t("average")} ${plain(summary.ups.avg, 1)} · ${t("low")} ${plain(summary.ups.min, 1)}`,
          notice: summary.ups.samples === 0 ? t("upsUnavailable") : null,
        },
      ])
    : [];

  return (
    <section className={`flex min-h-0 flex-col rounded-lg border border-line bg-surface ${className ?? ""}`}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
        <h2 className="text-sm font-medium">{t("title")}</h2>
        <div className="flex gap-1" role="group" aria-label={t("rangeLabel")}>
          {RANGES.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={range === key}
              className={`btn px-2 py-1 text-xs ${range === key ? "border-accent text-accent" : ""}`}
              onClick={() => setRange(key)}
            >
              {t(`ranges.${key}`)}
            </button>
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {state.kind === "error" && (
          <p role="alert" className="text-xs text-danger">
            {state.message}
          </p>
        )}

        {state.kind === "loading" && <p className="text-xs text-muted">{t("loading")}</p>}

        {noData && <p className="text-xs text-muted">{t("empty")}</p>}

        {data && summary && !noData && (
          <div className="flex flex-col gap-5">
            {blocks.map((block) => (
              <Block
                key={block.key}
                title={t(block.key)}
                current={block.headline}
                stats={block.stats.samples === 0 ? null : block.legend}
                notice={block.notice}
                empty={block.stats.samples === 0}
              >
                <MetricsChart
                  points={block.points}
                  color={block.color}
                  from={data.from}
                  to={data.to}
                  yMax={block.yMax}
                  formatValue={block.format}
                  averageLabel={t("average")}
                  extremeLabel={t(block.extreme === "max" ? "peak" : "low")}
                  extremeOf={([min, max]) => (block.extreme === "max" ? max : min)}
                  sparseLabel={t("sparse")}
                  label={t("chartLabel", { metric: t(block.key), current: block.headline })}
                />
              </Block>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Block({
  title,
  current,
  stats,
  notice,
  empty,
  children,
}: {
  title: string;
  current: string;
  /** `null` quand la métrique n'a aucune mesure : pas de légende à afficher. */
  stats: string | null;
  /** État de la source, affiché en plus du graphe et non à sa place. */
  notice: string | null;
  /** Aucune mesure du tout : là, le graphe n'a rien à montrer. */
  empty: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2 pb-1">
        <h3 className="text-xs font-medium">
          {title} <span className="font-mono text-sm text-ink">{current}</span>
        </h3>
        {stats && <p className="font-mono text-xs text-muted">{stats}</p>}
      </div>
      {notice && <p className="pb-1 text-xs text-accent">{notice}</p>}
      {empty ? <p className="py-6 text-xs text-muted">{"—"}</p> : children}
    </div>
  );
}
