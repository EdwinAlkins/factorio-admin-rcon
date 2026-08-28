import { z } from "zod";
import type { Permission } from "@/lib/permissions";
import { hasControlChar, type LuaKind } from "@/lib/lua-template";
import type { ActionDto, ActionFieldDto } from "@/lib/api-types";

/**
 * Catalogue of business actions, defined **server-side**.
 *
 * The interface sends `{ action: "ban", values: { player, reason } }`: it is the
 * server that validates, enforces the permission and builds the RCON command.
 * The client therefore cannot craft an arbitrary command through this path.
 *
 * No interface text here: labels, hints and confirmations are
 * `actions.items.<id>.*` keys in `messages/*.json`, resolved on the client.
 * `tests/i18n/messages.test.ts` checks that no action is missing a key.
 */

export type ActionFieldKind = LuaKind;

/**
 * Text carried by the definition itself, per locale (`{ en, fr }`).
 *
 * Built-in actions have none: their labels live in the dictionaries. Only
 * actions from the operator's file carry text — a catalogue written outside the
 * repository cannot feed `messages/*.json`.
 */
export type LocalizedText = Record<string, string>;

export type ActionField = {
  name: string;
  kind: ActionFieldKind;
  required: boolean;
  maxLength?: number;
  /** `int`/`float` uniquement. */
  min?: number;
  max?: number;
  /** `enum` only: the closed list of accepted values. */
  options?: string[];
  /** `enum` only: insert the bare value rather than a string literal. */
  raw?: boolean;
  /** Value used when the field is left empty. */
  default?: string;
  label?: LocalizedText;
  placeholder?: LocalizedText;
  help?: LocalizedText;
};

export type ActionDefinition = {
  id: string;
  /** A closed union for built-in actions, free-form for those from the file. */
  group: string;
  permission: Permission;
  risk: "none" | "dangerous";
  /** A confirmation is asked for; its text lives in the dictionaries. */
  confirm?: boolean;
  fields: ActionField[];
  build: (values: Record<string, string>) => string;
  /** Actions from the operator's file: text and template carried here. */
  text?: {
    label: LocalizedText;
    hint?: LocalizedText;
    confirmation?: LocalizedText;
    group?: LocalizedText;
  };
  /** Source template, sent to the interface for the pre-confirmation preview. */
  template?: string;
  preview?: boolean;
};

// A Factorio player name contains no space; quotes and backslashes are refused
// upstream of any escaping (see `lua-template`).
const PLAYER_PATTERN = /^[^\s\r\n"'\\]{1,60}$/;
const NO_NEWLINE = /^[^\r\n]*$/;
// Noms de prototypes Factorio : `iron-plate`, `steel-processing`, `crude-oil`.
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_.-]{1,80}$/;

export const DEFAULT_MAX_LENGTH = 200;

/**
 * zod messages are not sentences but translation keys: it is `executeAction`
 * that turns them into `{ code, params }` for the client.
 */
function base(field: ActionField): z.ZodString {
  return field.required ? z.string().min(1, "validation_required") : z.string();
}

/** An optional field left empty is not a formatting error. */
function matches(field: ActionField, regex: RegExp) {
  return (value: string) => (value === "" && !field.required) || regex.test(value);
}

function textual(field: ActionField, regex: RegExp, code: string): z.ZodType<string, string> {
  return base(field)
    .max(field.maxLength ?? DEFAULT_MAX_LENGTH, "validation_too_long")
    .refine(matches(field, regex), code)
    .refine((value) => !hasControlChar(value), "validation_control_char");
}

/**
 * Values travel as strings (`values: Record<string, string>`): the number is
 * validated and then rendered in canonical form, so the template never has to
 * reinterpret the input.
 */
function numeric(field: ActionField): z.ZodType<string, string> {
  return z
    .string()
    .superRefine((value, ctx) => {
      if (value === "") {
        ctx.addIssue({ code: "custom", message: "validation_required" });
        return;
      }

      const parsed = Number(value);
      if (!Number.isFinite(parsed) || (field.kind === "int" && !Number.isInteger(parsed))) {
        ctx.addIssue({ code: "custom", message: "validation_number" });
        return;
      }

      if (field.min !== undefined && parsed < field.min) {
        ctx.addIssue({ code: "custom", message: "validation_min" });
      }
      if (field.max !== undefined && parsed > field.max) {
        ctx.addIssue({ code: "custom", message: "validation_max" });
      }
    })
    .transform((value) => String(Number(value)));
}

function fieldSchema(field: ActionField): z.ZodType<string, string> {
  switch (field.kind) {
    case "int":
    case "float":
      return numeric(field);

    case "bool":
      // A checkbox always sends a value, so it is never "required".
      return z
        .string()
        .refine((value) => ["", "true", "false", "1", "0"].includes(value), "validation_bool")
        .transform((value) => (value === "true" || value === "1" ? "true" : "false"));

    case "enum":
      return base(field).refine(
        (value) => (value === "" && !field.required) || (field.options ?? []).includes(value),
        "validation_enum",
      );

    case "identifier":
      return textual(field, IDENTIFIER_PATTERN, "validation_identifier");

    case "player":
      return textual(field, PLAYER_PATTERN, "validation_player");

    default:
      return textual(field, NO_NEWLINE, "validation_newline");
  }
}

/**
 * zod schema derived from the fields the action declares.
 *
 * A missing or empty field falls back to its default *before* validation, so
 * non-textual types (`int`, `enum`…) require a `default` when they are
 * optional — which the file loader checks.
 */
