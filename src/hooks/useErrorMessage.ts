"use client";

import { useCallback } from "react";
import { useDynamicTranslations } from "@/hooks/useDynamicTranslations";
import type { FetchFailure } from "@/lib/fetch-json";

/**
 * Traduit un échec d'appel API.
 *
 * Repli en cascade : la clé `errors.<code>` si elle existe, sinon le message
 * anglais renvoyé par le serveur — utile si une version du serveur introduit un
 * code que ce client ne connaît pas encore — sinon un message générique.
 */
export function useErrorMessage() {
  const t = useDynamicTranslations("errors");
  const actions = useDynamicTranslations("actions");

  return useCallback(
    (failure: FetchFailure): string => {
      if (!t.has(failure.code)) return failure.fallback ?? t("unknown");

      // Les erreurs de validation désignent le champ par son nom technique
      // (`player`) : on lui substitue son libellé traduit avant l'interpolation.
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
