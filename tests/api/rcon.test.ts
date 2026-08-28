import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rcon = vi.hoisted(() => ({
  execute: null as null | ((command: string) => Promise<unknown>),
  commands: [] as string[],
}));

vi.mock("@/server/rcon", () => ({
  getRcon: () => ({
    execute: async (command: string) => {
      rcon.commands.push(command);
      if (rcon.execute) return rcon.execute(command);
      return { command, output: "sortie", durationMs: 4 };
    },
    healthCheck: async () => ({ ok: true, latencyMs: 1 }),
  }),
  rconTarget: () => "factorio:27015",
  shutdownRcon: async () => undefined,
}));

const { POST: raw } = await import("@/app/api/rcon/route");
const { RconError } = await import("@/server/rcon/errors");
const { listAudit } = await import("@/server/audit/service");
const { MAX_BODY_BYTES } = await import("@/server/http/context");
const { resetEnvCache, useMemoryDatabase, withEnv } = await import("../helpers");
const { call, clearCookies, expectError, signIn } = await import("./helpers");

beforeEach(() => {
  withEnv({ ADMIN_PASSWORD: "admin-pw", LOG_LEVEL: "error" });
  useMemoryDatabase();
  clearCookies();
  rcon.execute = null;
  rcon.commands = [];
});

afterEach(() => {
  withEnv({ ADMIN_PASSWORD: undefined, LOG_LEVEL: undefined, AUDIT_FULL_COMMANDS: undefined });
  resetEnvCache();
});

const send = (body: unknown) => call(raw, { method: "POST", path: "/api/rcon", body });

describe("POST /api/rcon", () => {
  it("reserves the raw console for the role holding rcon:raw", async () => {
    for (const role of ["viewer", "moderator"] as const) {
      clearCookies();
      signIn(role);
      expectError(await send({ command: "/players" }), 403, "forbidden");
    }

    expect(rcon.commands).toEqual([]);

    clearCookies();
    signIn("admin");
    expect((await send({ command: "/players" })).status).toBe(200);
  });

  it("requires a session", async () => {
    expectError(await send({ command: "/players" }), 401, "unauthenticated");
  });

  it("refuses a foreign origin", async () => {
    signIn("admin");
    const result = await call(raw, {
      method: "POST",
      body: { command: "/server-save" },
      origin: "http://attaquant.example",
    });

    expectError(result, 403, "bad_origin");
    expect(rcon.commands).toEqual([]);
  });

  it("refuses a body larger than the limit, before parsing it", async () => {
    signIn("admin");

    const oversized = JSON.stringify({ command: "a".repeat(MAX_BODY_BYTES) });
    const result = await call(raw, { method: "POST", raw: oversized });

    expectError(result, 413, "body_too_large");
    expect(result.body.params).toMatchObject({ max: MAX_BODY_BYTES });
  });

  it("refuses a body with no command", async () => {
    signIn("admin");
    expectError(await send({}), 400, "command_missing");
    expectError(await send({ command: "" }), 400, "command_missing");
  });

  it("records only a prefix and a fingerprint of the command", async () => {
    signIn("admin");
    const secret = "sk-live-0123456789abcdefghijklmnopqrstuvwxyz";
    await send({ command: `/c remote.call("api", "auth", "${secret}")` });

    const [entry] = listAudit();
    expect(entry.command).not.toContain(secret);
    expect(entry.commandHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("keeps the whole command when the operator asked for it", async () => {
    withEnv({ ADMIN_PASSWORD: "admin-pw", AUDIT_FULL_COMMANDS: "true" });
    useMemoryDatabase();
    signIn("admin");

    const command = "/c game.print(1) -- une commande volontairement longue pour dépasser le préfixe";
    await send({ command });

    expect(listAudit()[0].command).toBe(command);
  });

  it("logs failed commands too", async () => {
    signIn("admin");
    rcon.execute = async () => {
      throw new RconError("timeout");
    };

    expectError(await send({ command: "/players" }), 504, "timeout");
    expect(listAudit()[0]).toMatchObject({ kind: "rcon", status: "error" });
  });

  it("recognises an RCON error from another copy of the module", async () => {
    signIn("admin");
    // Reproduces what `next dev` produces: the object carries the global symbol
    // registry's mark, but its class is not the one the route imports.
    rcon.execute = async () => {
      throw Object.assign(new Error("The Factorio server did not respond in time."), {
        [Symbol.for("factorio-admin.RconError")]: true,
        name: "RconError",
        key: "timeout",
        code: "timeout",
        detail: "host=factorio port=27015",
      });
    };

    // Without the guard, the wrapper answered 500 "internal".
    expectError(await send({ command: "/players" }), 504, "timeout");
  });

  it("logs a rate-limit refusal without running the command", async () => {
    withEnv({ ADMIN_PASSWORD: "admin-pw", RCON_MAX_PER_MINUTE: "1" });
    useMemoryDatabase();
    signIn("admin");

    expect((await send({ command: "/players" })).status).toBe(200);
    expectError(await send({ command: "/version" }), 429, "rate_limited_session");

    expect(rcon.commands).toEqual(["/players"]);
    expect(listAudit()[0]).toMatchObject({ status: "denied", detail: "rate limit" });
    withEnv({ RCON_MAX_PER_MINUTE: undefined });
  });
});