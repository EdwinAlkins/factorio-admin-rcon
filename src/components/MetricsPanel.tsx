"use client";

import { useCallback, useMemo, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import MetricsChart, { type ChartPoint } from "@/components/MetricsChart";
import { niceCeil } from "@/lib/scale";
import { usePolling } from "@/hooks/usePolling";
import { useErrorMessage } from "@/hooks/useErrorMessage";
import { fetchJson } from "@/lib/fetch-json";
import type {
  MetricsHealthState,
  MetricsAggregateDto,
  MetricsBucketDto,
  MetricsRange,
  MetricsResult,
} from "@/lib/api-types";

/**
 * The server's consumption history.
 *
 * The panel stays mounted while the Console tab is active (so the Console's
 * in-progress input is not lost): it is `active` that stops polling, not
 * unmounting.
 */

const RANGES: MetricsRange[] = ["1h", "6h", "24h", "7d"];

/** Factorio's target engine rate. */
const NOMINAL_UPS = 60;
/** Below this the server no longer keeps up: the line turns red. */
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
   * Formatting for a byte count.
   *
   * `scale` pins the unit to a reference value. Without it, every tick picks
   * its own and the axis ends up showing "2.33 GiB" then "0 MiB" — two
   * different scales on the same ruler.
   */
  const bytesOn = (scale: number) => (value: number | null) => {
    if (value === null) return "—";
    return scale >= 1024 ** 3
      ? `${format.number(value / 1024 ** 3, { maximumFractionDigits: 2 })} Gio`
      : `${format.number(value / 1024 ** 2, { maximumFractionDigits: 0 })} Mio`;
  };

  /** For the standalone header figures: the unit adapts to each value. */
  const bytes = (value: number | null) => bytesOn(value ?? 0)(value);

  const plain = (value: number | null, digits = 0) =>
    value === null ? "—" : format.number(value, { maximumFractionDigits: digits });

  const noData = data !== null && data.summary.cycles === 0;

  /**
   * Upper bounds of the y axes.
   *
   * CPU is deliberately not capped at 100%: `docker stats`'s convention counts
   * 100% per core, and a Factorio server on four cores legitimately reaches
   * 400%. The floor at 100 only keeps an idle server from showing a 3% scale.
   */
  const cpuMax = niceCeil(Math.max(100, summary?.cpu.max ?? 0));
  const memMax = niceCeil(summary?.memory.max ?? 0);
  const playersMax = niceCeil(Math.max(1, summary?.players.max ?? 0));
  /**
   * 60 is Factorio's nominal rate, so it is an axis bound in itself: passing it
   * through `niceCeil` would push it to 100 and squash the dips into the lower
   * two thirds of the frame. It is only re-rounded when the server genuinely
   * exceeds the rate.
   */
  const upsPeak = summary?.ups.max ?? 0;
  const upsMax = upsPeak > NOMINAL_UPS ? niceCeil(upsPeak) : NOMINAL_UPS;

  /**
   * State of the Docker source, shown **next to** the charts rather than in
   * their place: a source going down does not invalidate the history already
   * measured, which is precisely what you come to read after an outage.
   */
  const DOCKER_NOTICE: Record<MetricsHealthState, string | null> = {
    disabled: t("dockerDisabled"),
    // "Nothing measured yet" is not an outage: the collector's first round has
    // not happened, and calling it unavailable would be a false positive.
    unknown: t("dockerPending"),
    healthy: null,
    degraded: t("dockerDegraded"),
    failed: t("dockerUnavailable"),
  };

  const dockerNotice = data ? DOCKER_NOTICE[data.health.docker.state] : null;

  /**
   * One block per metric. The list carries the only real differences between
   * them: the unit, the colour, and which end holds the worrying extreme.
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
          // Below 55 UPS the server is no longer keeping up: the line must say
          // so without anyone having to read the scale.
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
  /** `null` when the metric has no reading: no legend to display. */
  stats: string | null;
  /** Source state, shown alongside the chart rather than in its place. */
  notice: string | null;
  /** No reading at all: here the chart has nothing to show. */
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
