"use client";

import { useTranslations } from "next-intl";
import type { ErrorParams } from "@/lib/api-types";

/**
 * Traducteur à clé dynamique.
 *
 * Certaines clés sont construites à l'exécution (`items.<id>.label` à partir du
 * catalogue, `errors.<code>` à partir d'une réponse API) : le typage littéral
 * de next-intl ne peut rien vérifier dans ce cas. On l'échange donc contre une
 * signature `string`, et c'est `tests/i18n/messages.test.ts` qui garantit que
 * chaque clé attendue existe bien dans les deux dictionnaires.
 */
export type DynamicTranslator = {
  (key: string, values?: ErrorParams): string;
  has: (key: string) => boolean;
  /** Message brut, sans passage par ICU. Cf. `useActionText.hint`. */
  raw: (key: string) => string;
};

export function useDynamicTranslations(namespace: string): DynamicTranslator {
  const t = useTranslations(namespace as Parameters<typeof useTranslations>[0]);
  return t as unknown as DynamicTranslator;
}
