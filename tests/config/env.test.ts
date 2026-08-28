import { describe, expect, it } from "vitest";
import { ConfigError, parseEnv, type EnvSource } from "@/server/config/env";

/** The session secret is required: every valid source carries one. */
const SECRET = "cle-de-signature-de-test-32-octets";
const source = (overrides: EnvSource = {}): EnvSource => ({
  SESSION_SECRET: SECRET,
  ...overrides,
});

describe("parseEnv", () => {
  it("applies the defaults", () => {
    const env = parseEnv(source());
    expect(env.RCON_HOST).toBe("factorio");
    expect(env.RCON_PORT).toBe(27015);
    expect(env.SESSION_TTL_HOURS).toBe(12);
    expect(env.TRUST_PROXY).toBe(false);
    expect(env.COOKIE_SECURE).toBe("auto");
  });

  it("rejects a non-numeric port instead of propagating NaN", () => {
    expect(() => parseEnv(source({ RCON_PORT: "lol" }))).toThrow(ConfigError);
  });

  it("rejects an out-of-range port", () => {
    expect(() => parseEnv(source({ RCON_PORT: "70000" }))).toThrow(ConfigError);
  });

  it("rejects a negative timeout", () => {
    expect(() => parseEnv(source({ RCON_TIMEOUT_MS: "-1" }))).toThrow(ConfigError);
  });

  it("treats an empty variable as unset", () => {
    // docker-compose passes RCON_PORT= when the .env does not define it.
    const env = parseEnv(source({ RCON_PORT: "" }));
    expect(env.RCON_PORT).toBe(27015);
  });

  it("requires a session secret, with no password-derived fallback", () => {
    expect(() => parseEnv({})).toThrow(ConfigError);
    // An empty variable counts as "unset": it does not satisfy the requirement.
    expect(() => parseEnv({ SESSION_SECRET: "" })).toThrow(ConfigError);
    expect(() => parseEnv({ SESSION_SECRET: "trop-court" })).toThrow(ConfigError);
    expect(parseEnv(source()).SESSION_SECRET).toBe(SECRET);
  });

  it("converts textual booleans", () => {
    expect(parseEnv(source({ TRUST_PROXY: "true" })).TRUST_PROXY).toBe(true);
    expect(parseEnv(source({ TRUST_PROXY: "1" })).TRUST_PROXY).toBe(true);
    expect(parseEnv(source({ TRUST_PROXY: "0" })).TRUST_PROXY).toBe(false);
    expect(() => parseEnv(source({ TRUST_PROXY: "oui" }))).toThrow(ConfigError);
  });

  it("enables metrics by default", () => {
    const env = parseEnv(source());
    expect(env.METRICS_ENABLED).toBe(true);
    expect(env.METRICS_DOCKER).toBe(true);
    expect(env.METRICS_UPS).toBe(true);
    expect(env.METRICS_INTERVAL_MS).toBe(15_000);
    expect(env.METRICS_RETENTION_DAYS).toBe(7);
    expect(env.DOCKER_API_URL).toBe("http://docker-proxy:2375");
  });

  it("tells the master switch from the Docker source", () => {
    // Turning Docker off leaves the feature standing (players, UPS)…
    expect(parseEnv(source({ METRICS_DOCKER: "false" }))).toMatchObject({
      METRICS_ENABLED: true,
      METRICS_DOCKER: false,
    });
    // …whereas turning off the master switch presumes nothing about the
    // sources: they are simply no longer consulted.
    expect(parseEnv(source({ METRICS_ENABLED: "false" })).METRICS_ENABLED).toBe(false);
  });

  it("validates metric settings even when the feature is off", () => {
    // Otherwise a faulty value would only surface on the day it is re-enabled.
    expect(() =>
      parseEnv(source({ METRICS_ENABLED: "false", METRICS_INTERVAL_MS: "10" })),
    ).toThrow(ConfigError);
  });

  it("refuses a malformed Docker daemon URL", () => {
    expect(() => parseEnv(source({ DOCKER_API_URL: "docker-proxy:2375" }))).toThrow(ConfigError);
  });

  it("refuses too short a sampling interval", () => {
    // Below 5 s, two Docker readings would overlap.
    expect(() => parseEnv(source({ METRICS_INTERVAL_MS: "1000" }))).toThrow(ConfigError);
  });

  it("refuses a zero or outsized retention", () => {
    expect(() => parseEnv(source({ METRICS_RETENTION_DAYS: "0" }))).toThrow(ConfigError);
    expect(() => parseEnv(source({ METRICS_RETENTION_DAYS: "9999" }))).toThrow(ConfigError);
  });
});
