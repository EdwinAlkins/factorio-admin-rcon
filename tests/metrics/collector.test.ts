import { afterEach, describe, expect, it } from "vitest";
import {
  deriveUps,
  metricsHealth,
  stateOf,
  rconBackoff,
  startMetricsCollector,
  stopMetricsCollector,
} from "@/server/metrics/collector";
import { resetEnvCache, withEnv } from "../helpers";

const INTERVAL = 15_000;

describe("deriving UPS", () => {
  it("converts a tick delta into ticks per second", () => {
    // 900 ticks in 15 s = 60 UPS, Factorio's nominal rate.
    const ups = deriveUps({ tick: 1000, at: 0 }, { tick: 1900, at: 15_000 }, INTERVAL);
    expect(ups).toBeCloseTo(60, 5);
  });

  it("makes a struggling server visible", () => {
    const ups = deriveUps({ tick: 1000, at: 0 }, { tick: 1450, at: 15_000 }, INTERVAL);
    expect(ups).toBeCloseTo(30, 5);
  });

  it("returns nothing on the very first sample", () => {
    expect(deriveUps(null, { tick: 1000, at: 0 }, INTERVAL)).toBeNull();
  });

  it("refuses to average across a collection gap", () => {
    // Panel restarted: an average over the missed interval would mislead.
    expect(deriveUps({ tick: 0, at: 0 }, { tick: 900, at: 10 * 60 * 1000 }, INTERVAL)).toBeNull();
  });

  it("ignores a tick going backwards, the sign of a save being loaded", () => {
    expect(deriveUps({ tick: 5000, at: 0 }, { tick: 900, at: 15_000 }, INTERVAL)).toBeNull();
  });

  it("lets a value above the nominal rate through", () => {
    // Catching up after a stutter, or `game.speed` changed: these values are
    // real. Clamping them to 60 would erase the very anomaly being looked for.
    const ups = deriveUps({ tick: 1000, at: 0 }, { tick: 1900, at: 14_000 }, INTERVAL);
    expect(ups).toBeCloseTo(64.3, 1);
  });

  it("rejects a physically impossible value rather than clamping it", () => {
    // 900,000 ticks in 15 s: the clock or the probe is lying, not the game.
    expect(deriveUps({ tick: 0, at: 0 }, { tick: 9_000_000, at: 15_000 }, INTERVAL)).toBeNull();
  });

  it("treats a paused server as 0 UPS, not as a missing reading", () => {
    expect(deriveUps({ tick: 1000, at: 0 }, { tick: 1000, at: 15_000 }, INTERVAL)).toBe(0);
  });

  it("discards two readings taken at the same instant", () => {
    expect(deriveUps({ tick: 1000, at: 5 }, { tick: 1100, at: 5 }, INTERVAL)).toBeNull();
  });
});

describe("backing off the RCON probes", () => {
  it("retries without delay while the server answers", () => {
    // The first failure skips no period: a momentary blip must not create a
    // hole in the series.
    expect(rconBackoff(1)).toBe(1);
  });

  it("backs off exponentially on subsequent attempts", () => {
    expect(rconBackoff(2)).toBe(2);
    expect(rconBackoff(3)).toBe(4);
    expect(rconBackoff(5)).toBe(16);
  });

  it("caps the backoff so a recovery is still noticed", () => {
    // Without a cap, a server switched off overnight would go unprobed for
    // hours after coming back up.
    expect(rconBackoff(10)).toBe(20);
    expect(rconBackoff(50)).toBe(20);
  });
});

describe("master switch", () => {
  afterEach(() => {
    // The timer lives on `globalThis`: without an explicit stop it would leak
    // from one test to the next.
    stopMetricsCollector();
    withEnv({ METRICS_ENABLED: undefined, METRICS_DOCKER: undefined });
    resetEnvCache();
  });

  it("starts no collector when metrics are off", () => {
    withEnv({ METRICS_ENABLED: "false" });
    startMetricsCollector();

    // Authoritative guard: even called directly, nothing arms itself.
    expect(metricsHealth().running).toBe(false);
    expect(metricsHealth().startedAt).toBeNull();
  });

  it("starts the collector when they are on", () => {
    withEnv({ METRICS_ENABLED: "true", METRICS_DOCKER: "false" });
    startMetricsCollector();

    const health = metricsHealth();
    expect(health.running).toBe(true);
    // Turning off the Docker source alone does not stop RCON collection.
    expect(health.docker.state).toBe("disabled");
    // Nothing has been measured yet: that is not an outage.
    expect(health.rcon.state).toBe("unknown");
  });

  it("reports the Docker source as off without calling it broken", () => {
    withEnv({ METRICS_ENABLED: "true", METRICS_DOCKER: "false" });
    startMetricsCollector();

    const docker = metricsHealth().docker;
    // Disabled is not failing: there is no failure to report.
    expect(docker.state).toBe("disabled");
    expect(docker.consecutiveFailures).toBe(0);
  });
});

describe("a source's state", () => {
  const source = (failures: number, lastSuccessAt: number | null) => ({
    failures,
    lastSuccessAt,
    retryAt: 0,
  });

  it('tells "not measured yet" from "down"', () => {
    // This was the boolean's ambiguity: both meant healthy = false.
    expect(stateOf(source(0, null), true)).toBe("unknown");
    expect(stateOf(source(3, null), true)).toBe("failed");
  });

  it("says nothing about a source turned off by configuration", () => {
    expect(stateOf(source(0, null), false)).toBe("disabled");
    expect(stateOf(source(9, Date.now()), false)).toBe("disabled");
  });

  it('goes through "degraded" before declaring an outage', () => {
    const at = Date.now();
    expect(stateOf(source(0, at), true)).toBe("healthy");
    expect(stateOf(source(1, at), true)).toBe("degraded");
    expect(stateOf(source(2, at), true)).toBe("degraded");
    expect(stateOf(source(3, at), true)).toBe("failed");
  });
});
