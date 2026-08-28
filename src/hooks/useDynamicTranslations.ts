"use client";

import { useTranslations } from "next-intl";
import type { ErrorParams } from "@/lib/api-types";

/**
 * Translator for dynamically built keys.
 *
 * Some keys are built at runtime (`items.<id>.label` from the catalogue,
 * `errors.<code>` from an API response), and next-intl's literal typing cannot
 * check anything there. It is traded for a `string` signature, and
 * `tests/i18n/messages.test.ts` is what guarantees every expected key really
 * exists in both dictionaries.
 */
export type DynamicTranslator = {
  (key: string, values?: ErrorParams): string;
  has: (key: string) => boolean;
  /** Raw message, bypassing ICU. See `useActionText.hint`. */
  raw: (key: string) => string;
};

export function useDynamicTranslations(namespace: string): DynamicTranslator {
  const t = useTranslations(namespace as Parameters<typeof useTranslations>[0]);
  return t as unknown as DynamicTranslator;
}
