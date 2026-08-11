import { describe, expect, it } from "vitest";
import { MAX_COMMAND_BYTES, normalizeCommand } from "@/server/rcon/command";
import { isLuaCommand } from "@/lib/lua";
import { RconError } from "@/server/rcon/errors";

describe("normalizeCommand", () => {
  it("écrase les retours à la ligne pour empêcher deux commandes en une", () => {
    expect(normalizeCommand("/players\n/server-save")).toBe("/players /server-save");
    expect(normalizeCommand("/players\r\n/server-save")).toBe("/players /server-save");
  });

  it("supprime les espaces superflus", () => {
    expect(normalizeCommand("  /players  ")).toBe("/players");
  });

  it("refuse une commande vide", () => {
    expect(() => normalizeCommand("   ")).toThrow(RconError);
    expect(() => normalizeCommand("\n")).toThrow(RconError);
  });

  it("refuse une commande au-delà de la taille maximale", () => {
    const long = `/c ${"a".repeat(MAX_COMMAND_BYTES)}`;
    expect(() => normalizeCommand(long)).toThrow(/trop longue/i);
  });

  it("compte en octets et non en caractères", () => {
    // « é » vaut 2 octets en UTF-8.
    const command = "é".repeat(MAX_COMMAND_BYTES / 2 + 1);
    expect(() => normalizeCommand(command)).toThrow(RconError);
  });
});

describe("isLuaCommand", () => {
  it("reconnaît les commandes console Lua", () => {
    expect(isLuaCommand("/c game.print('x')")).toBe(true);
    expect(isLuaCommand("/silent-command foo")).toBe(true);
    expect(isLuaCommand("  /MEASURED-COMMAND foo")).toBe(true);
  });

  it("ne confond pas avec une commande dont le préfixe est proche", () => {
    expect(isLuaCommand("/command-center")).toBe(false);
    expect(isLuaCommand("/players")).toBe(false);
    expect(isLuaCommand("bonjour tout le monde")).toBe(false);
  });
});
