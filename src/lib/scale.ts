/**
 * Axis bound rounding, shared by the metric charts.
 *
 * Without it an axis snaps to the raw maximum and shows "202.4%" or "23 MiB":
 * exact ticks, but ones the eye cannot place.
 */

const STEPS = [1, 2, 2.5, 5, 10];

/** The next "readable" step above `value` (1, 2, 2.5 or 5 × 10ⁿ). */
export function niceCeil(value: number): number {
  // A zero or negative scale would divide by zero when plotting.
  if (!Number.isFinite(value) || value <= 0) return 1;

  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = STEPS.find((candidate) => value <= candidate * magnitude) ?? 10;

  return step * magnitude;
}
