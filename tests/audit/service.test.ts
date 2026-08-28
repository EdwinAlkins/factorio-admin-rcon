import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listAudit,
  purgeAudit,
  RAW_COMMAND_PREVIEW,
  recordAudit,
} from "@/server/audit/service";
import { setDb } from "@/server/db";
import { resetEnvCache, useMemoryDatabase, withEnv } from "../helpers";

describe("audit log", () => {
  beforeEach(() => {
    withEnv({ AUDIT_RETENTION_DAYS: "30" });
    useMemoryDatabase();
  });

  afterEach(() => {
    withEnv({ AUDIT_RETENTION_DAYS: undefined });
    resetEnvCache();
  });

  it("records and reads back an entry", () => {
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

  it("returns the most recent entries first", () => {
    recordAudit({ username: "a", role: "admin", kind: "auth", action: "login", status: "success" });
    recordAudit({ username: "b", role: "admin", kind: "auth", action: "logout", status: "success" });

    expect(listAudit().map((entry) => entry.action)).toEqual(["logout", "login"]);
  });

  it("logs refusals too", () => {
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

  it("deletes entries past the retention window", () => {
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

  it("does not interrupt the action in progress when the write fails", () => {
    // Database closed: recordAudit must swallow the error, not propagate it.
    const db = useMemoryDatabase();
    db.close();
    setDb(db);

    expect(() =>
      recordAudit({ username: "a", role: "admin", kind: "rcon", action: "command", status: "error" }),
    ).not.toThrow();
  });
});

describe("raw commands and secrets", () => {
  beforeEach(() => {
    withEnv({ AUDIT_FULL_COMMANDS: undefined });
    useMemoryDatabase();
  });

  afterEach(() => {
    withEnv({ AUDIT_FULL_COMMANDS: undefined });
    resetEnvCache();
  });

  const raw = (command: string) =>
    recordAudit({ username: "admin", role: "admin", kind: "rcon", action: "command", command, status: "success" });

  it("does not copy a raw command in full", () => {
    // The feared case: a token pasted into the raw console would live on in the
    // database and in every one of its backups.
    raw('/c remote.call("api", "auth", "sk-live-0123456789abcdefghijklmnop")');

    const [entry] = listAudit();
    expect(entry.command).not.toContain("sk-live-0123456789abcdefghijklmnop");
    expect(entry.command?.endsWith("…")).toBe(true);
    expect(entry.command!.length).toBeLessThanOrEqual(RAW_COMMAND_PREVIEW + 1);
  });

  it("keeps a fingerprint that identifies the command", () => {
    const command = "/c game.print(1)";
    raw(command);

    const expected = `sha256:${createHash("sha256").update(command, "utf8").digest("hex")}`;
    expect(listAudit()[0].commandHash).toBe(expected);
  });

  it("leaves short commands readable as-is", () => {
    raw("/players online");

    expect(listAudit()[0].command).toBe("/players online");
  });

  it("keeps everything when the operator explicitly asks", () => {
    withEnv({ AUDIT_FULL_COMMANDS: "true" });
    const command = '/c remote.call("api", "auth", "sk-live-0123456789abcdefghijklmnop")';
    raw(command);

    expect(listAudit()[0].command).toBe(command);
  });

  it("leaves catalogue actions untouched", () => {
    // They are built by the server from validated fields: seeing the command
    // that was sent is precisely what the log is for.
    const command = '/c game.players["Edwins"].surface.find_entities_filtered({force = "enemy"})';
    recordAudit({
      username: "moderator",
      role: "moderator",
      kind: "action",
      action: "custom:kill-enemies",
      command,
      status: "success",
    });

    const [entry] = listAudit();
    expect(entry.command).toBe(command);
    expect(entry.commandHash).toBeNull();
  });
});
