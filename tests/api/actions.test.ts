import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** RCON service driven by the test: no socket, no network dependency. */
const rcon = vi.hoisted(() => ({
  execute: null as null | ((command: string) => Promise<unknown>),
  commands: [] as string[],
}));

vi.mock("@/server/rcon", () => ({
  getRcon: () => ({
    execute: async (command: string) => {
      rcon.commands.push(command);
      if (rcon.execute) return rcon.execute(command);
      return { command, output: "ok", durationMs: 3 };
    },
    healthCheck: async () => ({ ok: true, latencyMs: 1 }),
  }),
  rconTarget: () => "factorio:27015",
  shutdownRcon: async () => undefined,
}));

const { GET: catalogue, POST: execute } = await import("@/app/api/actions/route");
const { RconError } = await import("@/server/rcon/errors");
const { listAudit } = await import("@/server/audit/service");
const { resetCustomCatalog } = await import("@/server/actions/custom");
const { resetEnvCache, useMemoryDatabase, withEnv } = await import("../helpers");
const { call, clearCookies, expectError, signIn } = await import("./helpers");

beforeEach(() => {
  withEnv({ ADMIN_PASSWORD: "admin-pw", LOG_LEVEL: "error", CUSTOM_COMMANDS_FILE: "/inexistant" });
  useMemoryDatabase();
  clearCookies();
  resetCustomCatalog();
  rcon.execute = null;
  rcon.commands = [];
});

afterEach(() => {
  withEnv({ ADMIN_PASSWORD: undefined, LOG_LEVEL: undefined, CUSTOM_COMMANDS_FILE: undefined });
  resetCustomCatalog();
  resetEnvCache();
});

const run = (body: unknown) => call(execute, { method: "POST", path: "/api/actions", body });

describe("GET /api/actions", () => {
  it("filters the catalogue by role", async () => {
    const idsFor = async (role: "viewer" | "moderator" | "admin") => {
      signIn(role);
      const result = await call(catalogue, { path: "/api/actions" });
      return (result.body.actions as { id: string }[]).map((action) => action.id);
    };

    const viewer = await idsFor("viewer");
    const moderator = await idsFor("moderator");
    const admin = await idsFor("admin");

    expect(viewer).toContain("players-online");
    expect(viewer).not.toContain("ban");
    expect(moderator).toContain("ban");
    expect(moderator).not.toContain("server-save");
    expect(admin).toContain("server-save");
    // Each role sees a superset of the previous one.
    expect(admin.length).toBeGreaterThan(moderator.length);
    expect(moderator.length).toBeGreaterThan(viewer.length);
  });

  it("requires a session", async () => {
    expectError(await call(catalogue, { path: "/api/actions" }), 401, "unauthenticated");
  });
});

describe("POST /api/actions", () => {
  it("builds the command server-side from the id", async () => {
    signIn("moderator");

    const result = await run({ action: "kick", values: { player: "bob", reason: "spam" } });

    expect(result.status).toBe(200);
    expect(rcon.commands).toEqual(["/kick bob spam"]);
  });

  it("refuses an action the role may not run", async () => {
    signIn("viewer");

    expectError(await run({ action: "ban", values: { player: "bob" } }), 403, "forbidden");
    // Nothing went out to RCON, and the refusal is logged.
    expect(rcon.commands).toEqual([]);
    expect(listAudit()[0]).toMatchObject({ action: "ban", status: "denied" });
  });

  it("refuses an unknown action", async () => {
    signIn("admin");
    expectError(await run({ action: "rm-rf", values: {} }), 404, "unknown_action");
  });

  it("validates the arguments before reaching RCON", async () => {
    signIn("moderator");

    // A line break would chain two commands on the socket.
    expectError(await run({ action: "kick", values: { player: "bob\n/promote bob" } }), 400, "validation_player");
    expectError(await run({ action: "kick", values: {} }), 400, "validation_required");
    // Undeclared field: the schema is closed.
    expectError(await run({ action: "players", values: { player: "bob" } }), 400, "invalid_arguments");

    expect(rcon.commands).toEqual([]);
  });

  it("refuses a malformed body", async () => {
    signIn("admin");
    expectError(await run({}), 400, "action_body_invalid");
    expectError(await call(execute, { method: "POST", raw: "{" }), 400, "action_body_invalid");
  });

  it("refuses a foreign origin before running anything", async () => {
    signIn("admin");

    const result = await call(execute, {
      method: "POST",
      body: { action: "server-save" },
      origin: "http://attaquant.example",
    });

    expectError(result, 403, "bad_origin");
    expect(rcon.commands).toEqual([]);
  });

  it("turns an RCON outage into a meaningful HTTP status", async () => {
    signIn("admin");
    rcon.execute = async () => {
      throw new RconError("connection_refused");
    };

    expectError(await run({ action: "version" }), 502, "connection_refused");
    expect(listAudit()[0]).toMatchObject({ action: "version", status: "error" });
  });

  it("answers 503 when the RCON queue is full", async () => {
    signIn("admin");
    rcon.execute = async () => {
      throw new RconError("backpressure");
    };

    expectError(await run({ action: "version" }), 503, "backpressure");
  });

  it("answers 503 while the panel is shutting down", async () => {
    signIn("admin");
    rcon.execute = async () => {
      throw new RconError("service_stopping");
    };

    expectError(await run({ action: "version" }), 503, "service_stopping");
  });

  it("limits the number of commands per session", async () => {
    withEnv({ ADMIN_PASSWORD: "admin-pw", RCON_MAX_PER_MINUTE: "2" });
    useMemoryDatabase();
    signIn("admin");

    expect((await run({ action: "version" })).status).toBe(200);
    expect((await run({ action: "version" })).status).toBe(200);
    expectError(await run({ action: "version" }), 429, "rate_limited_session");

    withEnv({ RCON_MAX_PER_MINUTE: undefined });
  });

  it("records the command that was actually sent", async () => {
    signIn("moderator");
    await run({ action: "ban", values: { player: "bob", reason: "grief" } });

    expect(listAudit()[0]).toMatchObject({
      kind: "action",
      action: "ban",
      command: "/ban bob grief",
      status: "success",
    });
  });
});
