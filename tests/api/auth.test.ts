import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/login/route";
import { POST as logout } from "@/app/api/logout/route";
import { GET as status } from "@/app/api/status/route";
import { revokeSession, sessionIdFromToken } from "@/server/auth/session";
import { listAudit } from "@/server/audit/service";
import { SESSION_COOKIE } from "@/lib/session-cookie";
import { resetEnvCache, useMemoryDatabase, withEnv } from "../helpers";
import { call, clearCookies, cookieJar, expectError, ORIGIN, setCookie, signIn } from "./helpers";

const PASSWORDS = {
  ADMIN_PASSWORD: "mot-de-passe-admin",
  MODERATOR_PASSWORD: "mot-de-passe-moderateur",
  VIEWER_PASSWORD: "mot-de-passe-viewer",
};

beforeEach(() => {
  withEnv({ ...PASSWORDS, TRUST_PROXY: undefined, LOG_LEVEL: "error" });
  useMemoryDatabase();
  clearCookies();
});

afterEach(() => {
  withEnv({
    ADMIN_PASSWORD: undefined,
    MODERATOR_PASSWORD: undefined,
    VIEWER_PASSWORD: undefined,
    LOG_LEVEL: undefined,
  });
  resetEnvCache();
});

const signInAs = (password: string, extra = {}) =>
  call(login, { method: "POST", path: "/api/login", body: { password }, ...extra });

describe("POST /api/login", () => {
  it("opens a session and sets a hardened cookie", async () => {
    const result = await signInAs(PASSWORDS.MODERATOR_PASSWORD);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, username: "moderator", role: "moderator" });

    const cookie = cookieJar().get(SESSION_COOKIE)!;
    expect(cookie.value).toContain(".");
    expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
  });

  it("refuses a wrong password without revealing which account exists", async () => {
    const result = await signInAs("pas-le-bon");

    expectError(result, 401, "bad_credentials");
    expect(cookieJar().has(SESSION_COOKIE)).toBe(false);
    // The refusal leaves a trace, without the password that was tried.
    const [entry] = listAudit();
    expect(entry).toMatchObject({ kind: "auth", action: "login", status: "denied" });
    expect(JSON.stringify(entry)).not.toContain("pas-le-bon");
  });

  it("refuses a body with no password", async () => {
    expectError(await call(login, { method: "POST", body: {} }), 400, "password_missing");
    expectError(await call(login, { method: "POST", raw: "pas du json" }), 400, "password_missing");
  });

  it("answers explicitly when no account is configured", async () => {
    withEnv({ ADMIN_PASSWORD: undefined, MODERATOR_PASSWORD: undefined, VIEWER_PASSWORD: undefined });

    expectError(await signInAs("peu importe"), 500, "no_account");
  });

  it("limits attempts globally, even without a trustworthy IP", async () => {
    withEnv({ ...PASSWORDS, LOGIN_GLOBAL_MAX_ATTEMPTS: "3" });

    for (let attempt = 0; attempt < 3; attempt++) {
      expectError(await signInAs("faux"), 401, "bad_credentials");
    }

    const blocked = await signInAs("faux");
    expectError(blocked, 429, "rate_limited_panel");
    expect(blocked.response.headers.get("retry-after")).not.toBeNull();

    // The correct password does not bypass the limit.
    expectError(await signInAs(PASSWORDS.ADMIN_PASSWORD), 429, "rate_limited_panel");
    withEnv({ LOGIN_GLOBAL_MAX_ATTEMPTS: undefined });
  });

  it("limits per IP when the proxy is trusted", async () => {
    withEnv({ ...PASSWORDS, TRUST_PROXY: "true", LOGIN_MAX_ATTEMPTS: "2" });

    const from = (ip: string) =>
      signInAs("faux", { headers: { "x-forwarded-for": ip } });

    expectError(await from("10.0.0.1"), 401, "bad_credentials");
    expectError(await from("10.0.0.1"), 401, "bad_credentials");
    expectError(await from("10.0.0.1"), 429, "rate_limited_ip");
    // Another IP keeps its own counter.
    expectError(await from("10.0.0.2"), 401, "bad_credentials");

    withEnv({ TRUST_PROXY: undefined, LOGIN_MAX_ATTEMPTS: undefined });
  });
});

describe("session", () => {
  it("refuses a request with no cookie", async () => {
    expectError(await call(status, { path: "/api/status" }), 401, "unauthenticated");
  });

  it("refuses a cookie whose signature does not match", async () => {
    const token = signIn("admin");
    const [id] = token.split(".");

    // Signature rewritten: the id does exist in the database, though.
    setCookie(`${id}.signature-forgee`);
    expectError(await call(status, { path: "/api/status" }), 401, "unauthenticated");

    // Id rewritten, original signature.
    setCookie(`00000000-0000-4000-8000-000000000000.${token.split(".")[1]}`);
    expectError(await call(status, { path: "/api/status" }), 401, "unauthenticated");
  });

  it("refuses a revoked session", async () => {
    const token = signIn("admin");
    revokeSession(sessionIdFromToken(token)!);

    expectError(await call(status, { path: "/api/status" }), 401, "unauthenticated");
  });

  it("refuses an expired session", async () => {
    withEnv({ ...PASSWORDS, SESSION_TTL_HOURS: "1" });
    const db = useMemoryDatabase();
    const token = signIn("admin");
    const [id] = token.split(".");
    db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, id);

    expectError(await call(status, { path: "/api/status" }), 401, "unauthenticated");
    withEnv({ SESSION_TTL_HOURS: undefined });
  });
});

describe("POST /api/logout", () => {
  it("revokes the session and clears the cookie", async () => {
    const token = signIn("admin");

    const result = await call(logout, { method: "POST", path: "/api/logout" });
    expect(result.status).toBe(200);
    expect(cookieJar().get(SESSION_COOKIE)!.value).toBe("");

    // A cookie stolen before signing out is now useless.
    setCookie(token);
    expectError(await call(status, { path: "/api/status" }), 401, "unauthenticated");
  });

  it("stays harmless without a session", async () => {
    expectError(await call(logout, { method: "POST", path: "/api/logout" }), 401, "unauthenticated");
  });

  it("refuses a foreign origin", async () => {
    signIn("admin");
    const result = await call(logout, {
      method: "POST",
      path: "/api/logout",
      origin: "http://attaquant.example",
    });

    expectError(result, 403, "bad_origin");
    // The session is intact: nothing was executed.
    expect(await call(status, { path: "/api/status" }).then((r) => r.status)).not.toBe(401);
  });

  it("lets a call with no origin through (curl, probes)", async () => {
    signIn("admin");
    const result = await call(logout, { method: "POST", path: "/api/logout", origin: null });
    expect(result.status).toBe(200);
  });
});

describe("origin of mutating requests", () => {
  it("compares the origin against the served host, not a list", async () => {
    const ok = await call(login, {
      method: "POST",
      body: { password: PASSWORDS.ADMIN_PASSWORD },
      origin: ORIGIN,
    });
    expect(ok.status).toBe(200);
  });
});
