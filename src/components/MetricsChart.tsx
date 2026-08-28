"use client";

import { useFormatter } from "next-intl";
import {
  Area,
  ComposedChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";

/**
 * Time chart for one metric.
 *
 * Two stacked layers: a band from the minimum to the maximum observed in the
 * bucket, then the average as a line. It is the band that makes spikes visible
 * — aggregation would otherwise smooth them away exactly when you are looking
 * for them.
 *
 * The band starts at the **minimum**, not the average: a slice of
 * `10 10 10 10 95 10 10` filled from the average (≈22) up to the spike would
 * suggest a load constantly between 22 and 95, which the data does not say.
 * From min to max, the area describes the amplitude actually observed.
 *
 * `connectNulls` keeps its default (`false`): a collection gap must look like a
 * gap, not like a straight line joining two unrelated moments.
 */

export type ChartPoint = {
  ts: number;
  /** The bucket's average: the line. */
  value: number | null;
  /** Observed bounds: the band. */
  min: number | null;
  max: number | null;
  /** Real readings over expected readings, in [0, 1]. */
  coverage: number;
};

type Props = {
  points: ChartPoint[];
  /** CSS colour; callers pass a token from `globals.css`. */
  color: string;
  /** The requested window, not the data's extent: see `MetricsResult.from`. */
  from: number;
  to: number;
  /** Upper bound of the y axis, rounded by the caller. */
  yMax: number;
  /** Numeric summary for screen readers, to which the SVG is opaque. */
  label: string;
  averageLabel: string;
  extremeLabel: string;
  /**
   * The interesting end of the band: the maximum for CPU, the minimum for UPS.
   * The model stays neutral; only the presentation picks a side.
   */
  extremeOf: (band: [number, number]) => number;
  /** Shown when a bucket rests on too few readings. */
  sparseLabel: string;
  /** Formatting shared with the block's numeric header. */
  formatValue: (value: number) => string;
};

const HEIGHT = 110;

type Row = {
  ts: number;
  value: number | null;
  band: [number, number] | null;
  coverage: number;
};

/**
 * Coverage below which the band is hidden.
 *
 * An hour-long bucket built from two readings has a perfectly exact min and
 * max, but they do not describe the period: drawing the area would turn an
 * absence of measurement into information. The average is still plotted — that
 * one really is the observed value.
 */
const MIN_BAND_COVERAGE = 0.5;

function toRows(points: ChartPoint[]): Row[] {
  return points.map(({ ts, value, min, max, coverage }) => ({
    ts,
    value,
    band:
      min !== null && max !== null && coverage >= MIN_BAND_COVERAGE ? [min, max] : null,
    coverage,
  }));
}

export default function MetricsChart({
  points,
  color,
  from,
  to,
  yMax,
  label,
  averageLabel,
  extremeLabel,
  extremeOf,
  sparseLabel,
  formatValue,
}: Props) {
  const format = useFormatter();
  const rows = toRows(points);

  // Past a day on screen, the time alone becomes ambiguous.
  const withDate = to - from > 24 * 60 * 60 * 1000;

  const formatTime = (ts: number) =>
    format.dateTime(
      new Date(ts),
      withDate
        ? { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }
        : { hour: "2-digit", minute: "2-digit" },
    );

  return (
    <div role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height={HEIGHT}>
        {/* `top` laisse la place à l'étiquette de la graduation haute, qui est
            centrée sur sa ligne et déborderait sinon hors du cadre. */}
        <ComposedChart data={rows} margin={{ top: 10, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--color-line)" strokeDasharray="3 3" vertical={false} />

          <XAxis
            dataKey="ts"
            type="number"
            scale="time"
            // The requested window, not the data's extent: ten minutes of
            // readings over a 7-day range must take a tenth of the width, not
            // all of it.
            domain={[from, to]}
            tickFormatter={formatTime}
            stroke="var(--color-muted)"
            tick={{ fontSize: 10 }}
            tickLine={false}
            minTickGap={48}
          />

          <YAxis
            domain={[0, yMax]}
            tickFormatter={formatValue}
            stroke="var(--color-muted)"
            tick={{ fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            width={56}
          />

          <Tooltip
            content={
              <MetricTooltip
                formatTime={formatTime}
                formatValue={formatValue}
                averageLabel={averageLabel}
                extremeLabel={extremeLabel}
                extremeOf={extremeOf}
                sparseLabel={sparseLabel}
              />
            }
            cursor={{ stroke: "var(--color-muted)", strokeDasharray: "3 3" }}
          />

          <Area
            dataKey="band"
            fill={color}
            fillOpacity={0.18}
            stroke="none"
            isAnimationActive={false}
          />
          <Area
            dataKey="value"
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            dot={false}
            activeDot={{ r: 3, stroke: "none", fill: color }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function MetricTooltip({
  active,
  payload,
  formatTime,
  formatValue,
  averageLabel,
  extremeLabel,
  extremeOf,
  sparseLabel,
  // Recharts injects `active`/`payload` at runtime: making them optional is
  // what lets us write the element with only our own props.
}: Partial<TooltipContentProps<number, string>> & {
  formatTime: (ts: number) => string;
  formatValue: (value: number) => string;
  averageLabel: string;
  extremeLabel: string;
  extremeOf: (band: [number, number]) => number;
  sparseLabel: string;
}) {
  const row = active ? (payload?.[0]?.payload as Row | undefined) : undefined;
  if (!row || row.value === null) return null;

  // The extreme is only shown when it differs from the average: on a
  // single-sample bucket, repeating it would teach nothing.
  const extreme = row.band && row.band[1] !== row.band[0] ? extremeOf(row.band) : null;

  return (
    <div className="rounded border border-line bg-raised px-2 py-1 font-mono text-xs shadow-lg">
      <p className="text-muted">{formatTime(row.ts)}</p>
      <p>
        {averageLabel} {formatValue(row.value)}
      </p>
      {extreme !== null && (
        <p className="text-muted">
          {extremeLabel} {formatValue(extreme)}
        </p>
      )}
      {row.coverage < MIN_BAND_COVERAGE && (
        <p className="text-accent">{sparseLabel}</p>
      )}
    </div>
  );
}
