import { describe, expect, it } from "vitest";
import { ConfigError, parseEnv } from "@/server/config/env";

describe("parseEnv", () => {
  it("applique les valeurs par défaut", () => {
    const env = parseEnv({});
    expect(env.RCON_HOST).toBe("factorio");
    expect(env.RCON_PORT).toBe(27015);
    expect(env.SESSION_TTL_HOURS).toBe(12);
    expect(env.TRUST_PROXY).toBe(false);
    expect(env.COOKIE_SECURE).toBe("auto");
  });

  it("rejette un port non numérique au lieu de propager NaN", () => {
    expect(() => parseEnv({ RCON_PORT: "lol" })).toThrow(ConfigError);
  });

  it("rejette un port hors plage", () => {
    expect(() => parseEnv({ RCON_PORT: "70000" })).toThrow(ConfigError);
  });

  it("rejette un délai négatif", () => {
    expect(() => parseEnv({ RCON_TIMEOUT_MS: "-1" })).toThrow(ConfigError);
  });

  it("traite une variable vide comme non définie", () => {
    // docker-compose passe SESSION_SECRET= quand le .env ne le définit pas.
    const env = parseEnv({ SESSION_SECRET: "", RCON_PORT: "" });
    expect(env.SESSION_SECRET).toBeUndefined();
    expect(env.RCON_PORT).toBe(27015);
  });

  it("refuse un secret de session trop court", () => {
    expect(() => parseEnv({ SESSION_SECRET: "court" })).toThrow(ConfigError);
  });

  it("convertit les booléens textuels", () => {
    expect(parseEnv({ TRUST_PROXY: "true" }).TRUST_PROXY).toBe(true);
    expect(parseEnv({ TRUST_PROXY: "1" }).TRUST_PROXY).toBe(true);
    expect(parseEnv({ TRUST_PROXY: "0" }).TRUST_PROXY).toBe(false);
    expect(() => parseEnv({ TRUST_PROXY: "oui" })).toThrow(ConfigError);
  });
});
