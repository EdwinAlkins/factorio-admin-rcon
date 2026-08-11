import { afterEach, describe, expect, it } from "vitest";
import { authenticate, hasAnyAccount } from "@/server/auth/users";
import { resetEnvCache, withEnv } from "../helpers";

afterEach(() => {
  withEnv({
    ADMIN_PASSWORD: undefined,
    MODERATOR_PASSWORD: undefined,
    VIEWER_PASSWORD: undefined,
  });
  resetEnvCache();
});

describe("authenticate", () => {
  it("attribue le rôle correspondant au mot de passe utilisé", () => {
    withEnv({
      ADMIN_PASSWORD: "admin-pw",
      MODERATOR_PASSWORD: "moderator-pw",
      VIEWER_PASSWORD: "viewer-pw",
    });

    expect(authenticate("admin-pw")).toEqual({ username: "admin", role: "admin" });
    expect(authenticate("moderator-pw")).toEqual({ username: "moderator", role: "moderator" });
    expect(authenticate("viewer-pw")).toEqual({ username: "viewer", role: "viewer" });
  });

  it("refuse un mauvais mot de passe", () => {
    withEnv({ ADMIN_PASSWORD: "admin-pw" });

    expect(authenticate("autre")).toBeNull();
    expect(authenticate("")).toBeNull();
    expect(authenticate("admin-pw ")).toBeNull();
  });

  it("refuse tout le monde quand aucun compte n'est configuré", () => {
    withEnv({
      ADMIN_PASSWORD: undefined,
      MODERATOR_PASSWORD: undefined,
      VIEWER_PASSWORD: undefined,
    });

    expect(hasAnyAccount()).toBe(false);
    expect(authenticate("")).toBeNull();
    expect(authenticate("nimporte-quoi")).toBeNull();
  });
});
