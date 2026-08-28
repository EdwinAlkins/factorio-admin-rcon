"use client";

import { useCallback } from "react";
import { useDynamicTranslations } from "@/hooks/useDynamicTranslations";
import type { FetchFailure } from "@/lib/fetch-json";

/**
 * Translates an API call failure.
 *
 * Cascading fallback: the `errors.<code>` key when it exists, otherwise the
 * English message the server returned — useful when a server version
 * introduces a code this client does not know yet — otherwise a generic
 * message.
 */
export function useErrorMessage() {
  const t = useDynamicTranslations("errors");
  const actions = useDynamicTranslations("actions");

  return useCallback(
    (failure: FetchFailure): string => {
      if (!t.has(failure.code)) return failure.fallback ?? t("unknown");

      // Validation errors name the field by its technical name (`player`):
      // substitute its translated label before interpolating.
      const params = { ...failure.params };
      const labelKey = `fields.${params.field}.label`;
      if (typeof params.field === "string" && actions.has(labelKey)) {
        params.field = actions(labelKey);
      }

      return t(failure.code, params);
    },
    [actions, t],
  );
}
