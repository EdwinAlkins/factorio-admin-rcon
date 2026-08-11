import { describe, expect, it } from "vitest";
import { parseOnlinePlayers, parsePlayers, parseVersion } from "@/server/rcon/parse";

describe("parsePlayers", () => {
  it("lit le format observé sur le serveur", () => {
    const output = "Online players (2):\n  alice (online)\n  bob (online)\n";
    expect(parseOnlinePlayers(output)).toEqual(["alice", "bob"]);
    expect(parsePlayers(output).declared).toBe(2);
  });

  it("gère une liste vide", () => {
    expect(parseOnlinePlayers("Online players (0):\n")).toEqual([]);
  });

  it("gère la liste complète, où les hors-ligne n'ont pas de suffixe", () => {
    const output = "Players (3):\n  alice (online)\n  bob\n  carol\n";
    expect(parseOnlinePlayers(output)).toEqual(["alice", "bob", "carol"]);
  });

  it("tolère les puces et les retours chariot Windows", () => {
    const output = "Online players (2):\r\n- alice\r\n* bob\r\n";
    expect(parseOnlinePlayers(output)).toEqual(["alice", "bob"]);
  });

  it("ne renvoie rien pour une sortie vide", () => {
    expect(parseOnlinePlayers("")).toEqual([]);
    expect(parsePlayers("").declared).toBeNull();
  });
});

describe("parseVersion", () => {
  it("retire le retour à la ligne final", () => {
    expect(parseVersion("2.0.77\n")).toBe("2.0.77");
  });

  it("ne garde que la première ligne", () => {
    expect(parseVersion("2.0.77\nautre chose")).toBe("2.0.77");
  });
});
