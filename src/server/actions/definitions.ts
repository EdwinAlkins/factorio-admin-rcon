import { z } from "zod";
import type { Permission } from "@/lib/permissions";
import { hasControlChar, type LuaKind } from "@/lib/lua-template";
import type { ActionDto, ActionFieldDto } from "@/lib/api-types";

/**
 * Catalogue des actions métier, défini **côté serveur**.
 *
 * L'interface envoie `{ action: "ban", values: { player, reason } }` : c'est le
 * serveur qui valide, applique la permission et construit la commande RCON.
 * Le client ne peut donc pas fabriquer une commande arbitraire via ce chemin.
 *
 * Aucun texte d'interface ici : libellés, indices et confirmations sont des
 * clés `actions.items.<id>.*` dans `messages/*.json`, résolues côté client.
 * `tests/i18n/messages.test.ts` vérifie qu'aucune action n'a de clé manquante.
 */

export type ActionFieldKind = LuaKind;

/**
 * Texte porté par la définition elle-même, par locale (`{ en, fr }`).
 *
 * Les actions intégrées n'en ont pas : leurs libellés vivent dans les
 * dictionnaires. Seules les actions du fichier de l'opérateur en portent — un
 * catalogue écrit hors du dépôt ne peut pas alimenter `messages/*.json`.
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
  /** `enum` uniquement : liste close des valeurs acceptées. */
  options?: string[];
  /** `enum` uniquement : insérer la valeur nue plutôt qu'un littéral chaîne. */
  raw?: boolean;
  /** Valeur retenue quand le champ est laissé vide. */
  default?: string;
  label?: LocalizedText;
  placeholder?: LocalizedText;
  help?: LocalizedText;
};

export type ActionDefinition = {
  id: string;
  /** Union fermée pour les actions intégrées, libre pour celles du fichier. */
  group: string;
  permission: Permission;
  risk: "none" | "dangerous";
  /** Une confirmation est demandée ; son texte vit dans les dictionnaires. */
  confirm?: boolean;
  fields: ActionField[];
  build: (values: Record<string, string>) => string;
  /** Actions du fichier de l'opérateur : textes et gabarit portés ici. */
  text?: {
    label: LocalizedText;
    hint?: LocalizedText;
    confirmation?: LocalizedText;
    group?: LocalizedText;
  };
  /** Gabarit source, transmis à l'interface pour l'aperçu avant confirmation. */
  template?: string;
  preview?: boolean;
};

// Un nom de joueur Factorio ne contient pas d'espace ; les guillemets et
// l'antislash sont refusés en amont de tout échappement (cf. `lua-template`).
const PLAYER_PATTERN = /^[^\s\r\n"'\\]{1,60}$/;
const NO_NEWLINE = /^[^\r\n]*$/;
// Noms de prototypes Factorio : `iron-plate`, `steel-processing`, `crude-oil`.
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_.-]{1,80}$/;

export const DEFAULT_MAX_LENGTH = 200;

/**
 * Les messages zod ne sont pas des phrases mais des clés de traduction : c'est
 * `executeAction` qui les transforme en `{ code, params }` pour le client.
 */
function base(field: ActionField): z.ZodString {
  return field.required ? z.string().min(1, "validation_required") : z.string();
}

/** Un champ facultatif laissé vide n'est pas une erreur de format. */
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
 * Les valeurs transitent en chaîne (`values: Record<string, string>`) : on
 * valide le nombre puis on rend sa forme canonique, pour que le gabarit n'ait
 * jamais à réinterpréter la saisie.
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
      // Une case à cocher envoie toujours une valeur : jamais « requise ».
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
 * Schéma zod dérivé des champs déclarés par l'action.
 *
 * Un champ absent ou vide retombe sur sa valeur par défaut *avant* validation :
 * les types non textuels (`int`, `enum`…) exigent donc un `default` s'ils sont
 * facultatifs, ce que le chargeur du fichier vérifie.
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
    // Sans « / » initial, Factorio diffuse le texte dans le chat de la partie.
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

/** Texte de la locale demandée, avec repli anglais puis première clé connue. */
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
    // Le gabarit ne quitte le serveur que si l'entrée demande un aperçu : il est
    // de toute façon écrit par l'opérateur, jamais par un utilisateur du panneau.
    ...(definition.preview && definition.template ? { template: definition.template } : {}),
  };
}
