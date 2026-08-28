"use client";

import { useMemo } from "react";
import { useDynamicTranslations } from "@/hooks/useDynamicTranslations";
import type { ActionDto } from "@/lib/api-types";

/**
 * Textes du catalogue d'actions. Le serveur n'envoie que des identifiants :
 * tout le reste est résolu ici, sous `actions.*` dans les dictionnaires.
 *
 * Exception : les commandes du fichier de l'opérateur portent leur propre texte
 * dans `action.text`, déjà résolu pour la locale courante — elles ne peuvent
 * pas alimenter `messages/*.json`. Ce texte prime quand il existe ; sinon le
 * comportement des actions intégrées est inchangé.
 */
export function useActionText() {
  const t = useDynamicTranslations("actions");

  return useMemo(
    () => ({
      /** Le libellé du groupe suit la première action qui en porte un. */
      group: (group: string, label?: string) => {
        if (label) return label;
        const key = `groups.${group}`;
        return t.has(key) ? t(key) : group;
      },

      label: (action: ActionDto) => action.text?.label ?? t(`items.${action.id}.label`),

      /**
       * Lu en brut : un indice est une syntaxe de commande, pas une phrase.
       * ICU y verrait des balises de texte enrichi dans `<joueur>` et refuserait
       * de rendre le message (UNCLOSED_TAG).
       */
      hint: (action: ActionDto) => {
        if (action.text) return action.text.hint ?? "";
        return t.raw(`items.${action.id}.hint`);
      },

      fieldLabel: (action: ActionDto, name: string) => {
        const own = action.fields.find((field) => field.name === name)?.label;
        if (own) return own;
        const key = `fields.${name}.label`;
        return t.has(key) ? t(key) : name;
      },

      /** Un placeholder propre à l'action prime sur celui du champ partagé. */
      placeholder: (action: ActionDto, name: string) => {
        const own = action.fields.find((field) => field.name === name)?.placeholder;
        if (own) return own;

        const specific = `items.${action.id}.placeholders.${name}`;
        if (t.has(specific)) return t(specific);

        const shared = `fields.${name}.placeholder`;
        return t.has(shared) ? t(shared) : "";
      },

      help: (action: ActionDto, name: string) =>
        action.fields.find((field) => field.name === name)?.help,

      /**
       * Le message ICU attend une valeur pour chaque champ déclaré, y compris
       * pendant la saisie : les champs encore vides sont remplacés par leur
       * libellé entre chevrons, comme le faisait l'ancien gabarit maison.
       */
      confirmation: (action: ActionDto, values: Record<string, string>) => {
        if (action.text) return action.text.confirmation ?? action.text.label;

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
