import { z } from "zod";
import type { Permission } from "@/lib/permissions";
import type { ActionDto } from "@/lib/api-types";

/**
 * Catalogue des actions métier, défini **côté serveur**.
 *
 * L'interface envoie `{ action: "ban", values: { player, reason } }` : c'est le
 * serveur qui valide, applique la permission et construit la commande RCON.
 * Le client ne peut donc pas fabriquer une commande arbitraire via ce chemin.
 */

export type ActionFieldKind = "player" | "text";

export type ActionField = {
  name: string;
  label: string;
  kind: ActionFieldKind;
  placeholder?: string;
  required: boolean;
  maxLength?: number;
};

export type ActionDefinition = {
  id: string;
  label: string;
  hint: string;
  group: "Infos" | "Serveur" | "Modération" | "Communication";
  permission: Permission;
  risk: "none" | "dangerous";
  /** Message de confirmation ; `{champ}` est remplacé côté interface. */
  confirmation?: string;
  fields: ActionField[];
  build: (values: Record<string, string>) => string;
};

// Un nom de joueur Factorio ne contient pas d'espace ; le reste refuse les
// retours à la ligne, qui permettraient d'enchaîner deux commandes.
const PLAYER_PATTERN = /^[^\s\r\n]{1,60}$/;
const NO_NEWLINE = /^[^\r\n]*$/;

function fieldSchema(field: ActionField): z.ZodType<string> {
  if (field.kind === "player") {
    return z
      .string()
      .trim()
      .regex(PLAYER_PATTERN, `${field.label} : nom de joueur invalide (sans espace, 60 max).`);
  }

  const base = z
    .string()
    .trim()
    .max(field.maxLength ?? 200, `${field.label} : ${field.maxLength ?? 200} caractères maximum.`)
    .regex(NO_NEWLINE, `${field.label} : retours à la ligne interdits.`);

  return field.required ? base.min(1, `${field.label} est obligatoire.`) : base;
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

const PLAYER: ActionField = {
  name: "player",
  label: "Joueur",
  kind: "player",
  placeholder: "nom du joueur",
  required: true,
};

const REASON: ActionField = {
  name: "reason",
  label: "Raison",
  kind: "text",
  placeholder: "optionnel",
  required: false,
};

export const ACTIONS: ActionDefinition[] = [
  {
    id: "players-online",
    label: "Joueurs en ligne",
    hint: "/players online",
    group: "Infos",
    permission: "action:info",
    risk: "none",
    fields: [],
    build: () => "/players online",
  },
  {
    id: "players",
    label: "Tous les joueurs",
    hint: "/players",
    group: "Infos",
    permission: "action:info",
    risk: "none",
    fields: [],
    build: () => "/players",
  },
  {
    id: "admins",
    label: "Admins",
    hint: "/admins",
    group: "Infos",
    permission: "action:info",
    risk: "none",
    fields: [],
    build: () => "/admins",
  },
  {
    id: "banlist",
    label: "Bannis",
    hint: "/banlist get",
    group: "Infos",
    permission: "action:info",
    risk: "none",
    fields: [],
    build: () => "/banlist get",
  },
  {
    id: "version",
    label: "Version",
    hint: "/version",
    group: "Infos",
    permission: "action:info",
    risk: "none",
    fields: [],
    build: () => "/version",
  },
  {
    id: "time",
    label: "Temps de jeu",
    hint: "/time",
    group: "Infos",
    permission: "action:info",
    risk: "none",
    fields: [],
    build: () => "/time",
  },
  {
    id: "seed",
    label: "Seed",
    hint: "/seed",
    group: "Infos",
    permission: "action:info",
    risk: "none",
    fields: [],
    build: () => "/seed",
  },
  {
    id: "evolution",
    label: "Évolution",
    hint: "/evolution",
    group: "Infos",
    permission: "action:info",
    risk: "none",
    fields: [],
    build: () => "/evolution",
  },
  {
    id: "server-save",
    label: "Sauvegarder",
    hint: "/server-save",
    group: "Serveur",
    permission: "action:server",
    risk: "none",
    fields: [],
    build: () => "/server-save",
  },
  {
    id: "kick",
    label: "Kick",
    hint: "/kick <joueur> [raison]",
    group: "Modération",
    permission: "action:moderate",
    risk: "dangerous",
    confirmation: "Expulser {player} ?",
    fields: [PLAYER, REASON],
    build: (v) => join("/kick", v.player, v.reason),
  },
  {
    id: "ban",
    label: "Bannir",
    hint: "/ban <joueur> [raison]",
    group: "Modération",
    permission: "action:moderate",
    risk: "dangerous",
    confirmation: "Bannir définitivement {player} ?",
    fields: [PLAYER, REASON],
    build: (v) => join("/ban", v.player, v.reason),
  },
  {
    id: "unban",
    label: "Débannir",
    hint: "/unban <joueur>",
    group: "Modération",
    permission: "action:moderate",
    risk: "none",
    fields: [PLAYER],
    build: (v) => join("/unban", v.player),
  },
  {
    id: "mute",
    label: "Mute",
    hint: "/mute <joueur>",
    group: "Modération",
    permission: "action:moderate",
    risk: "none",
    fields: [PLAYER],
    build: (v) => join("/mute", v.player),
  },
  {
    id: "unmute",
    label: "Unmute",
    hint: "/unmute <joueur>",
    group: "Modération",
    permission: "action:moderate",
    risk: "none",
    fields: [PLAYER],
    build: (v) => join("/unmute", v.player),
  },
  {
    id: "promote",
    label: "Promouvoir admin",
    hint: "/promote <joueur>",
    group: "Serveur",
    permission: "action:server",
    risk: "dangerous",
    confirmation: "Donner les droits d'administration à {player} ?",
    fields: [PLAYER],
    build: (v) => join("/promote", v.player),
  },
  {
    id: "demote",
    label: "Rétrograder",
    hint: "/demote <joueur>",
    group: "Serveur",
    permission: "action:server",
    risk: "none",
    fields: [PLAYER],
    build: (v) => join("/demote", v.player),
  },
  {
    id: "broadcast",
    label: "Message serveur",
    hint: "diffusé dans le chat",
    group: "Communication",
    permission: "action:moderate",
    risk: "none",
    fields: [
      {
        name: "message",
        label: "Message",
        kind: "text",
        placeholder: "redémarrage dans 5 min",
        required: true,
      },
    ],
    // Sans « / » initial, Factorio diffuse le texte dans le chat de la partie.
    build: (v) => v.message,
  },
  {
    id: "whisper",
    label: "Message privé",
    hint: "/whisper <joueur> <message>",
    group: "Communication",
    permission: "action:moderate",
    risk: "none",
    fields: [
      PLAYER,
      {
        name: "message",
        label: "Message",
        kind: "text",
        placeholder: "à tout de suite",
        required: true,
      },
    ],
    build: (v) => join("/whisper", v.player, v.message),
  },
];

export function findAction(id: string): ActionDefinition | undefined {
  return ACTIONS.find((action) => action.id === id);
}

export function toDto(definition: ActionDefinition): ActionDto {
  return {
    id: definition.id,
    label: definition.label,
    hint: definition.hint,
    group: definition.group,
    risk: definition.risk,
    confirmation: definition.confirmation,
    fields: definition.fields.map((field) => ({
      name: field.name,
      label: field.label,
      placeholder: field.placeholder,
      required: field.required,
    })),
  };
}
