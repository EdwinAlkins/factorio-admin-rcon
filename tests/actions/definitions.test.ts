import { describe, expect, it } from "vitest";
import { ACTIONS, findAction, schemaOf } from "@/server/actions/definitions";
import { can, permissionsOf, ROLES } from "@/lib/permissions";

function build(id: string, values: Record<string, string>) {
  const action = findAction(id)!;
  const parsed = schemaOf(action).safeParse(values);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join(" "));
  return action.build(parsed.data as Record<string, string>);
}

describe("catalogue d'actions", () => {
  it("n'a pas d'identifiant en double", () => {
    const ids = ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("déclare une permission connue pour chaque action", () => {
    for (const action of ACTIONS) {
      expect(permissionsOf("admin")).toContain(action.permission);
    }
  });

  it("construit les commandes attendues", () => {
    expect(build("players-online", {})).toBe("/players online");
    expect(build("kick", { player: "bob", reason: "spam" })).toBe("/kick bob spam");
    expect(build("kick", { player: "bob" })).toBe("/kick bob");
    expect(build("ban", { player: "bob", reason: "griefing" })).toBe("/ban bob griefing");
    expect(build("whisper", { player: "bob", message: "salut" })).toBe("/whisper bob salut");
    // Sans « / » initial : Factorio diffuse le texte dans le chat.
    expect(build("broadcast", { message: "redémarrage" })).toBe("redémarrage");
  });

  it("refuse un nom de joueur avec espace ou saut de ligne", () => {
    expect(() => build("kick", { player: "bob smith" })).toThrow();
    expect(() => build("kick", { player: "bob\n/server-save" })).toThrow();
  });

  it("refuse une raison contenant un saut de ligne", () => {
    expect(() => build("ban", { player: "bob", reason: "spam\n/promote bob" })).toThrow();
  });

  it("refuse un champ obligatoire vide", () => {
    expect(() => build("broadcast", { message: "" })).toThrow();
    expect(() => build("kick", {})).toThrow();
  });

  it("refuse un champ non déclaré", () => {
    expect(() => build("players", { player: "bob" })).toThrow();
  });

  it("limite la longueur des messages", () => {
    expect(() => build("broadcast", { message: "a".repeat(500) })).toThrow();
  });
});

describe("permissions par rôle", () => {
  it("donne à l'observateur les infos mais rien d'autre", () => {
    expect(can("viewer", "action:info")).toBe(true);
    expect(can("viewer", "action:moderate")).toBe(false);
    expect(can("viewer", "action:server")).toBe(false);
    expect(can("viewer", "rcon:raw")).toBe(false);
    expect(can("viewer", "audit:read")).toBe(false);
  });

  it("donne au modérateur la modération mais pas la console brute", () => {
    expect(can("moderator", "action:moderate")).toBe(true);
    expect(can("moderator", "action:server")).toBe(false);
    expect(can("moderator", "rcon:raw")).toBe(false);
  });

  it("réserve la console RCON brute et l'audit à l'administrateur", () => {
    expect(can("admin", "rcon:raw")).toBe(true);
    expect(can("admin", "audit:read")).toBe(true);
    for (const role of ROLES) {
      if (role !== "admin") expect(can(role, "rcon:raw")).toBe(false);
    }
  });

  it("laisse le bannissement derrière une permission de modération", () => {
    const ban = findAction("ban")!;
    expect(ban.permission).toBe("action:moderate");
    expect(ban.confirmation).toBeTruthy();
  });
});
