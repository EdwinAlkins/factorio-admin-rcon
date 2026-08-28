/**
 * Command template rendering, **shared between client and server**.
 *
 * A template comes from the operator's command file: it is trusted, on the same
 * footing as an environment variable. The **values** injected into it come from
 * the interface: they are not. The whole security of the feature rests on that
 * boundary.
 *
 * The template never writes the quotes itself — `game.players[{{player}}]`, not
 * `game.players["{{player}}"]`. It is `luaString()` that produces the complete
 * literal, so no template can get the escaping wrong.
 *
 * The module depends on nothing (neither Node nor React): the preview shown
 * before confirmation uses exactly the same code as execution, and there is
 * only one escaping path to audit.
 */

export type LuaKind = "player" | "text" | "identifier" | "int" | "float" | "bool" | "enum";

export type TemplateParam = {
  name: string;
  kind: LuaKind;
  /** `enum` only: insert the bare value rather than a string literal. */
  raw?: boolean;
};

/** See `isRconError`: this module is shared client/server, hence duplicated. */
const BRAND = Symbol.for("factorio-admin.LuaTemplateError");

export function isLuaTemplateError(value: unknown): value is LuaTemplateError {
  return typeof value === "object" && value !== null && BRAND in value;
}

export class LuaTemplateError extends Error {
  readonly [BRAND] = true;
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LuaTemplateError";
    this.code = code;
  }
}

/**
 * Characters refused inside an injected value: C0/C1 controls and Unicode line
 * separators. Escaping them would be possible, but a line break would have to
 * become `\010` or `\n` depending on what follows, and `normalizeCommand()`
 * flattens them anyway. Refusing is easier to verify.
 */
export function hasControlChar(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}

/** `{{name}}` (Lua literal) or `{{arg:name}}` (bare value, non-Lua commands). */
const PLACEHOLDER = /\{\{\s*(arg:)?([A-Za-z0-9_]+)\s*\}\}/g;

/** Lua string literal, quotes included. */
export function luaString(value: string): string {
  if (hasControlChar(value)) {
    throw new LuaTemplateError("validation_control_char", "caractere de controle refuse");
  }

  return `"${value.replace(/[\\"']/g, (char) => `\\${char}`)}"`;
}

/**
 * Lua number. Negatives are parenthesised: without that, a template like
 * `x-{{n}}` would produce `x--5`, and "--" opens a Lua comment that would
 * swallow the rest of the command (line breaks being flattened).
 */
export function luaNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new LuaTemplateError("validation_number", "nombre non fini");
  }

  return value < 0 ? `(${value})` : String(value);
}

export function luaBool(value: boolean): string {
  return value ? "true" : "false";
}

/** Names the template references, in order of appearance, without duplicates. */
export function templatePlaceholders(template: string): { name: string; raw: boolean }[] {
  const seen = new Map<string, boolean>();

  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[2];
    if (!seen.has(name)) seen.set(name, match[1] !== undefined);
  }

  return [...seen].map(([name, raw]) => ({ name, raw }));
}

function truthy(value: string): boolean {
  return value === "true" || value === "1";
}

function literal(param: TemplateParam, value: string): string {
  switch (param.kind) {
    case "int":
    case "float":
      return luaNumber(Number(value));
    case "bool":
      return luaBool(truthy(value));
    case "enum":
      return param.raw ? value : luaString(value);
    default:
      return luaString(value);
  }
}

/** Bare value for `{{arg:name}}`: plain commands, with no Lua syntax. */
function plain(param: TemplateParam, value: string): string {
  if (hasControlChar(value)) {
    throw new LuaTemplateError("validation_control_char", "caractere de controle refuse");
  }

  if (param.kind === "bool") return luaBool(truthy(value));
  if (param.kind === "int" || param.kind === "float") return String(Number(value));
  return value;
}

/**
 * Substitutes the template's markers. Values are assumed to have been
 * **validated already** by the action's zod schema: this rendering is the
 * second barrier, not the first.
 */
export function renderTemplate(
  template: string,
  params: readonly TemplateParam[],
  values: Record<string, string>,
): string {
  const byName = new Map(params.map((param) => [param.name, param]));

  // A replacement function is mandatory: a value containing "$&" or "$1" would
  // be reinterpreted by `String.replace`, and it comes from the user.
  const rendered = template.replace(
    PLACEHOLDER,
    (_match, arg: string | undefined, name: string) => {
      const param = byName.get(name);

      if (!param) {
        throw new LuaTemplateError("unknown_placeholder", `parametre inconnu : ${name}`);
      }

      const value = values[name] ?? "";
      return arg === undefined ? literal(param, value) : plain(param, value);
    },
  );

  // A "--" can only come from a substitution: templates containing one are
  // refused at load time.
  if (rendered.includes("--")) {
    throw new LuaTemplateError("validation_comment", "commentaire Lua interdit dans une valeur");
  }

  return rendered;
}

/** Byte length, available on the client as well as the server. */
export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
