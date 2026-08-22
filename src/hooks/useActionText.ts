"use client";

import { useMemo } from "react";
import { useDynamicTranslations } from "@/hooks/useDynamicTranslations";
import type { ActionDto, ActionGroup } from "@/lib/api-types";

/**
 * Textes du catalogue d'actions. Le serveur n'envoie que des identifiants :
 * tout le reste est résolu ici, sous `actions.*` dans les dictionnaires.
 */
export function useActionText() {
  const t = useDynamicTranslations("actions");

  return useMemo(
    () => ({
      group: (group: ActionGroup) => t(`groups.${group}`),
      label: (action: ActionDto) => t(`items.${action.id}.label`),

      /**
       * Lu en brut : un indice est une syntaxe de commande, pas une phrase.
       * ICU y verrait des balises de texte enrichi dans `<joueur>` et refuserait
       * de rendre le message (UNCLOSED_TAG).
       */
      hint: (action: ActionDto) => t.raw(`items.${action.id}.hint`),
      fieldLabel: (name: string) => t(`fields.${name}.label`),

      /** Un placeholder propre à l'action prime sur celui du champ partagé. */
      placeholder: (action: ActionDto, name: string) => {
        const own = `items.${action.id}.placeholders.${name}`;
        return t.has(own) ? t(own) : t(`fields.${name}.placeholder`);
      },

      /**
       * Le message ICU attend une valeur pour chaque champ déclaré, y compris
       * pendant la saisie : les champs encore vides sont remplacés par leur
       * libellé entre chevrons, comme le faisait l'ancien gabarit maison.
       */
      confirmation: (action: ActionDto, values: Record<string, string>) => {
        const filled = Object.fromEntries(
          action.fields.map((field) => [
            field.name,
            values[field.name]?.trim() || `<${t(`fields.${field.name}.label`)}>`,
          ]),
        );
        return t(`items.${action.id}.confirmation`, filled);
      },
    }),
    [t],
  );
}
