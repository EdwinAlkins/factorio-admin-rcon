import { z } from "zod";
import type { Permission } from "@/lib/permissions";
import type { ActionDto, ActionGroup } from "@/lib/api-types";

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

export type ActionFieldKind = "player" | "text";

export type ActionField = {
  name: string;
  kind: ActionFieldKind;
  required: boolean;
  maxLength?: number;
};

export type ActionDefinition = {
  id: string;
  group: ActionGroup;
  permission: Permission;
  risk: "none" | "dangerous";
  /** Une confirmation est demandée ; son texte vit dans les dictionnaires. */
  confirm?: boolean;
  fields: ActionField[];
  build: (values: Record<string, string>) => string;
};

// Un nom de joueur Factorio ne contient pas d'espace ; le reste refuse les
// retours à la ligne, qui permettraient d'enchaîner deux commandes.
const PLAYER_PATTERN = /^[^\s\r\n]{1,60}$/;
const NO_NEWLINE = /^[^\r\n]*$/;

export const DEFAULT_MAX_LENGTH = 200;

/**
 * Les messages zod ne sont pas des phrases mais des clés de traduction : c'est
 * `executeAction` qui les transforme en `{ code, params }` pour le client.
 */
function fieldSchema(field: ActionField): z.ZodType<string> {
  if (field.kind === "player") {
    return z.string().trim().regex(PLAYER_PATTERN, "validation_player");
  }

  const base = z
    .string()
    .trim()
    .max(field.maxLength ?? DEFAULT_MAX_LENGTH, "validation_too_long")
    .regex(NO_NEWLINE, "validation_newline");

  return field.required ? base.min(1, "validation_required") : base;
}

/** Schéma zod dérivé des champs déclarés par l'action. */
export function schemaOf(definition: ActionDefinition) {
  const shape: Record<string, z.ZodType<string>> = {};

  for (const field of definition.fields) {
    const schema = fieldSchema(field);
    shape[field.name] = field.required ? schema : schema.optional().transform((v) => v ?? "");
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

export function toDto(definition: ActionDefinition): ActionDto {
  return {
    id: definition.id,
    group: definition.group,
    risk: definition.risk,
    confirm: definition.confirm === true,
    fields: definition.fields.map((field) => ({
      name: field.name,
      required: field.required,
    })),
  };
}
