import { describe, expect, it } from "vitest";
import IntlMessageFormat from "intl-messageformat";
import en from "../../messages/en.json";
import fr from "../../messages/fr.json";
import { ACTIONS } from "@/server/actions/definitions";
import { RCON_ERROR_CODE } from "@/server/rcon/errors";
import { ROLES } from "@/lib/permissions";

/**
 * Keys built at runtime (`actions.items.<id>.label`, `errors.<code>`) escape
 * next-intl's typing: these tests are the net. Adding an action without
 * translating its labels breaks CI, not production.
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
 * Keys read through `t.raw()`, therefore never compiled by ICU. Command hints
 * contain `<player>`, which ICU would take for an opening tag.
 */
const RAW_KEYS = /^actions\.items\.[^.]+\.hint$/;

/**
 * Error codes emitted by the routes and the HTTP wrapper. To be kept in sync
 * with the `ApiFailure`s: a code with no translation would silently fall back
 * to `errors.unknown`.
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
  "body_too_large",
  "metrics_disabled",
  "unknown_action",
  "invalid_arguments",
  "validation_required",
  "validation_player",
  "validation_too_long",
  "validation_newline",
  "validation_number",
  "validation_min",
  "validation_max",
  "validation_enum",
  "validation_identifier",
  "validation_bool",
  "validation_control_char",
  "validation_comment",
  "unknown_placeholder",
];

describe("dictionaries", () => {
  it("exposes exactly the same keys in every language", () => {
    expect([...FR].sort()).toEqual([...EN].sort());
  });

  it("leaves no empty value", () => {
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

  it("compiles every message with ICU", () => {
    // A `<player>` or an unescaped brace fails at render time, not at compile
    // time: this test is what catches it.
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

describe("action catalogue", () => {
  it("translates every action in both languages", () => {
    for (const action of ACTIONS) {
      for (const suffix of ["label", "hint"]) {
        const key = `actions.items.${action.id}.${suffix}`;
        expect(EN, `manquant en anglais : ${key}`).toContain(key);
        expect(FR, `manquant en français : ${key}`).toContain(key);
      }
    }
  });

  it("provides confirmation text to exactly the actions that ask for it", () => {
    for (const action of ACTIONS) {
      const key = `actions.items.${action.id}.confirmation`;
      expect(EN.includes(key), `${action.id} : confirmation incohérente`).toBe(
        action.confirm === true,
      );
    }
  });

  it("translates every group and field in use", () => {
    for (const action of ACTIONS) {
      expect(EN).toContain(`actions.groups.${action.group}`);

      for (const field of action.fields) {
        expect(EN).toContain(`actions.fields.${field.name}.label`);
        expect(EN).toContain(`actions.fields.${field.name}.placeholder`);
      }
    }
  });
});

describe("error messages", () => {
  it("covers every RCON error key", () => {
    for (const key of Object.keys(RCON_ERROR_CODE)) {
      expect(EN, `manquant : errors.${key}`).toContain(`errors.${key}`);
    }
  });

  it("covers every code the API returns", () => {
    for (const code of API_ERROR_CODES) {
      expect(EN, `manquant : errors.${code}`).toContain(`errors.${code}`);
    }
  });

  it("uses neither ICU plurals nor selectors", () => {
    // `englishError()` interpolates with a plain `{key}` regex: richer ICU
    // syntax would be rendered literally in the English fallback.
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

describe("roles", () => {
  it("translates every role", () => {
    for (const role of ROLES) {
      expect(EN).toContain(`roles.${role}`);
    }
  });
});
