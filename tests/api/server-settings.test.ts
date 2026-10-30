import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = await vi.hoisted(async () => (await import("../control/fakes")).createFakes());

vi.mock("@/server/control/client", () => fakes.clientModule);
vi.mock("@/server/data/client", () => fakes.dataModule);
vi.mock("@/server/rcon", () => fakes.rconModule);
vi.mock("@/server/rcon/status", () => fakes.statusModule);

const { container, SETTINGS_HASH } = await import("../control/fakes");
const settingsRoute = await import("@/app/api/server-settings/route");
const { currentOperation, timing, invalidateContainerCache } = await import("@/server/control/service");
const { getOperation } = await import("@/server/operations/store");
const { AgentError } = await import("@/server/agents/errors");
const { listAudit } = await import("@/server/audit/service");
const { resetEnvCache, useMemoryDatabase, withEnv } = await import("../helpers");
const { call, clearCookies, expectError, signIn } = await import("./helpers");

const defaults = { ...timing };

function put(body: unknown) {
  return call(settingsRoute.PUT, { method: "PUT", path: "/api/server-settings", body });
}

async function finish(result: { body: Record<string, unknown> }) {
  await currentOperation()?.done;
  return getOperation((result.body.operation as { id: number }).id)!;
}

beforeEach(() => {
  withEnv({ LOG_LEVEL: "error", SAVES_ENABLED: undefined, MODS_ENABLED: undefined });
  useMemoryDatabase();
  clearCookies();
  fakes.reset();
  invalidateContainerCache();
  Object.assign(timing, { savePollMs: 1, rconPollMs: 1, rconWaitMs: 50 });
});

afterEach(async () => {
  await currentOperation()?.done;
  Object.assign(timing, defaults);
  withEnv({ LOG_LEVEL: undefined, SAVES_ENABLED: undefined, MODS_ENABLED: undefined });
  resetEnvCache();
});

describe("GET /api/server-settings", () => {
  it("is for administrators only", async () => {
    signIn("moderator");
    expectError(await call(settingsRoute.GET, { path: "/api/server-settings" }), 403, "forbidden");

    clearCookies();
    signIn("admin");
    const result = await call(settingsRoute.GET, { path: "/api/server-settings" });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, hash: SETTINGS_HASH, secrets: { game_password: true }, operation: null });
  });

  it("disappears with the data agent", async () => {
    withEnv({ SAVES_ENABLED: "false", MODS_ENABLED: "false" });
    signIn("admin");
    expectError(await call(settingsRoute.GET, { path: "/api/server-settings" }), 404, "data_disabled");
  });
});

describe("PUT /api/server-settings", () => {
  it("writes for the next start without touching the server, and audits the keys only", async () => {
    signIn("admin");
    const result = await put({
      settings: { name: "New name", max_players: 8 },
      secrets: { game_password: { set: "hunter2" } },
      hash: SETTINGS_HASH,
      restart: false,
    });
    expect(result.status).toBe(200);
    expect(fakes.calls).toEqual(["data.settingsUpdate"]);
    expect(fakes.data.settingsUpdate).toHaveBeenCalledWith({
      settings: { name: "New name", max_players: 8 },
      secrets: { game_password: { set: "hunter2" } },
      hash: SETTINGS_HASH,
    });
    const entry = listAudit()[0]!;
    expect(entry).toMatchObject({ kind: "server", action: "server_settings", status: "success" });
    expect(entry.detail).toContain("name max_players game_password:set");
    expect(JSON.stringify(listAudit())).not.toContain("hunter2");
  });

  it("refuses invalid changes before reaching the agent", async () => {
    signIn("admin");
    for (const body of [
      { settings: {}, secrets: {}, hash: SETTINGS_HASH, restart: false },
      { settings: { max_players: 8 }, hash: "x", restart: false },
      { settings: { rcon_password: "x" }, hash: SETTINGS_HASH, restart: false },
      { settings: { token: "x" }, hash: SETTINGS_HASH, restart: false },
      { settings: { max_players: -1 }, hash: SETTINGS_HASH, restart: false },
      { settings: { max_heartbeats_per_second: 500 }, hash: SETTINGS_HASH, restart: false },
      { settings: { name: "a\nb" }, hash: SETTINGS_HASH, restart: false },
      { settings: { allow_commands: "sometimes" }, hash: SETTINGS_HASH, restart: false },
      { settings: { visibility: {} }, hash: SETTINGS_HASH, restart: false },
      { secrets: { rconpw: { clear: true } }, hash: SETTINGS_HASH, restart: false },
      { secrets: { token: { set: "" } }, hash: SETTINGS_HASH, restart: false },
      { secrets: { token: { set: "x", clear: true } }, hash: SETTINGS_HASH, restart: false },
      { settings: { max_players: 8 }, hash: SETTINGS_HASH },
    ]) {
      expectError(await put(body), 400, "invalid_body");
    }
    expect(fakes.calls).toEqual([]);
  });

  it("restarts the server once written, saving first", async () => {
    signIn("admin");
    const result = await put({ settings: { max_players: 8 }, hash: SETTINGS_HASH, restart: true });
    expect(result.status).toBe(202);
    expect((await finish(result)).status).toBe("success");
    expect(fakes.calls).toEqual([
      "data.settings",
      "agent.status",
      "data.settingsUpdate",
      "rcon:/server-save",
      "agent.logs",
      "agent.restart",
      "rcon.disconnect",
    ]);
    expect(listAudit()[0]).toMatchObject({ action: "server_settings_apply", status: "success" });
  });

  it("only writes when the server is stopped", async () => {
    fakes.agent.status.mockImplementation(async () => container("exited"));
    signIn("admin");
    const result = await put({ settings: { max_players: 8 }, hash: SETTINGS_HASH, restart: true });
    expect((await finish(result)).status).toBe("success");
    expect(fakes.calls).toEqual(["data.settings", "agent.status", "data.settingsUpdate"]);
  });

  it("refuses a stale hash before stopping anything", async () => {
    signIn("admin");
    expectError(await put({ settings: { max_players: 8 }, hash: "d".repeat(64), restart: true }), 409, "settings_changed");
    expect(fakes.data.settingsUpdate).not.toHaveBeenCalled();
  });

  it("puts the previous file back when the server does not come back", async () => {
    let restarts = 0;
    fakes.agent.restart.mockImplementation(async () => {
      restarts += 1;
      if (restarts === 1) throw new AgentError("control_docker");
      return { changed: true, container: container("running") };
    });
    signIn("admin");
    const result = await put({ settings: { max_players: 8 }, hash: SETTINGS_HASH, restart: true });
    const operation = await finish(result);
    expect(operation).toMatchObject({ status: "error", errorCode: "settings_rolled_back" });
    expect(fakes.data.settingsRollback).toHaveBeenCalledWith("tx-cccc");
  });
});
