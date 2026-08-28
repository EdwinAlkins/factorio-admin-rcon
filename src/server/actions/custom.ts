import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { byteLength, renderTemplate, templatePlaceholders } from "@/lib/lua-template";
import { env } from "@/server/config/env";
import { logger } from "@/server/log";
import { MAX_COMMAND_BYTES } from "@/server/rcon/command";
import {
  schemaOf,
  type ActionDefinition,
  type ActionField,
  type LocalizedText,
} from "@/server/actions/definitions";

/**
 * Catalogue de commandes fourni par l'opérateur, chargé depuis un fichier JSON
 * monté en lecture seule (`CUSTOM_COMMANDS_FILE`).
 *
 * Le fichier est **de confiance** : il est écrit par qui déploie le conteneur,
 * au même titre qu'une variable d'environnement. Qu'il contienne du Lua n'est
 * pas une élévation de privilège — l'opérateur a déjà `rcon:raw`.
 *
 * Ce qui n'est PAS de confiance, ce sont les valeurs saisies dans le panneau.
 * D'où les contrôles croisés ci-dessous : un gabarit ne peut référencer que des
 * paramètres déclarés, et `lua-template` construit seul les littéraux Lua.
 *
 * Tolérance aux pannes assumée : une entrée invalide est ignorée avec un
 * journal explicite, un fichier illisible laisse le panneau tourner avec les
 * seules actions intégrées. Une faute de frappe ne doit pas couper l'admin.
 */

/** Un `{{nom}}` ne peut viser qu'un paramètre déclaré ici. */
const ParamSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_]{1,40}$/),
    type: z.enum(["player", "text", "identifier", "int", "float", "bool", "enum"]).default("text"),
    required: z.boolean().default(true),
    maxLength: z.number().int().min(1).max(2000).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    options: z.array(z.string().min(1).max(200)).min(1).max(50).optional(),
    // `enum` uniquement : la valeur est insérée nue (elle sort d'une liste close).
    raw: z.boolean().default(false),
    default: z.string().max(2000).optional(),
    label: z.unknown().optional(),
    placeholder: z.unknown().optional(),
    help: z.unknown().optional(),
  })
  .strict();

const CommandSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,60}$/i),
    group: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,40}$/)
      .default("custom"),
    // Défaut volontairement strict : ouvrir une commande à un rôle inférieur
    // doit être un geste explicite de l'opérateur.
    permission: z
      .enum(["action:info", "action:moderate", "action:server", "action:custom"])
      .default("action:custom"),
    risk: z.enum(["none", "dangerous"]).default("dangerous"),
    confirm: z.boolean().default(true),
    preview: z.boolean().default(true),
    label: z.unknown(),
    hint: z.unknown().optional(),
    confirmation: z.unknown().optional(),
    params: z.array(ParamSchema).max(12).default([]),
    template: z.string().min(1),
  })
  .strict();

const FileSchema = z
  .object({
    version: z.literal(1).optional(),
    groups: z.record(z.string(), z.unknown()).default({}),
    // Validées une par une : une entrée fautive ne doit pas emporter les autres.
    commands: z.array(z.unknown()).max(200).default([]),
  })
  .strict();

type RawParam = z.infer<typeof ParamSchema>;
type RawCommand = z.infer<typeof CommandSchema>;

/** `"Tuer les biters"` ou `{ "en": "…", "fr": "…" }`. */
function localizedText(value: unknown, what: string): LocalizedText {
  if (typeof value === "string" && value.trim() !== "") return { en: value };

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, text]) => typeof text === "string" && text.trim() !== "",
    ) as [string, string][];

    if (entries.length > 0) return Object.fromEntries(entries);
  }

  throw new Error(`${what} : texte manquant ou mal formé`);
}

