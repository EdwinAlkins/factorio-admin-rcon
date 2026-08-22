import en from "../../messages/en.json";
import type { ErrorParams } from "@/lib/api-types";

/**
 * Repli anglais des messages d'erreur, tiré du même dictionnaire que
 * l'interface : une seule source de vérité, pas de table à maintenir en double.
 *
 * L'interpolation est volontairement naïve (`{clé}`) — c'est un sous-ensemble
 * d'ICU. Les messages de `errors.*` ne doivent donc contenir ni pluriel ni
 * sélecteur, contrairement au reste des dictionnaires.
 */
const ERRORS: Record<string, string> = en.errors;

export function englishError(code: string, params?: ErrorParams): string {
  const template = ERRORS[code] ?? ERRORS.unknown;

  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params?.[key];
    return value === undefined ? match : String(value);
  });
}

/** Vrai si le code possède un message dédié (sinon l'UI affichera `errors.unknown`). */
export function isKnownErrorCode(code: string): boolean {
  return code in ERRORS;
}
