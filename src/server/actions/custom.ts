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
 * Command catalogue supplied by the operator, loaded from a JSON file mounted
 * read-only (`CUSTOM_COMMANDS_FILE`).
 *
 * The file is **trusted**: it is written by whoever deploys the container, on
 * the same footing as an environment variable. That it contains Lua is not a
 * privilege escalation — the operator already holds `rcon:raw`.
 *
 * What is NOT trusted is the values typed into the panel. Hence the cross
 * checks below: a template may only reference declared parameters, and
 * `lua-template` alone builds the Lua literals.
 *
 * Fault tolerance is deliberate: an invalid entry is skipped with an explicit
 * log line, and an unreadable file leaves the panel running with the built-in
 * actions only. A typo must not take the admin panel down.
 */

/** A `{{name}}` may only point at a parameter declared here. */
const ParamSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_]{1,40}$/),
    type: z.enum(["player", "text", "identifier", "int", "float", "bool", "enum"]).default("text"),
    required: z.boolean().default(true),
    maxLength: z.number().int().min(1).max(2000).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    options: z.array(z.string().min(1).max(200)).min(1).max(50).optional(),
    // `enum` only: the value is inserted bare (it comes from a closed list).
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
    // Deliberately strict default: opening a command to a lower role must be an
    // explicit gesture from the operator.
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
    // Validated one by one: a faulty entry must not take the others down.
    commands: z.array(z.unknown()).max(200).default([]),
  })
  .strict();

type RawParam = z.infer<typeof ParamSchema>;
type RawCommand = z.infer<typeof CommandSchema>;

/** `"Kill the biters"` or `{ "en": "…", "fr": "…" }`. */
function localizedText(value: unknown, what: string): LocalizedText {
  if (typeof value === "string" && value.trim() !== "") return { en: value };

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, text]) => typeof text === "string" && text.trim() !== "",
    ) as [string, string][];

    if (entries.length > 0) return Object.fromEntries(entries);
  }

  throw new Error(`${what}: missing or malformed text`);
}

function toField(param: RawParam): ActionField {
  if (param.type === "enum" && !param.options) {
    throw new Error(`parameter "${param.name}": "options" is required for an enum`);
  }

  if (param.raw && param.type !== "enum") {
    throw new Error(`parameter "${param.name}": "raw" is only allowed on an enum`);
  }

  if (param.min !== undefined && param.max !== undefined && param.min > param.max) {
    throw new Error(`parameter "${param.name}": min > max`);
  }

  // A non-textual optional field must say what to use when it is empty:
  // otherwise `schemaOf` would validate the empty string as a number.
  const textual = param.type === "player" || param.type === "text" || param.type === "identifier";
  if (!param.required && !textual && param.type !== "bool" && param.default === undefined) {
    throw new Error(
      `parameter "${param.name}": an optional ${param.type} field requires "default"`,
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

  // The default goes through the same validation as user input: an invalid
  // default would make the command fail at execution time.
  if (param.default !== undefined) {
    const probe = schemaOf({ fields: [field] }).safeParse({ [field.name]: param.default });
    if (!probe.success) {
      throw new Error(
        `parameter "${param.name}": invalid "default" (${probe.error.issues[0]?.message})`,
      );
    }
  }

  return field;
}

function toDefinition(raw: RawCommand, groups: Record<string, LocalizedText>): ActionDefinition {
  const fields = raw.params.map(toField);

  const names = new Set<string>();
  for (const field of fields) {
    if (names.has(field.name)) throw new Error(`parameter "${field.name}" declared twice`);
    names.add(field.name);
  }

  // "--" opens a Lua comment. Since `normalizeCommand()` flattens line breaks,
  // it would swallow the rest of the command.
  if (raw.template.includes("--")) {
    throw new Error('the template contains "--" (Lua comments are not allowed)');
  }

  if (byteLength(raw.template) > MAX_COMMAND_BYTES) {
    throw new Error(`template too long (${MAX_COMMAND_BYTES} bytes maximum)`);
  }

  const used = templatePlaceholders(raw.template);
  for (const placeholder of used) {
    if (!names.has(placeholder.name)) {
      throw new Error(
        `the template references "${placeholder.name}", which is not declared`,
      );
    }
  }

  for (const name of names) {
    if (!used.some((placeholder) => placeholder.name === name)) {
      logger.warn("commands: parameter declared but unused", {
        command: raw.id,
        param: name,
      });
    }
  }

  return {
    // The prefix rules out any collision with a built-in action, and lets the
    // audit log tell at a glance what comes from the operator's file.
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
  /** File signature (`mtime:size`), `""` when the file is absent. */
  key: string;
  actions: ActionDefinition[];
  rejected: number;
  /** Read error message; `null` when the file is absent or valid. */
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
      logger.warn("commands: group skipped", { group: name, reason: String(error) });
    }
  }

  const actions: ActionDefinition[] = [];
  const seen = new Set<string>();
  let rejected = 0;

  for (const [index, entry] of file.data.commands.entries()) {
    const parsed = CommandSchema.safeParse(entry);

    if (!parsed.success) {
      rejected += 1;
      logger.warn("commands: entry skipped", {
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
        throw new Error(`id "${parsed.data.id}" declared twice`);
      }

      seen.add(definition.id);
      actions.push(definition);
    } catch (error) {
      rejected += 1;
      logger.warn("commands: entry skipped", {
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
 * File signature. Re-reading `mtime` + size on every call costs one `stat()`
 * and spares us a reload endpoint to protect: the operator fixes their
 * catalogue without restarting the container.
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

  // File absent: the feature is simply inactive.
  if (key === "") {
    return (globalRef.__factorioCommands = { path, key, ...EMPTY });
  }

  let catalog: CustomCatalog;
  try {
    // turbopackIgnore: the path is supplied at runtime.
    const source = readFileSync(/* turbopackIgnore: true */ path, "utf8");
    catalog = { path, key, ...parseCatalog(source) };
    logger.info("commands: catalogue loaded", {
      file: path,
      loaded: catalog.actions.length,
      rejected: catalog.rejected,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    catalog = { path, key, actions: [], rejected: 0, error: message };
    logger.error("commands: unreadable file", { file: path, reason: message });
  }

  return (globalRef.__factorioCommands = catalog);
}

export function customActions(): ActionDefinition[] {
  return loadCustomCatalog().actions;
}

/** Clears the cache: used by the tests, and on a configuration change. */
export function resetCustomCatalog() {
  delete globalRef.__factorioCommands;
}
