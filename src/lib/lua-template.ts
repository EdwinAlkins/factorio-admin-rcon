/**
 * Rendu des gabarits de commandes, **partagé client et serveur**.
 *
 * Un gabarit vient du fichier de commandes de l'opérateur : il est de confiance,
 * au même titre qu'une variable d'environnement. Les **valeurs** qu'on y injecte
 * viennent de l'interface : elles ne le sont pas. Toute la sécurité de la
 * fonctionnalité tient dans cette frontière.
 *
 * Le gabarit n'écrit jamais les guillemets lui-même — `game.players[{{player}}]`
 * et non `game.players["{{player}}"]`. C'est `luaString()` qui produit le
 * littéral complet, donc aucun gabarit ne peut se tromper d'échappement.
 *
 * Le module ne dépend de rien (ni Node, ni React) : l'aperçu affiché avant
 * confirmation utilise exactement le même code que l'exécution, et il n'existe
 * qu'une seule logique d'échappement à auditer.
 */

export type LuaKind = "player" | "text" | "identifier" | "int" | "float" | "bool" | "enum";

export type TemplateParam = {
  name: string;
  kind: LuaKind;
  /** `enum` uniquement : insérer la valeur nue plutôt qu'un littéral chaîne. */
  raw?: boolean;
};

export class LuaTemplateError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LuaTemplateError";
    this.code = code;
  }
}

/**
 * Caractères refusés dans une valeur injectée : commandes C0/C1 et séparateurs
 * de ligne Unicode. Les échapper serait possible, mais un saut de ligne devrait
 * devenir `\010` ou `\n` selon ce qui suit, et `normalizeCommand()` les écrase
 * de toute façon. Refuser est plus simple à vérifier.
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

/** `{{nom}}` (littéral Lua) ou `{{arg:nom}}` (valeur nue, commandes non-Lua). */
const PLACEHOLDER = /\{\{\s*(arg:)?([A-Za-z0-9_]+)\s*\}\}/g;

/** Littéral chaîne Lua, guillemets compris. */
export function luaString(value: string): string {
  if (hasControlChar(value)) {
    throw new LuaTemplateError("validation_control_char", "caractere de controle refuse");
  }

  return `"${value.replace(/[\\"']/g, (char) => `\\${char}`)}"`;
}

/**
 * Nombre Lua. Les négatifs sont parenthésés : sans cela, un gabarit du type
 * `x-{{n}}` produirait `x--5`, et « -- » ouvre un commentaire Lua qui avalerait
 * tout le reste de la commande (les retours à la ligne étant aplatis).
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

/** Noms référencés par le gabarit, dans l'ordre d'apparition, sans doublon. */
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

/** Valeur nue pour `{{arg:nom}}` : commandes classiques, sans syntaxe Lua. */
function plain(param: TemplateParam, value: string): string {
  if (hasControlChar(value)) {
    throw new LuaTemplateError("validation_control_char", "caractere de controle refuse");
  }

  if (param.kind === "bool") return luaBool(truthy(value));
  if (param.kind === "int" || param.kind === "float") return String(Number(value));
  return value;
}

/**
 * Substitue les marqueurs du gabarit. Les valeurs sont supposées **déjà
 * validées** par le schéma zod de l'action : ce rendu est la seconde barrière,
 * pas la première.
 */
export function renderTemplate(
  template: string,
  params: readonly TemplateParam[],
  values: Record<string, string>,
): string {
  const byName = new Map(params.map((param) => [param.name, param]));

  // Fonction de remplacement obligatoire : une valeur contenant « $& » ou « $1 »
  // serait réinterprétée par `String.replace`, et elle vient de l'utilisateur.
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

  // Un « -- » ne peut venir que d'une substitution : les gabarits qui en
  // contiennent sont refusés au chargement.
  if (rendered.includes("--")) {
    throw new LuaTemplateError("validation_comment", "commentaire Lua interdit dans une valeur");
  }

  return rendered;
}

/** Taille en octets, disponible côté client comme côté serveur. */
export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
