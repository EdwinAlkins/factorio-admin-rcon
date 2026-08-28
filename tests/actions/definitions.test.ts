import { describe, expect, it } from "vitest";
import { ACTIONS, findAction, schemaOf } from "@/server/actions/definitions";
import { can, permissionsOf, ROLES } from "@/lib/permissions";

function build(id: string, values: Record<string, string>) {
  const action = findAction(id)!;
  const parsed = schemaOf(action).safeParse(values);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join(" "));
  return action.build(parsed.data as Record<string, string>);
}

describe("action catalogue", () => {
  it("has no duplicate id", () => {
    const ids = ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares a known permission for every action", () => {
    for (const action of ACTIONS) {
      expect(permissionsOf("admin")).toContain(action.permission);
    }
  });

  it("builds the expected commands", () => {
    expect(build("players-online", {})).toBe("/players online");
    expect(build("kick", { player: "bob", reason: "spam" })).toBe("/kick bob spam");
    expect(build("kick", { player: "bob" })).toBe("/kick bob");
    expect(build("ban", { player: "bob", reason: "griefing" })).toBe("/ban bob griefing");
    expect(build("whisper", { player: "bob", message: "salut" })).toBe("/whisper bob salut");
    // With no leading "/": Factorio broadcasts the text to the chat.
    expect(build("broadcast", { message: "redémarrage" })).toBe("redémarrage");
  });

  it("refuses a player name with a space or a line break", () => {
    expect(() => build("kick", { player: "bob smith" })).toThrow();
    expect(() => build("kick", { player: "bob\n/server-save" })).toThrow();
  });

  it("refuses a reason containing a line break", () => {
    expect(() => build("ban", { player: "bob", reason: "spam\n/promote bob" })).toThrow();
  });

  it("refuses an empty required field", () => {
    expect(() => build("broadcast", { message: "" })).toThrow();
    expect(() => build("kick", {})).toThrow();
  });

  it("refuses an undeclared field", () => {
    expect(() => build("players", { player: "bob" })).toThrow();
  });

  it("limits message length", () => {
    expect(() => build("broadcast", { message: "a".repeat(500) })).toThrow();
  });
});

describe("permissions per role", () => {
  it("gives the viewer info and nothing else", () => {
    expect(can("viewer", "action:info")).toBe(true);
    expect(can("viewer", "action:moderate")).toBe(false);
    expect(can("viewer", "action:server")).toBe(false);
    expect(can("viewer", "rcon:raw")).toBe(false);
    expect(can("viewer", "audit:read")).toBe(false);
  });

  it("gives the moderator moderation but not the raw console", () => {
    expect(can("moderator", "action:moderate")).toBe(true);
    expect(can("moderator", "action:server")).toBe(false);
    expect(can("moderator", "rcon:raw")).toBe(false);
  });

  it("reserves the raw RCON console and the audit log for the administrator", () => {
    expect(can("admin", "rcon:raw")).toBe(true);
    expect(can("admin", "audit:read")).toBe(true);
    for (const role of ROLES) {
      if (role !== "admin") expect(can(role, "rcon:raw")).toBe(false);
    }
  });

  it("keeps banning behind a moderation permission", () => {
    const ban = findAction("ban")!;
    expect(ban.permission).toBe("action:moderate");
    expect(ban.confirm).toBe(true);
  });
});
