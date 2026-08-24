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

  it("fournit des métriques activées par défaut", () => {
    const env = parseEnv({});
    expect(env.METRICS_ENABLED).toBe(true);
    expect(env.METRICS_DOCKER).toBe(true);
    expect(env.METRICS_UPS).toBe(true);
    expect(env.METRICS_INTERVAL_MS).toBe(15_000);
    expect(env.METRICS_RETENTION_DAYS).toBe(7);
    expect(env.DOCKER_API_URL).toBe("http://docker-proxy:2375");
  });

  it("distingue l'interrupteur maître de la source Docker", () => {
    // Couper Docker laisse la fonctionnalité debout (joueurs, UPS)…
    expect(parseEnv({ METRICS_DOCKER: "false" })).toMatchObject({
      METRICS_ENABLED: true,
      METRICS_DOCKER: false,
    });
    // …alors que couper le maître ne présume rien des sources : elles ne sont
    // simplement plus consultées.
    expect(parseEnv({ METRICS_ENABLED: "false" }).METRICS_ENABLED).toBe(false);
  });

  it("valide les réglages métriques même quand la fonctionnalité est coupée", () => {
    // Sinon une valeur fautive n'apparaîtrait que le jour de la réactivation.
    expect(() =>
      parseEnv({ METRICS_ENABLED: "false", METRICS_INTERVAL_MS: "10" }),
    ).toThrow(ConfigError);
  });

  it("refuse une URL de démon Docker mal formée", () => {
    expect(() => parseEnv({ DOCKER_API_URL: "docker-proxy:2375" })).toThrow(ConfigError);
  });

  it("refuse un intervalle d'échantillonnage trop court", () => {
    // Sous 5 s, deux relevés Docker se chevaucheraient.
    expect(() => parseEnv({ METRICS_INTERVAL_MS: "1000" })).toThrow(ConfigError);
  });

  it("refuse une rétention nulle ou démesurée", () => {
    expect(() => parseEnv({ METRICS_RETENTION_DAYS: "0" })).toThrow(ConfigError);
    expect(() => parseEnv({ METRICS_RETENTION_DAYS: "9999" })).toThrow(ConfigError);
  });
});
