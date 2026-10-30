import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = await vi.hoisted(async () => (await import("../control/fakes")).createFakes());

vi.mock("@/server/control/client", () => fakes.clientModule);
vi.mock("@/server/rcon", () => fakes.rconModule);
vi.mock("@/server/rcon/status", () => fakes.statusModule);

const { container } = await import("../control/fakes");
const { GET: server } = await import("@/app/api/server/route");
const { GET: logs } = await import("@/app/api/server/logs/route");
const { POST: start } = await import("@/app/api/server/start/route");
const { POST: stop } = await import("@/app/api/server/stop/route");
const { POST: restart } = await import("@/app/api/server/restart/route");
const { currentOperation, invalidateContainerCache, timing } = await import("@/server/control/service");
const { AgentError } = await import("@/server/agents/errors");
const { SERVER_OPERATIONS_PER_MINUTE } = await import("@/server/auth/limiters");
const { listAudit } = await import("@/server/audit/service");
const { resetEnvCache, useMemoryDatabase, withEnv } = await import("../helpers");
const { call, clearCookies, expectError, signIn } = await import("./helpers");

const MUTATIONS = [
  { name: "start", handler: start, path: "/api/server/start" },
  { name: "stop", handler: stop, path: "/api/server/stop" },
  { name: "restart", handler: restart, path: "/api/server/restart" },
] as const;

beforeEach(() => {
  withEnv({ LOG_LEVEL: "error", CONTROL_ENABLED: undefined });
  useMemoryDatabase();
  clearCookies();
  fakes.reset();
  invalidateContainerCache();
  Object.assign(timing, { savePollMs: 1, rconPollMs: 1, rconWaitMs: 50 });
});

afterEach(async () => {
  await currentOperation()?.done;
  withEnv({ LOG_LEVEL: undefined, CONTROL_ENABLED: undefined });
  resetEnvCache();
});

describe("GET /api/server", () => {
  it("is open to every role", async () => {
    for (const role of ["viewer", "moderator", "admin"] as const) {
      clearCookies();
      signIn(role);
      const result = await call(server, { path: "/api/server" });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        ok: true,
        state: "running",
        container: { state: "running" },
        rcon: { ok: true, count: 0, version: "2.0.72" },
        operation: null,
      });
    }
  });

  it("reports an unreachable agent as a state, not an error", async () => {
    signIn("viewer");
    fakes.agent.status.mockImplementation(async () => {
      throw new AgentError("control_unreachable");
    });

    const result = await call(server, { path: "/api/server" });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ state: "unknown", container: null, controlError: "control_unreachable" });
  });

  it("does not probe RCON when the container is stopped", async () => {
    signIn("viewer");
    fakes.agent.status.mockImplementation(async () => container("exited"));
    fakes.rcon.players = new Error("must not be called");

    const result = await call(server, { path: "/api/server" });
    expect(result.body).toMatchObject({ state: "stopped", rcon: { ok: false } });
  });

  it("disappears with CONTROL_ENABLED=false", async () => {
    withEnv({ CONTROL_ENABLED: "false" });
    signIn("admin");

    expectError(await call(server, { path: "/api/server" }), 404, "control_disabled");
    expectError(await call(stop, { method: "POST", path: "/api/server/stop", body: {} }), 404, "control_disabled");
  });
});

describe("GET /api/server/logs", () => {
  it("is reserved to administrators: logs carry player names and IPs", async () => {
    for (const role of ["viewer", "moderator"] as const) {
      clearCookies();
      signIn(role);
      expectError(await call(logs, { path: "/api/server/logs" }), 403, "forbidden");
    }
    expect(fakes.agent.logs).not.toHaveBeenCalled();

    clearCookies();
    signIn("admin");
    const result = await call(logs, { path: "/api/server/logs?tail=50" });
    expect(result.status).toBe(200);
    expect((result.body.lines as unknown[]).length).toBe(1);
  });

  it("bounds the number of lines", async () => {
    signIn("admin");
    for (const tail of ["0", "1001", "abc", "1.5"]) {
      expectError(await call(logs, { path: `/api/server/logs?tail=${tail}` }), 400, "invalid_tail");
    }
  });
});

describe("POST /api/server/{start,stop,restart}", () => {
  it.each(MUTATIONS)("reserves $name to administrators", async ({ handler, path }) => {
    for (const role of ["viewer", "moderator"] as const) {
      clearCookies();
      signIn(role);
      expectError(await call(handler, { method: "POST", path, body: {} }), 403, "forbidden");
    }
    expect(fakes.agent.status).not.toHaveBeenCalled();
  });

  it("answers 202 with the operation, which then completes", async () => {
    signIn("admin");

    const result = await call(stop, { method: "POST", path: "/api/server/stop", body: {} });
    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ ok: true, operation: { type: "stop", status: "running", username: "admin" } });

    await currentOperation()?.done;
    expect(listAudit()[0]).toMatchObject({ kind: "server", action: "stop", status: "success" });
  });

  it("accepts an empty body", async () => {
    signIn("admin");
    const result = await call(stop, { method: "POST", path: "/api/server/stop" });
    expect(result.status).toBe(202);
  });

  it("refuses a malformed body", async () => {
    signIn("admin");
    for (const body of [{ force: "yes" }, { force: true, container: "panel" }]) {
      expectError(await call(stop, { method: "POST", path: "/api/server/stop", body }), 400, "invalid_body");
    }
    expect(fakes.agent.stop).not.toHaveBeenCalled();
  });

  it("passes the players check through to the client, then honours force", async () => {
    signIn("admin");
    fakes.rcon.players = 3;

    const refused = await call(stop, { method: "POST", path: "/api/server/stop", body: {} });
    expectError(refused, 409, "players_online");
    expect(refused.body.params).toEqual({ count: 3 });

    const forced = await call(stop, { method: "POST", path: "/api/server/stop", body: { force: true } });
    expect(forced.status).toBe(202);
  });

  it("translates agent failures", async () => {
    signIn("admin");
    fakes.agent.status.mockImplementation(async () => {
      throw new AgentError("control_target_ambiguous");
    });

    expectError(await call(stop, { method: "POST", path: "/api/server/stop", body: {} }), 503, "control_target_ambiguous");
  });

  it("rate limits operations per session", async () => {
    signIn("admin");
    // Refused by the state check (already running), but each call still counts.
    for (let i = 0; i < SERVER_OPERATIONS_PER_MINUTE; i++) {
      expectError(await call(start, { method: "POST", path: "/api/server/start", body: {} }), 409, "server_already_running");
    }

    const limited = await call(start, { method: "POST", path: "/api/server/start", body: {} });
    expectError(limited, 429, "rate_limited_session");
    expect(limited.response.headers.get("retry-after")).not.toBeNull();
  });
});
