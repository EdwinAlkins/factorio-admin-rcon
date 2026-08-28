import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSession,
  purgeExpiredSessions,
  revokeAllSessions,
  revokeSession,
  sessionIdFromToken,
  verifySessionToken,
} from "@/server/auth/session";
import { resetEnvCache, useMemoryDatabase, withEnv } from "../helpers";

const USER = { username: "admin", role: "admin" as const };

describe("sessions", () => {
  beforeEach(() => {
    withEnv({
      ADMIN_PASSWORD: "mot-de-passe-admin",
      SESSION_SECRET: "secret-de-test-suffisamment-long",
      MODERATOR_PASSWORD: undefined,
      VIEWER_PASSWORD: undefined,
    });
    useMemoryDatabase();
  });

  afterEach(() => {
    withEnv({ ADMIN_PASSWORD: undefined, SESSION_SECRET: "secret-de-test-suffisamment-long" });
    resetEnvCache();
  });

  it("creates a verifiable session", () => {
    const { token } = createSession(USER);
    const session = verifySessionToken(token);

    expect(session?.username).toBe("admin");
    expect(session?.role).toBe("admin");
  });

  it("rejects an absent or malformed cookie", () => {
    expect(verifySessionToken(undefined)).toBeNull();
    expect(verifySessionToken("")).toBeNull();
    expect(verifySessionToken("sans-point")).toBeNull();
  });

  it("rejects a forged signature", () => {
    const { token } = createSession(USER);
    const id = sessionIdFromToken(token);

    expect(verifySessionToken(`${id}.signature-bidon`)).toBeNull();
  });

  it("rejects an invented session id that is nonetheless well-formed", () => {
    // An attacker guessing a UUID without the HMAC key gets nothing.
    expect(verifySessionToken("00000000-0000-4000-8000-000000000000.AAAA")).toBeNull();
  });

  it("rejects an expired session", () => {
    const now = Date.now();
    const { token } = createSession(USER, now);

    expect(verifySessionToken(token, now + 13 * 60 * 60 * 1000)).toBeNull();
  });

  it("really revokes the session on sign-out", () => {
    const { token } = createSession(USER);
    expect(verifySessionToken(token)).not.toBeNull();

    revokeSession(sessionIdFromToken(token));

    // Same cookie, same signature: refused because state is authoritative.
    expect(verifySessionToken(token)).toBeNull();
  });

  it("allows cutting every session", () => {
    const first = createSession(USER).token;
    const second = createSession(USER).token;

    revokeAllSessions();

    expect(verifySessionToken(first)).toBeNull();
    expect(verifySessionToken(second)).toBeNull();
  });

  it("survives a password rotation", () => {
    // The signing key is independent from the passwords: changing one must no
    // longer sign everybody out. That is what the derived key did.
    withEnv({ ADMIN_PASSWORD: "premier-mot-de-passe" });
    const { token } = createSession(USER);
    expect(verifySessionToken(token)).not.toBeNull();

    withEnv({ ADMIN_PASSWORD: "second-mot-de-passe" });
    expect(verifySessionToken(token)).not.toBeNull();
  });

  it("invalidates sessions when the signing key changes", () => {
    const { token } = createSession(USER);
    expect(verifySessionToken(token)).not.toBeNull();

    withEnv({ SESSION_SECRET: "une-tout-autre-cle-de-signature-32" });
    expect(verifySessionToken(token)).toBeNull();
  });

  it("purges sessions expired for more than a day", () => {
    const db = useMemoryDatabase();
    const old = Date.now() - 15 * 24 * 60 * 60 * 1000;
    createSession(USER, old);

    purgeExpiredSessions();

    const remaining = db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
    expect(remaining.n).toBe(0);
  });
});
