import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAudit, purgeAudit, recordAudit } from "@/server/audit/service";
import { setDb } from "@/server/db";
import { resetEnvCache, useMemoryDatabase, withEnv } from "../helpers";

describe("journal d'audit", () => {
  beforeEach(() => {
    withEnv({ AUDIT_RETENTION_DAYS: "30" });
    useMemoryDatabase();
  });

  afterEach(() => {
    withEnv({ AUDIT_RETENTION_DAYS: undefined });
    resetEnvCache();
  });

  it("enregistre et relit une entrée", () => {
    recordAudit({
      username: "admin",
      role: "admin",
      kind: "rcon",
      action: "command",
      command: "/players",
      status: "success",
      durationMs: 12,
      ip: null,
    });

    const [entry] = listAudit();
    expect(entry.username).toBe("admin");
    expect(entry.command).toBe("/players");
    expect(entry.status).toBe("success");
    expect(entry.durationMs).toBe(12);
  });

  it("renvoie les entrées les plus récentes en premier", () => {
    recordAudit({ username: "a", role: "admin", kind: "auth", action: "login", status: "success" });
    recordAudit({ username: "b", role: "admin", kind: "auth", action: "logout", status: "success" });

    expect(listAudit().map((entry) => entry.action)).toEqual(["logout", "login"]);
  });

  it("trace aussi les refus", () => {
    recordAudit({
      username: "?",
      role: "?",
      kind: "auth",
      action: "login",
      status: "denied",
      detail: "mot de passe incorrect",
    });

    expect(listAudit()[0].status).toBe("denied");
  });

  it("supprime les entrées au-delà de la rétention", () => {
    const now = Date.now();
    recordAudit(
      { username: "a", role: "admin", kind: "auth", action: "login", status: "success" },
      now - 40 * 24 * 60 * 60 * 1000,
    );
    recordAudit(
      { username: "b", role: "admin", kind: "auth", action: "login", status: "success" },
      now,
    );

    expect(purgeAudit(now)).toBe(1);
    expect(listAudit()).toHaveLength(1);
  });

  it("n'interrompt pas l'action en cours si l'écriture échoue", () => {
    // Base fermée : recordAudit doit avaler l'erreur, pas la propager.
    const db = useMemoryDatabase();
    db.close();
    setDb(db);

    expect(() =>
      recordAudit({ username: "a", role: "admin", kind: "rcon", action: "command", status: "error" }),
    ).not.toThrow();
  });
});
