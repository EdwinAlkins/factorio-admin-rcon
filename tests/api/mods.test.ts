import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = await vi.hoisted(async () => (await import("../control/fakes")).createFakes());

vi.mock("@/server/control/client", () => fakes.clientModule);
vi.mock("@/server/data/client", () => fakes.dataModule);
vi.mock("@/server/rcon", () => fakes.rconModule);
vi.mock("@/server/rcon/status", () => fakes.statusModule);

const { PLAN_HASH } = await import("../control/fakes");
const modsRoute = await import("@/app/api/mods/route");
const { GET: search } = await import("@/app/api/mods/search/route");
const { GET: details } = await import("@/app/api/mods/portal/[name]/route");
const { POST: plan } = await import("@/app/api/mods/plan/route");
const { POST: apply } = await import("@/app/api/mods/apply/route");
const { currentOperation, timing, invalidateContainerCache } = await import("@/server/control/service");
const { listAudit } = await import("@/server/audit/service");
const { resetFactorioVersionMemory } = await import("@/server/factorio-version");
const { resetEnvCache, useMemoryDatabase, withEnv } = await import("../helpers");
const { call, clearCookies, expectError, signIn } = await import("./helpers");

const basket = { changes: [{ action: "install", name: "flib" }] };

beforeEach(() => {
  withEnv({ LOG_LEVEL: "error", MODS_ENABLED: undefined });
  useMemoryDatabase();
  resetFactorioVersionMemory();
  clearCookies();
  fakes.reset();
  invalidateContainerCache();
  Object.assign(timing, { savePollMs: 1, rconPollMs: 1, rconWaitMs: 50 });
});

afterEach(async () => {
  await currentOperation()?.done;
  withEnv({ LOG_LEVEL: undefined, MODS_ENABLED: undefined });
  resetEnvCache();
});

describe("GET /api/mods", () => {
  it("is open to every role", async () => {
    signIn("viewer");
    const result = await call(modsRoute.GET, { path: "/api/mods" });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, factorioVersion: "2.0.72", credentials: true, operation: null });
  });

  it("disappears with MODS_ENABLED=false", async () => {
    withEnv({ MODS_ENABLED: "false" });
    signIn("admin");
    expectError(await call(modsRoute.GET, { path: "/api/mods" }), 404, "mods_disabled");
  });
});

describe("changing mods is for administrators", () => {
  it("refuses moderators the portal and every change", async () => {
    signIn("moderator");
    expectError(await call(search, { path: "/api/mods/search?q=flib" }), 403, "forbidden");
    expectError(await call(details, { path: "/api/mods/portal/flib" }), 403, "forbidden");
    expectError(await call(plan, { method: "POST", path: "/api/mods/plan", body: basket }), 403, "forbidden");
    expectError(
      await call(apply, { method: "POST", path: "/api/mods/apply", body: { ...basket, planHash: PLAN_HASH } }),
      403,
      "forbidden",
    );
    expect(fakes.calls).toEqual([]);
  });
});

describe("POST /api/mods/plan", () => {
  it("previews a basket for the game's version", async () => {
    signIn("admin");
    const result = await call(plan, { method: "POST", path: "/api/mods/plan", body: basket });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, plan: { hash: PLAN_HASH } });
    expect(fakes.data.modsPlan).toHaveBeenCalledWith(basket.changes, "2.0.72");
  });

  it("validates the basket before it reaches the agent", async () => {
    signIn("admin");
    for (const body of [
      {},
      { changes: [] },
      { changes: [{ action: "format", name: "flib" }] },
      { changes: [{ action: "install", name: "../../etc" }] },
      { changes: [{ action: "install", name: "flib", url: "https://evil.example/x.zip" }] },
      { changes: [{ action: "install", name: "flib", version: "latest" }] },
    ]) {
      expectError(await call(plan, { method: "POST", path: "/api/mods/plan", body }), 400, "invalid_body");
    }
    expect(fakes.data.modsPlan).not.toHaveBeenCalled();
  });
});

describe("POST /api/mods/apply", () => {
  it("answers 202 and audits the outcome", async () => {
    signIn("admin");
    const result = await call(apply, { method: "POST", path: "/api/mods/apply", body: { ...basket, planHash: PLAN_HASH } });
    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ ok: true, operation: { type: "mods_apply" } });
    await currentOperation()?.done;
    expect(listAudit()[0]).toMatchObject({ kind: "mods", action: "mods_apply", status: "success", username: "admin" });
  });

  it("requires the hash of the confirmed plan", async () => {
    signIn("admin");
    for (const planHash of [undefined, "short", "Z".repeat(64)]) {
      expectError(
        await call(apply, { method: "POST", path: "/api/mods/apply", body: { ...basket, planHash } }),
        400,
        "invalid_body",
      );
    }
  });
});

describe("GET /api/mods/portal/[name]", () => {
  it("validates the name from the path", async () => {
    signIn("admin");
    expectError(await call(details, { path: "/api/mods/portal/..%2F..%2Fetc" }), 404, "mod_not_found");
    const result = await call(details, { path: "/api/mods/portal/Even%20Distribution" });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ mod: { name: "Even Distribution" } });
  });
});

describe("GET /api/mods/search", () => {
  it("bounds the query", async () => {
    signIn("admin");
    expectError(await call(search, { path: `/api/mods/search?q=${"x".repeat(101)}` }), 400, "invalid_body");
    expectError(await call(search, { path: "/api/mods/search?q=x&page=0" }), 400, "invalid_body");
    expect((await call(search, { path: "/api/mods/search?q=flib" })).status).toBe(200);
  });
});
