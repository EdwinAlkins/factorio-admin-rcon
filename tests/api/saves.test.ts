import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = await vi.hoisted(async () => (await import("../control/fakes")).createFakes());

vi.mock("@/server/control/client", () => fakes.clientModule);
vi.mock("@/server/data/client", () => fakes.dataModule);
vi.mock("@/server/rcon", () => fakes.rconModule);
vi.mock("@/server/rcon/status", () => fakes.statusModule);

const { container } = await import("../control/fakes");
const savesRoute = await import("@/app/api/saves/route");
const settingsRoute = await import("@/app/api/saves/settings/route");
const { DELETE: remove } = await import("@/app/api/saves/[id]/route");
const { POST: restore } = await import("@/app/api/saves/[id]/restore/route");
const { GET: download } = await import("@/app/api/saves/[id]/download/route");
const { currentOperation, requestOperation, timing, invalidateContainerCache } = await import("@/server/control/service");
const { listAudit } = await import("@/server/audit/service");
const { resetEnvCache, useMemoryDatabase, withEnv } = await import("../helpers");
const { call, clearCookies, expectError, signIn } = await import("./helpers");

const ID = "20261027-100000-manual";

beforeEach(() => {
  withEnv({ LOG_LEVEL: "error", SAVES_ENABLED: undefined });
  useMemoryDatabase();
  clearCookies();
  fakes.reset();
  invalidateContainerCache();
  Object.assign(timing, { savePollMs: 1, rconPollMs: 1, rconWaitMs: 50 });
});

afterEach(async () => {
  await currentOperation()?.done;
  withEnv({ LOG_LEVEL: undefined, SAVES_ENABLED: undefined });
  resetEnvCache();
});

describe("GET /api/saves", () => {
  it("shows archives to moderators, not to viewers", async () => {
    signIn("viewer");
    expectError(await call(savesRoute.GET, { path: "/api/saves" }), 403, "forbidden");

    clearCookies();
    signIn("moderator");
    const result = await call(savesRoute.GET, { path: "/api/saves" });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, backups: [{ id: ID }], settings: { enabled: false }, operation: null });
  });

  it("disappears with SAVES_ENABLED=false", async () => {
    withEnv({ SAVES_ENABLED: "false" });
    signIn("admin");
    expectError(await call(savesRoute.GET, { path: "/api/saves" }), 404, "data_disabled");
  });
});

describe("actions are for administrators", () => {
  it("refuses moderators everything but reading", async () => {
    signIn("moderator");
    expectError(await call(savesRoute.POST, { method: "POST", path: "/api/saves", body: {} }), 403, "forbidden");
    expectError(await call(restore, { method: "POST", path: `/api/saves/${ID}/restore`, body: {} }), 403, "forbidden");
    expectError(await call(remove, { method: "DELETE", path: `/api/saves/${ID}` }), 403, "forbidden");
    expectError(await call(download, { path: `/api/saves/${ID}/download` }), 403, "forbidden");
    expectError(
      await call(settingsRoute.PUT, { method: "PUT", path: "/api/saves/settings", body: {} }),
      403,
      "forbidden",
    );
    expect(fakes.calls).toEqual([]);
  });
});

describe("POST /api/saves", () => {
  it("takes a manual backup, saving first", async () => {
    signIn("admin");
    const result = await call(savesRoute.POST, { method: "POST", path: "/api/saves", body: { label: "before boss" } });
    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ operation: { type: "backup", status: "running" } });
    await currentOperation()?.done;
    expect(fakes.rcon.execute).toHaveBeenCalledWith("/server-save");
    expect(fakes.data.create).toHaveBeenCalledWith(expect.objectContaining({ label: "before boss", source: "manual" }));
  });

  it("refuses a malformed label", async () => {
    signIn("admin");
    for (const body of [{ label: "x".repeat(101) }, { label: "a\nb" }, { source: "scheduled" }]) {
      expectError(await call(savesRoute.POST, { method: "POST", path: "/api/saves", body }), 400, "invalid_body");
    }
  });
});

describe("archive ids", () => {
  it("are validated before reaching the agent", async () => {
    signIn("admin");
    for (const id of ["..%2F..%2Fetc", "20261027-100000-weekly", "x"]) {
      expectError(await call(download, { path: `/api/saves/${id}/download` }), 404, "backup_not_found");
      expectError(await call(remove, { method: "DELETE", path: `/api/saves/${id}` }), 404, "backup_not_found");
    }
    expect(fakes.calls).toEqual([]);
  });
});

describe("GET /api/saves/[id]/download", () => {
  it("streams the archive as an attachment, and audits it", async () => {
    signIn("admin");
    const result = await call(download, { path: `/api/saves/${ID}/download` });
    expect(result.status).toBe(200);
    expect(await result.response.text()).toBe("ZIPDATA");
    expect(result.response.headers.get("content-disposition")).toBe(`attachment; filename="factorio-${ID}.zip"`);
    expect(result.response.headers.get("x-content-sha256")).toBe("b".repeat(64));
    expect(listAudit()[0]).toMatchObject({ kind: "saves", action: "download", detail: ID });
  });
});

describe("POST /api/saves/[id]/restore", () => {
  it("answers 202, and forwards force", async () => {
    signIn("admin");
    fakes.rcon.players = 2;
    const refused = await call(restore, { method: "POST", path: `/api/saves/${ID}/restore`, body: {} });
    expectError(refused, 409, "players_online");

    const forced = await call(restore, { method: "POST", path: `/api/saves/${ID}/restore`, body: { force: true } });
    expect(forced.status).toBe(202);
    await currentOperation()?.done;
    expect(fakes.data.restore).toHaveBeenCalledWith(ID);
  });
});

describe("DELETE /api/saves/[id]", () => {
  it("is refused while an operation runs", async () => {
    signIn("admin");
    let release!: () => void;
    fakes.agent.stop.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve({ changed: true, container: container("exited") }))),
    );
    await requestOperation({ username: "admin", role: "admin", ip: null, requestId: "r", type: "stop", force: false });

    expectError(await call(remove, { method: "DELETE", path: `/api/saves/${ID}` }), 409, "operation_in_progress");
    expect(fakes.data.remove).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(fakes.agent.stop).toHaveBeenCalled());
    release();
    await currentOperation()?.done;

    expect((await call(remove, { method: "DELETE", path: `/api/saves/${ID}` })).status).toBe(200);
    expect(listAudit()[0]).toMatchObject({ action: "delete", status: "success", detail: ID });
  });
});

describe("PUT /api/saves/settings", () => {
  it("validates and audits the schedule", async () => {
    signIn("admin");
    const valid = { enabled: true, intervalMinutes: 30, keepLast: 10, maxAgeDays: 7, triggerSave: false };
    const result = await call(settingsRoute.PUT, { method: "PUT", path: "/api/saves/settings", body: valid });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ settings: { ...valid, lastRunAt: null } });
    expect(listAudit()[0]).toMatchObject({ action: "settings", status: "success" });

    for (const body of [
      { ...valid, intervalMinutes: 5 },
      { ...valid, keepLast: -1 },
      { ...valid, cron: "* * * * *" },
      { enabled: true },
    ]) {
      expectError(await call(settingsRoute.PUT, { method: "PUT", path: "/api/saves/settings", body }), 400, "invalid_body");
    }
  });
});
