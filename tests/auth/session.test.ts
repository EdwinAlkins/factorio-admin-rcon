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
    withEnv({ ADMIN_PASSWORD: undefined, SESSION_SECRET: undefined });
    resetEnvCache();
  });

  it("crée une session vérifiable", () => {
    const { token } = createSession(USER);
    const session = verifySessionToken(token);

    expect(session?.username).toBe("admin");
    expect(session?.role).toBe("admin");
  });

  it("rejette un cookie absent ou malformé", () => {
    expect(verifySessionToken(undefined)).toBeNull();
    expect(verifySessionToken("")).toBeNull();
    expect(verifySessionToken("sans-point")).toBeNull();
  });

  it("rejette une signature falsifiée", () => {
    const { token } = createSession(USER);
    const id = sessionIdFromToken(token);

    expect(verifySessionToken(`${id}.signature-bidon`)).toBeNull();
  });

  it("rejette un identifiant de session inventé mais bien signé côté format", () => {
    // Un attaquant qui devine un UUID sans la clé HMAC n'obtient rien.
    expect(verifySessionToken("00000000-0000-4000-8000-000000000000.AAAA")).toBeNull();
  });

  it("rejette une session expirée", () => {
    const now = Date.now();
    const { token } = createSession(USER, now);

    expect(verifySessionToken(token, now + 13 * 60 * 60 * 1000)).toBeNull();
  });

  it("révoque réellement la session à la déconnexion", () => {
    const { token } = createSession(USER);
    expect(verifySessionToken(token)).not.toBeNull();

    revokeSession(sessionIdFromToken(token));

    // Même cookie, même signature : refusé car l'état fait autorité.
    expect(verifySessionToken(token)).toBeNull();
  });

  it("permet de couper toutes les sessions", () => {
    const first = createSession(USER).token;
    const second = createSession(USER).token;

    revokeAllSessions();

    expect(verifySessionToken(first)).toBeNull();
    expect(verifySessionToken(second)).toBeNull();
  });

  it("invalide les sessions quand le mot de passe change sans SESSION_SECRET", () => {
    withEnv({ SESSION_SECRET: undefined, ADMIN_PASSWORD: "premier-mot-de-passe" });
    const { token } = createSession(USER);
    expect(verifySessionToken(token)).not.toBeNull();

    withEnv({ ADMIN_PASSWORD: "second-mot-de-passe" });
    expect(verifySessionToken(token)).toBeNull();
  });

  it("purge les sessions expirées de plus d'un jour", () => {
    const db = useMemoryDatabase();
    const old = Date.now() - 15 * 24 * 60 * 60 * 1000;
    createSession(USER, old);

    purgeExpiredSessions();

    const remaining = db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
    expect(remaining.n).toBe(0);
  });
});
