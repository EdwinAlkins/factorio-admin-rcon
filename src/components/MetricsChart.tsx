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
 * Graphe temporel d'une métrique.
 *
 * Deux couches superposées : une bande allant du minimum au maximum observés
 * dans le bucket, puis la courbe de la moyenne. C'est la bande qui rend les
 * pics visibles — l'agrégation les lisserait sinon précisément quand on les
 * cherche.
 *
 * La bande part du **minimum**, pas de la moyenne : une tranche à
 * `10 10 10 10 95 10 10` remplie de la moyenne (≈22) jusqu'au pic donnerait à
 * voir une charge constamment située entre 22 et 95, ce que les données ne
 * disent pas. Du min au max, la zone décrit l'amplitude réellement observée.
 *
 * `connectNulls` reste à sa valeur par défaut (`false`) : un trou de collecte
 * doit apparaître comme un trou, pas comme une droite reliant deux instants
 * sans rapport.
 */

export type ChartPoint = {
  ts: number;
  /** Moyenne du bucket : la courbe. */
  value: number | null;
  /** Bornes observées : la bande. */
  min: number | null;
  max: number | null;
  /** Mesures réelles rapportées à celles attendues, dans [0, 1]. */
  coverage: number;
};

type Props = {
  points: ChartPoint[];
  /** Couleur CSS ; les appelants passent un token de `globals.css`. */
  color: string;
  /** Fenêtre demandée, pas l'étendue des données : voir `MetricsResult.from`. */
  from: number;
  to: number;
  /** Borne haute de l'axe des ordonnées, arrondie par l'appelant. */
  yMax: number;
  /** Résumé chiffré lu par les lecteurs d'écran, le SVG leur étant opaque. */
  label: string;
  averageLabel: string;
  extremeLabel: string;
  /**
   * Borne intéressante de la bande : le maximum pour le CPU, le minimum pour
   * l'UPS. Le modèle reste neutre, seule la présentation choisit son côté.
   */
  extremeOf: (band: [number, number]) => number;
  /** Affiché quand un bucket repose sur trop peu de mesures. */
  sparseLabel: string;
  /** Mise en forme partagée avec l'en-tête chiffré du bloc. */
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
 * Couverture en dessous de laquelle la bande est masquée.
 *
 * Un bucket d'une heure bâti sur deux relevés a un min et un max parfaitement
 * exacts, mais qui ne décrivent pas la période : afficher la zone reviendrait à
 * transformer une absence de mesure en information. La moyenne, elle, reste
 * tracée — c'est bien la valeur observée.
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

  // Au-delà d'une journée affichée, l'heure seule devient ambiguë.
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
            // La fenêtre demandée, pas l'étendue des données : dix minutes de
            // relevés sur une plage de 7 j doivent occuper un dixième de la
            // largeur, pas la totalité.
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
  // Recharts injecte `active`/`payload` à l'exécution : les rendre optionnels
  // est ce qui permet d'écrire l'élément avec nos seules props à nous.
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

  // L'extrême n'est affiché que lorsqu'il se distingue de la moyenne : sur un
  // bucket à un seul échantillon, le répéter n'apprendrait rien.
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
