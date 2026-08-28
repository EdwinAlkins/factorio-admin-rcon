import { describe, expect, it } from "vitest";
import {
  luaBool,
  luaNumber,
  luaString,
  renderTemplate,
  templatePlaceholders,
  type TemplateParam,
} from "@/lib/lua-template";

const PLAYER: TemplateParam = { name: "player", kind: "player" };
/** Même nom, type « text » : les guillemets ne sont pas filtrés, ils sont échappés. */
const TEXT_PLAYER: TemplateParam = { name: "player", kind: "text" };
const TEXT: TemplateParam = { name: "note", kind: "text" };
const COUNT: TemplateParam = { name: "count", kind: "int" };

const NEWLINE = String.fromCharCode(10);
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(127);

describe("littéraux Lua", () => {
  it("entoure et échappe les chaînes", () => {
    expect(luaString("Edwins")).toBe('"Edwins"');
    expect(luaString('a"b')).toBe('"a\\"b"');
    expect(luaString("a\\b")).toBe('"a\\\\b"');
    expect(luaString("it's")).toBe('"it\\\'s"');
  });

  it("refuse les caractères de contrôle plutôt que de les échapper", () => {
    expect(() => luaString(`a${NEWLINE}b`)).toThrow();
    expect(() => luaString(`a${NUL}b`)).toThrow();
    expect(() => luaString(`a${DEL}b`)).toThrow();
  });

  it("parenthèse les nombres négatifs", () => {
    expect(luaNumber(250)).toBe("250");
    // Sans parenthèses, « x-{{n}} » produirait « x--5 » : un commentaire Lua.
    expect(luaNumber(-5)).toBe("(-5)");
    expect(() => luaNumber(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("rend les booléens", () => {
    expect(luaBool(true)).toBe("true");
    expect(luaBool(false)).toBe("false");
  });
});

describe("gabarits", () => {
  it("liste les marqueurs référencés", () => {
    expect(templatePlaceholders("a {{player}} b {{arg:reason}} {{player}}")).toEqual([
      { name: "player", raw: false },
      { name: "reason", raw: true },
    ]);
  });

  it("insère un littéral complet, guillemets compris", () => {
    expect(renderTemplate("game.players[{{player}}]", [PLAYER], { player: "Edwins" })).toBe(
      'game.players["Edwins"]',
    );
  });

  it("neutralise une tentative d'évasion de la chaîne Lua", () => {
    const values = { player: 'x"] rcon.print("pwned") [' };
    const rendered = renderTemplate("game.players[{{player}}]", [TEXT_PLAYER], values);

    // La valeur reste un littéral clos : rien n'en sort.
    expect(rendered).toBe('game.players["x\\"] rcon.print(\\"pwned\\") ["]');
  });

  it("n'interprète pas les motifs de remplacement d'une valeur", () => {
    // `String.replace` réinterpréterait « $& » ou « $1 » : le rendu passe donc
    // obligatoirement par une fonction de remplacement.
    expect(renderTemplate("x = {{note}}", [TEXT], { note: "$& $1" })).toBe('x = "$& $1"');
  });

  it("refuse un marqueur non déclaré", () => {
    expect(() => renderTemplate("{{ghost}}", [PLAYER], {})).toThrow(/ghost/);
  });

  it("refuse un commentaire Lua issu d'une substitution", () => {
    expect(() => renderTemplate("x = {{note}}", [TEXT], { note: "a -- b" })).toThrow();
  });

  it("rend les nombres et les booléens sans guillemets", () => {
    expect(renderTemplate("n = {{count}}", [COUNT], { count: "42" })).toBe("n = 42");
    expect(renderTemplate("b = {{flag}}", [{ name: "flag", kind: "bool" }], { flag: "true" })).toBe(
      "b = true",
    );
  });

  it("insère la valeur nue avec {{arg:}}", () => {
    expect(renderTemplate("/kick {{arg:player}}", [PLAYER], { player: "bob" })).toBe("/kick bob");
  });
});
