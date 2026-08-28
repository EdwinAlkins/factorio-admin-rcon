import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rcon = vi.hoisted(() => ({ healthy: true }));

vi.mock("@/server/rcon", () => ({
  getRcon: () => ({
    execute: async (command: string) => ({ command, output: "", durationMs: 1 }),
    healthCheck: async () =>
      rcon.healthy
        ? { ok: true, latencyMs: 1 }
        : { ok: false, error: { code: "connection", detail: "injoignable" } },
  }),
  rconTarget: () => "factorio:27015",
  shutdownRcon: async () => undefined,
}));

const { GET: health } = await import("@/app/api/health/route");
const { GET: ready } = await import("@/app/api/ready/route");
const { GET: audit } = await import("@/app/api/audit/route");
const { GET: metrics } = await import("@/app/api/metrics/route");
const { recordAudit } = await import("@/server/audit/service");
const { resetCustomCatalog } = await import("@/server/actions/custom");
const { resetEnvCache, useMemoryDatabase, withEnv } = await import("../helpers");
const { call, clearCookies, expectError, signIn } = await import("./helpers");

type Check = { name: string; ok: boolean };

beforeEach(() => {
  withEnv({ ADMIN_PASSWORD: "admin-pw", LOG_LEVEL: "error", CUSTOM_COMMANDS_FILE: "/inexistant" });
  useMemoryDatabase();
  clearCookies();
  resetCustomCatalog();
  rcon.healthy = true;
});

afterEach(() => {
  withEnv({
    ADMIN_PASSWORD: undefined,
    LOG_LEVEL: undefined,
    CUSTOM_COMMANDS_FILE: undefined,
    METRICS_ENABLED: undefined,
  });
  resetCustomCatalog();
  resetEnvCache();
});

describe("probes", () => {
  it("answers /api/health without a session", async () => {
    const result = await call(health, { path: "/api/health" });
    expect(result.status).toBe(200);
  });

  it("tells readiness from liveness when Factorio goes down", async () => {
    rcon.healthy = false;

    const result = await call(ready, { path: "/api/ready" });
    expect(result.status).toBe(503);

    const checks = result.body.checks as Check[];
    // The panel itself is fine: it is the dependency that is missing. Without
    // this distinction the orchestrator would restart the panel in a loop.
    expect(checks.find((check) => check.name === "rcon")).toMatchObject({ ok: false });
    expect(checks.find((check) => check.name === "database")).toMatchObject({ ok: true });
    expect(checks.find((check) => check.name === "config")).toMatchObject({ ok: true });
    expect((await call(health, { path: "/api/health" })).status).toBe(200);
  });

  it("reports an unreadable command catalogue", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const file = join(mkdtempSync(join(tmpdir(), "commands-")), "commands.json");
    writeFileSync(file, "{ pas du json", "utf8");
    withEnv({ ADMIN_PASSWORD: "admin-pw", LOG_LEVEL: "error", CUSTOM_COMMANDS_FILE: file });
    resetCustomCatalog();

    const checks = (await call(ready, { path: "/api/ready" })).body.checks as Check[];
    expect(checks.find((check) => check.name === "commands")).toMatchObject({ ok: false });
  });
});

describe("GET /api/audit", () => {
  it("is reserved for the role holding audit:read", async () => {
    for (const role of ["viewer", "moderator"] as const) {
      clearCookies();
      signIn(role);
      expectError(await call(audit, { path: "/api/audit" }), 403, "forbidden");
    }
  });

  it("returns the most recent entries first", async () => {
    signIn("admin");
    recordAudit({ username: "a", role: "admin", kind: "auth", action: "login", status: "success" });
    recordAudit({ username: "b", role: "admin", kind: "auth", action: "logout", status: "success" });

    const entries = (await call(audit, { path: "/api/audit" })).body.entries as { action: string }[];
    expect(entries.map((entry) => entry.action)).toEqual(["logout", "login"]);
  });

  it("clamps the requested limit", async () => {
    signIn("admin");
    for (let i = 0; i < 5; i++) {
      recordAudit({ username: "a", role: "admin", kind: "auth", action: `a${i}`, status: "success" });
    }

    const withLimit = async (query: string) =>
      ((await call(audit, { path: `/api/audit${query}` })).body.entries as unknown[]).length;

    expect(await withLimit("?limit=2")).toBe(2);
    // Absurd values clamped rather than passed through to SQLite.
    expect(await withLimit("?limit=-3")).toBe(1);
    expect(await withLimit("?limit=abc")).toBe(5);
  });
});

describe("GET /api/metrics", () => {
  it("does not exist when the feature is off", async () => {
    withEnv({ ADMIN_PASSWORD: "admin-pw", METRICS_ENABLED: "false" });
    signIn("admin");

    expectError(await call(metrics, { path: "/api/metrics" }), 404, "metrics_disabled");
  });

  it("is open to all three roles when it is on", async () => {
    withEnv({ ADMIN_PASSWORD: "admin-pw", METRICS_ENABLED: "true" });
    useMemoryDatabase();

    for (const role of ["viewer", "moderator", "admin"] as const) {
      clearCookies();
      signIn(role);
      expect((await call(metrics, { path: "/api/metrics" })).status).toBe(200);
    }
  });

  it("falls back to a default range when the requested one is unknown", async () => {
    withEnv({ ADMIN_PASSWORD: "admin-pw", METRICS_ENABLED: "true" });
    useMemoryDatabase();
    signIn("admin");

    const result = await call(metrics, { path: "/api/metrics?range=un-siecle" });
    expect(result.body.range).toBe("6h");
  });
});