function toField(param: RawParam): ActionField {
  if (param.type === "enum" && !param.options) {
    throw new Error(`paramètre « ${param.name} » : « options » est obligatoire pour un enum`);
  }

  if (param.raw && param.type !== "enum") {
    throw new Error(`paramètre « ${param.name} » : « raw » n'est permis que sur un enum`);
  }

  if (param.min !== undefined && param.max !== undefined && param.min > param.max) {
    throw new Error(`paramètre « ${param.name} » : min > max`);
  }

  // Un champ facultatif non textuel doit dire quoi mettre quand il est vide :
  // sinon `schemaOf` validerait la chaîne vide comme un nombre.
  const textual = param.type === "player" || param.type === "text" || param.type === "identifier";
  if (!param.required && !textual && param.type !== "bool" && param.default === undefined) {
    throw new Error(
      `paramètre « ${param.name} » : un champ facultatif ${param.type} exige « default »`,
    );
  }

  const field: ActionField = {
    name: param.name,
    kind: param.type,
    required: param.required,
    ...(param.maxLength !== undefined ? { maxLength: param.maxLength } : {}),
    ...(param.min !== undefined ? { min: param.min } : {}),
    ...(param.max !== undefined ? { max: param.max } : {}),
    ...(param.options ? { options: param.options } : {}),
    ...(param.raw ? { raw: true } : {}),
    ...(param.default !== undefined ? { default: param.default } : {}),
    ...(param.label !== undefined
      ? { label: localizedText(param.label, `paramètre « ${param.name} » (label)`) }
      : {}),
    ...(param.placeholder !== undefined
      ? {
          placeholder: localizedText(
            param.placeholder,
            `paramètre « ${param.name} » (placeholder)`,
          ),
        }
      : {}),
    ...(param.help !== undefined
      ? { help: localizedText(param.help, `paramètre « ${param.name} » (help)`) }
      : {}),
  };

  // La valeur par défaut passe par la même validation que la saisie : une
  // valeur par défaut invalide ferait échouer la commande à l'exécution.
  if (param.default !== undefined) {
    const probe = schemaOf({ fields: [field] }).safeParse({ [field.name]: param.default });
    if (!probe.success) {
      throw new Error(
        `paramètre « ${param.name} » : « default » invalide (${probe.error.issues[0]?.message})`,
      );
    }
  }

  return field;
}

function toDefinition(raw: RawCommand, groups: Record<string, LocalizedText>): ActionDefinition {
  const fields = raw.params.map(toField);

  const names = new Set<string>();
  for (const field of fields) {
    if (names.has(field.name)) throw new Error(`paramètre « ${field.name} » déclaré deux fois`);
    names.add(field.name);
  }

  // « -- » ouvre un commentaire Lua. `normalizeCommand()` aplatissant les
  // retours à la ligne, il avalerait tout le reste de la commande.
  if (raw.template.includes("--")) {
    throw new Error("le gabarit contient « -- » (commentaire Lua interdit)");
  }

  if (byteLength(raw.template) > MAX_COMMAND_BYTES) {
    throw new Error(`gabarit trop long (${MAX_COMMAND_BYTES} octets maximum)`);
  }

  const used = templatePlaceholders(raw.template);
  for (const placeholder of used) {
    if (!names.has(placeholder.name)) {
      throw new Error(
        `le gabarit référence « ${placeholder.name} », qui n'est pas déclaré`,
      );
    }
  }

  for (const name of names) {
    if (!used.some((placeholder) => placeholder.name === name)) {
      logger.warn("commands: paramètre déclaré mais inutilisé", {
        command: raw.id,
        param: name,
      });
    }
  }

  return {
    // Préfixe : aucune collision possible avec une action intégrée, et l'audit
    // distingue d'un coup d'œil ce qui vient du fichier de l'opérateur.
    id: `custom:${raw.id}`,
    group: raw.group,
    permission: raw.permission,
    risk: raw.risk,
    confirm: raw.confirm,
    fields,
    text: {
      label: localizedText(raw.label, `commande « ${raw.id} » (label)`),
      ...(raw.hint !== undefined
        ? { hint: localizedText(raw.hint, `commande « ${raw.id} » (hint)`) }
        : {}),
      ...(raw.confirmation !== undefined
        ? {
            confirmation: localizedText(
              raw.confirmation,
              `commande « ${raw.id} » (confirmation)`,
            ),
          }
        : {}),
      ...(groups[raw.group] ? { group: groups[raw.group] } : {}),
    },
    template: raw.template,
    preview: raw.preview,
    build: (values) => renderTemplate(raw.template, fields, values),
  };
}

