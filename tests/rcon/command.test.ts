import { describe, expect, it } from "vitest";
import { MAX_COMMAND_BYTES, normalizeCommand } from "@/server/rcon/command";
import { isLuaCommand } from "@/lib/lua";
import { RconError } from "@/server/rcon/errors";

describe("normalizeCommand", () => {
  it("flattens line breaks so one input cannot be two commands", () => {
    expect(normalizeCommand("/players\n/server-save")).toBe("/players /server-save");
    expect(normalizeCommand("/players\r\n/server-save")).toBe("/players /server-save");
  });

  it("strips redundant whitespace", () => {
    expect(normalizeCommand("  /players  ")).toBe("/players");
  });

  it("refuses an empty command", () => {
    expect(() => normalizeCommand("   ")).toThrow(RconError);
    expect(() => normalizeCommand("\n")).toThrow(RconError);
    // The key is asserted, not the sentence: displayed text depends on the language.
    expect(() => normalizeCommand("   ")).toThrow(
      expect.objectContaining({ key: "command_empty" }),
    );
  });

  it("refuses a command beyond the maximum size", () => {
    const long = `/c ${"a".repeat(MAX_COMMAND_BYTES)}`;
    expect(() => normalizeCommand(long)).toThrow(
      expect.objectContaining({ key: "command_too_long", params: { max: MAX_COMMAND_BYTES } }),
    );
  });

  it("counts bytes, not characters", () => {
    // "é" is 2 bytes in UTF-8.
    const command = "é".repeat(MAX_COMMAND_BYTES / 2 + 1);
    expect(() => normalizeCommand(command)).toThrow(RconError);
  });
});

describe("isLuaCommand", () => {
  it("recognises Lua console commands", () => {
    expect(isLuaCommand("/c game.print('x')")).toBe(true);
    expect(isLuaCommand("/silent-command foo")).toBe(true);
    expect(isLuaCommand("  /MEASURED-COMMAND foo")).toBe(true);
  });

  it("does not confuse it with a command sharing a similar prefix", () => {
    expect(isLuaCommand("/command-center")).toBe(false);
    expect(isLuaCommand("/players")).toBe(false);
    expect(isLuaCommand("bonjour tout le monde")).toBe(false);
  });
});
