/**
 * Arrondi des bornes d'axe, partagé par les graphes de métriques.
 *
 * Sans lui, un axe se cale sur le maximum brut et affiche « 202,4 % » ou
 * « 23 Mio » : des graduations exactes, mais que l'œil ne sait pas situer.
 */

const STEPS = [1, 2, 2.5, 5, 10];

/** Palier « lisible » immédiatement supérieur à `value` (1, 2, 2,5 ou 5 × 10ⁿ). */
export function niceCeil(value: number): number {
  // Une échelle nulle ou négative produirait une division par zéro au tracé.
  if (!Number.isFinite(value) || value <= 0) return 1;

  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = STEPS.find((candidate) => value <= candidate * magnitude) ?? 10;

  return step * magnitude;
}