export type CustomCatalog = {
  path: string;
  /** Signature du fichier (`mtime:taille`), `""` s'il est absent. */
  key: string;
  actions: ActionDefinition[];
  rejected: number;
  /** Message d'erreur de lecture ; `null` si le fichier est absent ou valide. */
  error: string | null;
};

const EMPTY: Omit<CustomCatalog, "path" | "key"> = { actions: [], rejected: 0, error: null };

export function parseCatalog(source: string): Omit<CustomCatalog, "path" | "key"> {
  const file = FileSchema.safeParse(JSON.parse(source));

  if (!file.success) {
    const details = file.error.issues
      .map((issue) => `${issue.path.join(".") || "(racine)"} : ${issue.message}`)
      .join(" ; ");
    throw new Error(details);
  }

  const groups: Record<string, LocalizedText> = {};
  for (const [name, value] of Object.entries(file.data.groups)) {
    try {
      groups[name] = localizedText(value, `groupe « ${name} »`);
    } catch (error) {
      logger.warn("commands: groupe ignoré", { group: name, reason: String(error) });
    }
  }

  const actions: ActionDefinition[] = [];
  const seen = new Set<string>();
  let rejected = 0;

  for (const [index, entry] of file.data.commands.entries()) {
    const parsed = CommandSchema.safeParse(entry);

    if (!parsed.success) {
      rejected += 1;
      logger.warn("commands: entrée ignorée", {
        index,
        reason: parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(racine)"} : ${issue.message}`)
          .join(" ; "),
      });
      continue;
    }

    try {
      const definition = toDefinition(parsed.data, groups);

      if (seen.has(definition.id)) {
        throw new Error(`identifiant « ${parsed.data.id} » déclaré deux fois`);
      }

      seen.add(definition.id);
      actions.push(definition);
    } catch (error) {
      rejected += 1;
      logger.warn("commands: entrée ignorée", {
        index,
        command: parsed.data.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { actions, rejected, error: null };
}

const globalRef = globalThis as typeof globalThis & { __factorioCommands?: CustomCatalog };

/**
 * Signature du fichier. Relire `mtime` + taille à chaque appel coûte un
 * `stat()` et évite un endpoint de rechargement à protéger : l'opérateur
 * corrige son catalogue sans redémarrer le conteneur.
 */
function signature(path: string): string {
  try {
    const stats = statSync(path);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return "";
  }
}

export function loadCustomCatalog(): CustomCatalog {
  const path = env().CUSTOM_COMMANDS_FILE;
  const key = signature(path);
  const cached = globalRef.__factorioCommands;

  if (cached && cached.path === path && cached.key === key) return cached;

  // Fichier absent : la fonctionnalité est simplement inactive.
  if (key === "") {
    return (globalRef.__factorioCommands = { path, key, ...EMPTY });
  }

  let catalog: CustomCatalog;
  try {
    // turbopackIgnore : chemin fourni à l'exécution.
    const source = readFileSync(/* turbopackIgnore: true */ path, "utf8");
    catalog = { path, key, ...parseCatalog(source) };
    logger.info("commands: catalogue chargé", {
      file: path,
      loaded: catalog.actions.length,
      rejected: catalog.rejected,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    catalog = { path, key, actions: [], rejected: 0, error: message };
    logger.error("commands: fichier illisible", { file: path, reason: message });
  }

  return (globalRef.__factorioCommands = catalog);
}

export function customActions(): ActionDefinition[] {
  return loadCustomCatalog().actions;
}

/** Vide le cache : utilisé par les tests, et par un changement de configuration. */
export function resetCustomCatalog() {
  delete globalRef.__factorioCommands;
}
