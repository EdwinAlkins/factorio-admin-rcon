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
const { POST: serverStart } = await import("@/app/api/server/start/route");
const { POST: serverStop } = await import("@/app/api/server/stop/route");
const { POST: serverRestart } = await import("@/app/api/server/restart/route");
const { POST: savesCreate } = await import("@/app/api/saves/route");
const { PUT: savesSettings } = await import("@/app/api/saves/settings/route");
const { DELETE: savesDelete } = await import("@/app/api/saves/[id]/route");
const { POST: savesRestore } = await import("@/app/api/saves/[id]/restore/route");
const { POST: savesUpload } = await import("@/app/api/saves/uploads/route");
const savesUploadChunk = await import("@/app/api/saves/uploads/[uploadId]/route");
const { POST: savesUploadComplete } = await import("@/app/api/saves/uploads/[uploadId]/complete/route");
const { PUT: serverSettings } = await import("@/app/api/server-settings/route");
const { POST: modsPlan } = await import("@/app/api/mods/plan/route");
const { POST: modsApply } = await import("@/app/api/mods/apply/route");
const { resetEnvCache, useMemoryDatabase, withEnv } = await import("../helpers");
const { call, clearCookies, expectError, signIn, HOST, ORIGIN } = await import("../api/helpers");

/**
 * The cookie is `SameSite=Lax`, so a cross-site POST does not carry it in the
 * first place. The origin check is the second barrier, and the one that stays
 * valid if the cookie policy changes or the browser is old.
 */
type Mutation = {
  name: string;
  handler: (request: Request) => Promise<Response>;
  path: string;
  body: unknown;
  method?: string;
};

const MUTATIONS: Mutation[] = [
  { name: "login", handler: login, path: "/api/login", body: { password: "admin-pw" } },
  { name: "logout", handler: logout, path: "/api/logout", body: undefined },
  { name: "rcon", handler: rcon, path: "/api/rcon", body: { command: "/players" } },
  { name: "actions", handler: actions, path: "/api/actions", body: { action: "version" } },
  { name: "server/start", handler: serverStart, path: "/api/server/start", body: {} },
  { name: "server/stop", handler: serverStop, path: "/api/server/stop", body: {} },
  { name: "server/restart", handler: serverRestart, path: "/api/server/restart", body: {} },
  { name: "saves", handler: savesCreate, path: "/api/saves", body: {} },
  { name: "saves/settings", handler: savesSettings, path: "/api/saves/settings", body: {}, method: "PUT" },
  { name: "saves/[id]", handler: savesDelete, path: "/api/saves/20261027-100000-manual", body: undefined, method: "DELETE" },
  { name: "saves/[id]/restore", handler: savesRestore, path: "/api/saves/20261027-100000-manual/restore", body: {} },
  { name: "saves/uploads", handler: savesUpload, path: "/api/saves/uploads", body: {} },
  { name: "saves/uploads/[uploadId]", handler: savesUploadChunk.PUT, path: `/api/saves/uploads/${"a".repeat(32)}?offset=0`, body: {}, method: "PUT" },
  { name: "saves/uploads/[uploadId] (abort)", handler: savesUploadChunk.DELETE, path: `/api/saves/uploads/${"a".repeat(32)}`, body: undefined, method: "DELETE" },
  { name: "saves/uploads/[uploadId]/complete", handler: savesUploadComplete, path: `/api/saves/uploads/${"a".repeat(32)}/complete`, body: {} },
  { name: "server-settings", handler: serverSettings, path: "/api/server-settings", body: {}, method: "PUT" },
  { name: "mods/plan", handler: modsPlan, path: "/api/mods/plan", body: {} },
  { name: "mods/apply", handler: modsApply, path: "/api/mods/apply", body: {} },
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
  it.each(MUTATIONS)("refuses a foreign origin on /api/$name", async ({ handler, path, body, method = "POST" }) => {
    signIn("admin");

    const result = await call(handler, {
      method,
      path,
      body,
      origin: "http://attaquant.example",
    });

    expectError(result, 403, "bad_origin");
  });

  it.each(MUTATIONS)("refuses an unparseable origin on /api/$name", async ({ handler, path, body, method = "POST" }) => {
    signIn("admin");

    const result = await call(handler, { method, path, body, origin: "pas-une-url" });
    expectError(result, 403, "bad_origin");
  });

  it.each(MUTATIONS)("accepts the served host's origin on /api/$name", async ({ handler, path, body, method = "POST" }) => {
    signIn("admin");

    const result = await call(handler, { method, path, body, origin: ORIGIN });
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
