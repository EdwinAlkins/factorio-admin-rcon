import { describe, expect, it } from "vitest";
import IntlMessageFormat from "intl-messageformat";
import en from "../../messages/en.json";
import fr from "../../messages/fr.json";
import { ACTIONS } from "@/server/actions/definitions";
import { RCON_ERROR_CODE } from "@/server/rcon/errors";
import { ROLES } from "@/lib/permissions";

/**
 * Les clés construites à l'exécution (`actions.items.<id>.label`,
 * `errors.<code>`) échappent au typage de next-intl : ces tests sont le filet.
 * Ajouter une action sans traduire ses libellés casse la CI, pas la production.
 */

type Json = { [key: string]: string | Json };

function flatten(value: Json, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof child === "string" ? [path] : flatten(child, path);
  });
}

const EN = flatten(en as unknown as Json);
const FR = flatten(fr as unknown as Json);

function valueAt(messages: unknown, key: string): string {
  return key.split(".").reduce<unknown>((node, part) => (node as Json)[part], messages) as string;
}

/**
 * Clés lues via `t.raw()`, donc jamais compilées par ICU. Les indices de
 * commande contiennent `<joueur>`, qu'ICU prendrait pour une balise ouvrante.
 */
const RAW_KEYS = /^actions\.items\.[^.]+\.hint$/;

/**
 * Codes d'erreur émis par les routes et l'enveloppe HTTP. À tenir à jour avec
 * les `ApiFailure` : un code sans traduction retomberait silencieusement sur
 * `errors.unknown`.
 */
const API_ERROR_CODES = [
  "unknown",
  "network",
  "unreadable",
  "http",
  "logout_failed",
  "bad_origin",
  "unauthenticated",
  "forbidden",
  "config",
  "internal",
  "bad_credentials",
  "password_missing",
  "no_account",
  "rate_limited_panel",
  "rate_limited_ip",
  "rate_limited_session",
  "command_missing",
  "action_body_invalid",
  "metrics_disabled",
  "unknown_action",
  "invalid_arguments",
  "validation_required",
  "validation_player",
  "validation_too_long",
  "validation_newline",
];

describe("dictionnaires", () => {
  it("expose exactement les mêmes clés dans chaque langue", () => {
    expect([...FR].sort()).toEqual([...EN].sort());
  });

  it("ne laisse aucune valeur vide", () => {
    for (const [locale, messages] of [
      ["en", en],
      ["fr", fr],
    ] as const) {
      const empty = flatten(messages as unknown as Json).filter(
        (key) => valueAt(messages, key).trim() === "",
      );
      expect(empty, `${locale} : clés vides`).toEqual([]);
    }
  });

  it("compile chaque message avec ICU", () => {
    // Un `<joueur>` ou une accolade non échappée fait échouer le rendu à
    // l'exécution, pas à la compilation : c'est ce test qui l'attrape.
    for (const [locale, messages, keys] of [
      ["en", en, EN],
      ["fr", fr, FR],
    ] as const) {
      for (const key of keys) {
        if (RAW_KEYS.test(key)) continue;
        expect(
          () => new IntlMessageFormat(valueAt(messages, key), locale),
          `${locale} : ${key}`,
        ).not.toThrow();
      }
    }
  });
});

describe("catalogue d'actions", () => {
  it("traduit chaque action dans les deux langues", () => {
    for (const action of ACTIONS) {
      for (const suffix of ["label", "hint"]) {
        const key = `actions.items.${action.id}.${suffix}`;
        expect(EN, `manquant en anglais : ${key}`).toContain(key);
        expect(FR, `manquant en français : ${key}`).toContain(key);
      }
    }
  });

  it("fournit un texte de confirmation exactement aux actions qui en demandent", () => {
    for (const action of ACTIONS) {
      const key = `actions.items.${action.id}.confirmation`;
      expect(EN.includes(key), `${action.id} : confirmation incohérente`).toBe(
        action.confirm === true,
      );
    }
  });

  it("traduit chaque groupe et chaque champ utilisés", () => {
    for (const action of ACTIONS) {
      expect(EN).toContain(`actions.groups.${action.group}`);

      for (const field of action.fields) {
        expect(EN).toContain(`actions.fields.${field.name}.label`);
        expect(EN).toContain(`actions.fields.${field.name}.placeholder`);
      }
    }
  });
});

describe("messages d'erreur", () => {
  it("couvre chaque clé d'erreur RCON", () => {
    for (const key of Object.keys(RCON_ERROR_CODE)) {
      expect(EN, `manquant : errors.${key}`).toContain(`errors.${key}`);
    }
  });

  it("couvre chaque code renvoyé par l'API", () => {
    for (const code of API_ERROR_CODES) {
      expect(EN, `manquant : errors.${code}`).toContain(`errors.${code}`);
    }
  });

  it("n'utilise ni pluriel ni sélecteur ICU", () => {
    // `englishError()` interpole avec une simple regex `{clé}` : une syntaxe
    // ICU plus riche serait rendue littéralement dans le repli anglais.
    for (const [locale, messages] of [
      ["en", en],
      ["fr", fr],
    ] as const) {
      for (const [code, message] of Object.entries(messages.errors)) {
        expect(message, `${locale} : errors.${code}`).not.toMatch(/\{\s*\w+\s*,/);
      }
    }
  });
});

describe("rôles", () => {
  it("traduit chaque rôle", () => {
    for (const role of ROLES) {
      expect(EN).toContain(`roles.${role}`);
    }
  });
});
