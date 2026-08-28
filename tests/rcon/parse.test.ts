import { describe, expect, it } from "vitest";
import { parseOnlinePlayers, parsePlayers, parseVersion } from "@/server/rcon/parse";

describe("parsePlayers", () => {
  it("reads the format observed on the server", () => {
    const output = "Online players (2):\n  alice (online)\n  bob (online)\n";
    expect(parseOnlinePlayers(output)).toEqual(["alice", "bob"]);
    expect(parsePlayers(output).declared).toBe(2);
  });

  it("handles an empty list", () => {
    expect(parseOnlinePlayers("Online players (0):\n")).toEqual([]);
  });

  it("handles the full list, where offline players carry no suffix", () => {
    const output = "Players (3):\n  alice (online)\n  bob\n  carol\n";
    expect(parseOnlinePlayers(output)).toEqual(["alice", "bob", "carol"]);
  });

  it("tolerates bullets and Windows carriage returns", () => {
    const output = "Online players (2):\r\n- alice\r\n* bob\r\n";
    expect(parseOnlinePlayers(output)).toEqual(["alice", "bob"]);
  });

  it("returns nothing for empty output", () => {
    expect(parseOnlinePlayers("")).toEqual([]);
    expect(parsePlayers("").declared).toBeNull();
  });
});

describe("parseVersion", () => {
  it("strips the trailing line break", () => {
    expect(parseVersion("2.0.77\n")).toBe("2.0.77");
  });

  it("keeps only the first line", () => {
    expect(parseVersion("2.0.77\nautre chose")).toBe("2.0.77");
  });
});
