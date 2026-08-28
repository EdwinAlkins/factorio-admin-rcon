import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/rcon", () => ({
  getRcon: () => ({
    execute: async (command: string) => ({ command, output: "", durationMs: 1 }),
    healthCheck: async () => ({ ok: true, latencyMs: 1 }),
  }),
  rconTarget: () => "factorio:27015",
  shutdownRcon: async () => undefined,
}));

const { POST: login } = await import("@/app/api/login/route");
const { POST: logout } = await import("@/app/api/logout/route");
const { POST: rcon } = await import("@/app/api/rcon/route");
const { POST: actions } = await import("@/app/api/actions/route");
const { GET: status } = await import("@/app/api/status/route");
const { resetEnvCache, useMemoryDatabase, withEnv } = await import("../helpers");
const { call, clearCookies, expectError, signIn, HOST, ORIGIN } = await import("../api/helpers");

/**
 * The cookie is `SameSite=Lax`, so a cross-site POST does not carry it in the
 * first place. The origin check is the second barrier, and the one that stays
 * valid if the cookie policy changes or the browser is old.
 */
const MUTATIONS = [
  { name: "login", handler: login, path: "/api/login", body: { password: "admin-pw" } },
  { name: "logout", handler: logout, path: "/api/logout", body: undefined },
  { name: "rcon", handler: rcon, path: "/api/rcon", body: { command: "/players" } },
  { name: "actions", handler: actions, path: "/api/actions", body: { action: "version" } },
];

beforeEach(() => {
  withEnv({ ADMIN_PASSWORD: "admin-pw", LOG_LEVEL: "error" });
  useMemoryDatabase();
  clearCookies();
});

afterEach(() => {
  withEnv({ ADMIN_PASSWORD: undefined, LOG_LEVEL: undefined });
  resetEnvCache();
});

describe("origin checking", () => {
  it.each(MUTATIONS)("refuses a foreign origin on /api/$name", async ({ handler, path, body }) => {
    signIn("admin");

    const result = await call(handler, {
      method: "POST",
      path,
      body,
      origin: "http://attaquant.example",
    });

    expectError(result, 403, "bad_origin");
  });

  it.each(MUTATIONS)("refuses an unparseable origin on /api/$name", async ({ handler, path, body }) => {
    signIn("admin");

    const result = await call(handler, { method: "POST", path, body, origin: "pas-une-url" });
    expectError(result, 403, "bad_origin");
  });

  it.each(MUTATIONS)("accepts the served host's origin on /api/$name", async ({ handler, path, body }) => {
    signIn("admin");

    const result = await call(handler, { method: "POST", path, body, origin: ORIGIN });
    expect(result.status).not.toBe(403);
  });

  it("refuses an origin that is only a prefix of the host", async () => {
    signIn("admin");

    // `panel.test.attaquant.example` must not pass for `panel.test`.
    const result = await call(logout, {
      method: "POST",
      path: "/api/logout",
      origin: `http://${HOST}.attaquant.example`,
    });

    expectError(result, 403, "bad_origin");
  });

  it("does not block reads: nothing is modified there", async () => {
    signIn("admin");

    const result = await call(status, { path: "/api/status", origin: "http://attaquant.example" });
    // A cross-site GET cannot read the response anyway (CORS).
    expect(result.status).not.toBe(403);
  });
});
