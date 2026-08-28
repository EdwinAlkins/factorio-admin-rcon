"use client";

import { useMemo } from "react";
import { useDynamicTranslations } from "@/hooks/useDynamicTranslations";
import type { ActionDto } from "@/lib/api-types";

/**
 * Text for the action catalogue. The server sends identifiers only: everything
 * else is resolved here, under `actions.*` in the dictionaries.
 *
 * Exception: commands from the operator's file carry their own text in
 * `action.text`, already resolved for the current locale — they cannot feed
 * `messages/*.json`. That text wins when present; otherwise built-in actions
 * behave exactly as before.
 */
export function useActionText() {
  const t = useDynamicTranslations("actions");

  return useMemo(
    () => ({
      /** The group label follows the first action that carries one. */
      group: (group: string, label?: string) => {
        if (label) return label;
        const key = `groups.${group}`;
        return t.has(key) ? t(key) : group;
      },

      label: (action: ActionDto) => action.text?.label ?? t(`items.${action.id}.label`),

      /**
       * Read raw: a hint is command syntax, not a sentence. ICU would read
       * `<player>` as a rich-text tag and refuse to render the message
       * (UNCLOSED_TAG).
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

      /** A placeholder specific to the action beats the shared field one. */
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
       * The ICU message expects a value for every declared field, including
       * while typing: fields still empty are replaced by their label between
       * angle brackets, as the previous hand-rolled template did.
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