export function schemaOf(definition: Pick<ActionDefinition, "fields">) {
  const shape: Record<string, z.ZodType<string>> = {};

  for (const field of definition.fields) {
    shape[field.name] = z
      .string()
      .optional()
      .transform((value) => {
        const trimmed = (value ?? "").trim();
        return trimmed === "" ? (field.default ?? "") : trimmed;
      })
      .pipe(fieldSchema(field));
  }

  return z.object(shape).strict();
}

function join(...parts: string[]): string {
  return parts.filter((part) => part.length > 0).join(" ");
}

const PLAYER: ActionField = { name: "player", kind: "player", required: true };
const REASON: ActionField = { name: "reason", kind: "text", required: false };
const MESSAGE: ActionField = { name: "message", kind: "text", required: true };

export const ACTIONS: ActionDefinition[] = [
  {
    id: "players-online",
    group: "info",
    permission: "action:info",
    risk: "none",
    fields: [],
    build: () => "/players online",
  },
  {
    id: "players",
    group: "info",
    permission: "action:info",
    risk: "none",
    fields: [],
    build: () => "/players",
  },
  {
    id: "admins",
    group: "info",
    permission: "action:info",
    risk: "none",
    fields: [],
    build: () => "/admins",
  },
  {
    id: "banlist",
    group: "info",
    permission: "action:info",
    risk: "none",
    fields: [],
    build: () => "/banlist get",
  },
  {
    id: "version",
    group: "info",
    permission: "action:info",
    risk: "none",
    fields: [],
    build: () => "/version",
  },
  {
    id: "time",
    group: "info",
    permission: "action:info",
    risk: "none",
    fields: [],
    build: () => "/time",
  },
  {
    id: "seed",
    group: "info",
    permission: "action:info",
    risk: "none",
    fields: [],
    build: () => "/seed",
  },
  {
    id: "evolution",
    group: "info",
    permission: "action:info",
    risk: "none",
    fields: [],
    build: () => "/evolution",
  },
  {
    id: "server-save",
    group: "server",
    permission: "action:server",
    risk: "none",
    fields: [],
    build: () => "/server-save",
  },
  {
    id: "kick",
    group: "moderation",
    permission: "action:moderate",
    risk: "dangerous",
    confirm: true,
    fields: [PLAYER, REASON],
    build: (v) => join("/kick", v.player, v.reason),
  },
  {
    id: "ban",
    group: "moderation",
    permission: "action:moderate",
    risk: "dangerous",
    confirm: true,
    fields: [PLAYER, REASON],
    build: (v) => join("/ban", v.player, v.reason),
  },
  {
    id: "unban",
    group: "moderation",
    permission: "action:moderate",
    risk: "none",
    fields: [PLAYER],
    build: (v) => join("/unban", v.player),
  },
  {
    id: "mute",
    group: "moderation",
    permission: "action:moderate",
    risk: "none",
    fields: [PLAYER],
    build: (v) => join("/mute", v.player),
  },
  {
    id: "unmute",
    group: "moderation",
    permission: "action:moderate",
    risk: "none",
    fields: [PLAYER],
    build: (v) => join("/unmute", v.player),
  },
  {
    id: "promote",
    group: "server",
    permission: "action:server",
    risk: "dangerous",
    confirm: true,
    fields: [PLAYER],
    build: (v) => join("/promote", v.player),
  },
  {
    id: "demote",
    group: "server",
    permission: "action:server",
    risk: "none",
    fields: [PLAYER],
    build: (v) => join("/demote", v.player),
  },
  {
    id: "broadcast",
    group: "comms",
    permission: "action:moderate",
    risk: "none",
    fields: [MESSAGE],
    // With no leading "/", Factorio broadcasts the text to the game chat.
    build: (v) => v.message,
  },
  {
    id: "whisper",
    group: "comms",
    permission: "action:moderate",
    risk: "none",
    fields: [PLAYER, MESSAGE],
    build: (v) => join("/whisper", v.player, v.message),
  },
];

export function findAction(id: string): ActionDefinition | undefined {
  return ACTIONS.find((action) => action.id === id);
}

/** Text for the requested locale, falling back to English then the first key. */
export function localized(text: LocalizedText | undefined, locale: string): string | undefined {
  if (!text) return undefined;
  return text[locale] ?? text.en ?? Object.values(text)[0];
}

function fieldDto(field: ActionField, locale: string): ActionFieldDto {
  return {
    name: field.name,
    required: field.required,
    kind: field.kind,
    ...(field.options ? { options: field.options } : {}),
    ...(field.min !== undefined ? { min: field.min } : {}),
    ...(field.max !== undefined ? { max: field.max } : {}),
    ...(field.default !== undefined ? { default: field.default } : {}),
    ...pick("label", localized(field.label, locale)),
    ...pick("placeholder", localized(field.placeholder, locale)),
    ...pick("help", localized(field.help, locale)),
  };
}

function pick<K extends string>(key: K, value: string | undefined) {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

export function toDto(definition: ActionDefinition, locale = "en"): ActionDto {
  const text = definition.text;

  return {
    id: definition.id,
    group: definition.group,
    risk: definition.risk,
    confirm: definition.confirm === true,
    fields: definition.fields.map((field) => fieldDto(field, locale)),
    ...(text
      ? {
          text: {
            label: localized(text.label, locale) ?? definition.id,
            ...pick("hint", localized(text.hint, locale)),
            ...pick("confirmation", localized(text.confirmation, locale)),
            ...pick("group", localized(text.group, locale)),
          },
        }
      : {}),
    // The template only leaves the server when the entry asks for a preview; it
    // is written by the operator anyway, never by a user of the panel.
    ...(definition.preview && definition.template ? { template: definition.template } : {}),
  };
}
