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
/** Same name, type "text": quotes are not filtered out, they are escaped. */
const TEXT_PLAYER: TemplateParam = { name: "player", kind: "text" };
const TEXT: TemplateParam = { name: "note", kind: "text" };
const COUNT: TemplateParam = { name: "count", kind: "int" };

const NEWLINE = String.fromCharCode(10);
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(127);

describe("Lua literals", () => {
  it("wraps and escapes strings", () => {
    expect(luaString("Edwins")).toBe('"Edwins"');
    expect(luaString('a"b')).toBe('"a\\"b"');
    expect(luaString("a\\b")).toBe('"a\\\\b"');
    expect(luaString("it's")).toBe('"it\\\'s"');
  });

  it("refuses control characters rather than escaping them", () => {
    expect(() => luaString(`a${NEWLINE}b`)).toThrow();
    expect(() => luaString(`a${NUL}b`)).toThrow();
    expect(() => luaString(`a${DEL}b`)).toThrow();
  });

  it("parenthesises negative numbers", () => {
    expect(luaNumber(250)).toBe("250");
    // Without parentheses, "x-{{n}}" would produce "x--5": a Lua comment.
    expect(luaNumber(-5)).toBe("(-5)");
    expect(() => luaNumber(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("renders booleans", () => {
    expect(luaBool(true)).toBe("true");
    expect(luaBool(false)).toBe("false");
  });
});

describe("templates", () => {
  it("lists the markers it references", () => {
    expect(templatePlaceholders("a {{player}} b {{arg:reason}} {{player}}")).toEqual([
      { name: "player", raw: false },
      { name: "reason", raw: true },
    ]);
  });

  it("inserts a complete literal, quotes included", () => {
    expect(renderTemplate("game.players[{{player}}]", [PLAYER], { player: "Edwins" })).toBe(
      'game.players["Edwins"]',
    );
  });

  it("neutralises an attempt to escape the Lua string", () => {
    const values = { player: 'x"] rcon.print("pwned") [' };
    const rendered = renderTemplate("game.players[{{player}}]", [TEXT_PLAYER], values);

    // The value stays a closed literal: nothing escapes it.
    expect(rendered).toBe('game.players["x\\"] rcon.print(\\"pwned\\") ["]');
  });

  it("does not interpret replacement patterns inside a value", () => {
    // `String.replace` would reinterpret "$&" or "$1", so rendering must go
    // through a replacement function.
    expect(renderTemplate("x = {{note}}", [TEXT], { note: "$& $1" })).toBe('x = "$& $1"');
  });

  it("refuses an undeclared marker", () => {
    expect(() => renderTemplate("{{ghost}}", [PLAYER], {})).toThrow(/ghost/);
  });

  it("refuses a Lua comment produced by a substitution", () => {
    expect(() => renderTemplate("x = {{note}}", [TEXT], { note: "a -- b" })).toThrow();
  });

  it("renders numbers and booleans without quotes", () => {
    expect(renderTemplate("n = {{count}}", [COUNT], { count: "42" })).toBe("n = 42");
    expect(renderTemplate("b = {{flag}}", [{ name: "flag", kind: "bool" }], { flag: "true" })).toBe(
      "b = true",
    );
  });

  it("inserts the bare value with {{arg:}}", () => {
    expect(renderTemplate("/kick {{arg:player}}", [PLAYER], { player: "bob" })).toBe("/kick bob");
  });
});
