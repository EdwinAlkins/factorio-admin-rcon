import { env } from "@/server/config/env";
import { errorFields, logger } from "@/server/log";
import { getRcon } from "@/server/rcon";
import { getServerStatus } from "@/server/rcon/status";
import {
  cpuPercent,
  findContainerId,
  forgetContainerId,
  memoryUsage,
  readStats,
} from "@/server/metrics/docker";
import {
  purgeMetrics,
  recordSample,
  storageFailures,
  type MetricSample,
} from "@/server/metrics/service";

/**
 * The panel's "cron".
 *
 * The project has no scheduler, so this reuses the singleton pattern found
 * everywhere else (`getDb`, `getRcon`, the status cache), with a guard on
 * `globalThis` to survive `next dev`'s hot reload.
 */

/**
 * Health of a measurement source, as exposed by the API.
 *
 * A boolean was not enough: at startup, `healthy: false` conflated "nothing
 * measured yet" with "the source is down", and the interface reported an
 * outage before the collector had even run once.
 *
 * - `disabled`: turned off by configuration, nothing to report;
 * - `unknown` : no successful reading since startup;
 * - `healthy` : last reading succeeded;
 * - `degraded`: consecutive failures, but an earlier success exists — the
 *   collector retries with a growing backoff and the history stays valid;
 * - `failed`  : repeated failures, or no success at all since startup.
 */
export type HealthState = "disabled" | "unknown" | "healthy" | "degraded" | "failed";

export type SourceHealth = {
  state: HealthState;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
};

export type CollectorHealth = {
  running: boolean;
  startedAt: number | null;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  intervalMs: number;
  /** Lost SQLite writes: without this counter they would show up nowhere. */
  storageFailures: number;
  docker: SourceHealth;
  rcon: SourceHealth;
};

export type Source = {
  lastSuccessAt: number | null;
  failures: number;
  retryAt: number;
};

type State = {
  timer: NodeJS.Timeout;
  running: boolean;
  startedAt: number;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  ticks: number;
  /** Last tick reading, used to derive UPS. */
  lastTick: { tick: number; at: number } | null;
  docker: Source;
  rcon: Source;
};

const globalRef = globalThis as typeof globalThis & { __factorioMetrics?: State };

/** Purge roughly hourly, rather than from a second timer. */
const PURGE_EVERY_MS = 60 * 60 * 1000;

/**
 * Guard rail on the measured UPS.
 *
 * The value is **not** clamped to 60: a server catching up, or one whose speed
 * was changed (`game.speed`), legitimately exceeds the nominal rate, and
 * flattening it would erase exactly the anomaly we are looking for. Only a
 * physically absurd value — necessarily a clock error — is rejected, and it is
 * rejected outright rather than quietly corrected.
 */
const IMPLAUSIBLE_UPS = 600;

/**
 * The collector runs continuously, browser open or not: probing a dead source
 * on every interval would fill the log with thousands of lines a day. Attempts
 * are therefore spaced out, up to one every 20 periods (5 min at the default
 * interval).
 */
const MAX_BACKOFF = 20;

/** How many periods to skip after `failures` consecutive errors. */
export function rconBackoff(failures: number): number {
  return Math.min(MAX_BACKOFF, 2 ** (failures - 1));
}

function newSource(): Source {
  return { lastSuccessAt: null, failures: 0, retryAt: 0 };
}

function succeed(source: Source, now: number) {
  source.lastSuccessAt = now;
  source.failures = 0;
  source.retryAt = 0;
}

function fail(source: Source, now: number, intervalMs: number) {
  source.failures += 1;
  source.retryAt = now + rconBackoff(source.failures) * intervalMs;
}

/** Beyond this, a run of failures stops being a passing incident. */
const FAILED_AFTER = 3;

export function stateOf(source: Source, enabled: boolean): HealthState {
  if (!enabled) return "disabled";
  if (source.failures === 0) return source.lastSuccessAt === null ? "unknown" : "healthy";
  if (source.lastSuccessAt !== null && source.failures < FAILED_AFTER) return "degraded";
  return "failed";
}

function healthOf(source: Source, enabled: boolean): SourceHealth {
  return {
    state: stateOf(source, enabled),
    lastSuccessAt: source.lastSuccessAt,
    consecutiveFailures: source.failures,
  };
}

/**
 * Collector state, so the panel can tell "no data yet" from "the source is
 * down". Without it the interface could only infer health from the presence of
 * points, which conflates the two.
 */
export function metricsHealth(): CollectorHealth {
  const state = globalRef.__factorioMetrics;
  const config = env();

  return {
    running: state !== undefined,
    startedAt: state?.startedAt ?? null,
    lastRunAt: state?.lastRunAt ?? null,
    lastDurationMs: state?.lastDurationMs ?? null,
    intervalMs: config.METRICS_INTERVAL_MS,
    storageFailures: storageFailures(),
    docker: healthOf(state?.docker ?? newSource(), config.METRICS_DOCKER),
    rcon: healthOf(state?.rcon ?? newSource(), true),
  };
}

/**
 * UPS = game ticks elapsed per real second.
 *
 * Returns `null` rather than a misleading figure when the window is unusable:
 * a collection gap (the panel restarted, the tab slept) or a tick going
 * backwards, which signals a save being loaded.
 */
export function deriveUps(
  previous: { tick: number; at: number } | null,
  current: { tick: number; at: number },
  intervalMs: number,
): number | null {
  if (!previous) return null;

  const elapsedMs = current.at - previous.at;
  if (elapsedMs <= 0 || elapsedMs > intervalMs * 3) return null;

  const ticks = current.tick - previous.tick;
  if (ticks < 0) return null;

  const ups = (ticks / elapsedMs) * 1000;

  // Physically impossible value: the clock or the probe lied, not the server.
  // We reject it instead of clamping to 60, which would have disguised the
  // error as a plausible reading.
  return ups > IMPLAUSIBLE_UPS ? null : ups;
}

/** Container metrics, or `null` when the Docker proxy does not answer. */
async function collectDocker(state: State, now: number) {
  if (!env().METRICS_DOCKER) return null;

  // Same backoff as RCON: no point re-querying a dead proxy every 15 s for
  // hours on end.
  if (now < state.docker.retryAt) return null;

  try {
    const id = await findContainerId();
    if (!id) throw new Error(`no container matching "${env().METRICS_CONTAINER}"`);

    const stats = await readStats(id);
    if (!stats) {
      // 404: the container was recreated, the memorised id is stale.
      forgetContainerId();
      throw new Error("container not found");
    }

    if (state.docker.failures > 0) logger.info("docker metrics restored");
    succeed(state.docker, now);

    const memory = memoryUsage(stats);
    return {
      cpuPercent: cpuPercent(stats),
      memBytes: memory?.bytes ?? null,
      memLimit: memory?.limit ?? null,
    };
  } catch (error) {
    forgetContainerId();
    // One line per outage: otherwise 5,760 log lines a day while the proxy is
    // missing, which would drown out everything else.
    if (state.docker.failures === 0) {
      logger.warn("docker metrics unavailable", errorFields(error));
    }
    fail(state.docker, now, env().METRICS_INTERVAL_MS);
    return null;
  }
}

/**
 * Online players and UPS, the two measurements that go through RCON.
 *
 * Fills `sample` in place and leaves gaps as they are: a stopped server must
 * not prevent the container metrics from being recorded.
 */
async function collectRcon(state: State, sample: MetricSample, now: number) {
  try {
    // Goes through `status.ts`'s cache: at a 15 s interval the reading is
    // fresh, and it does not double the RCON traffic the interface already
    // generates.
    sample.players = (await getServerStatus()).count;

    if (env().METRICS_UPS) {
      // Deliberately outside `executeAction`: this probe must not show up in
      // the audit log, which records human actions.
      const result = await getRcon().execute("/silent-command rcon.print(game.tick)");
      const tick = Number.parseInt(result.output.trim(), 10);

      if (Number.isFinite(tick)) {
        const current = { tick, at: now };
        sample.gameTick = tick;
        sample.ups = deriveUps(state.lastTick, current, env().METRICS_INTERVAL_MS);
        state.lastTick = current;
      }
    }

    succeed(state.rcon, now);
  } catch {
    // The RCON service already logs the failure; we only back off here.
    fail(state.rcon, now, env().METRICS_INTERVAL_MS);
    // The next tick reading must not be dated from before the outage: the UPS
    // derived over the missed interval would be a misleading average.
    state.lastTick = null;
  }
}

async function tick(state: State) {
  // A Docker reading ties up the daemon for ~1 s: without this guard, a short
  // interval would make two collections overlap.
  if (state.running) return;
  state.running = true;

  try {
    const now = Date.now();
    const sample: MetricSample = {
      cpuPercent: null,
      memBytes: null,
      memLimit: null,
      players: null,
      gameTick: null,
      ups: null,
    };

    const docker = await collectDocker(state, now);
    if (docker) Object.assign(sample, docker);

    // Skip RCON probes while the server is considered unreachable: a
    // spaced-out attempt is enough to notice it coming back.
    if (now >= state.rcon.retryAt) await collectRcon(state, sample, now);

    recordSample(sample, now);

    state.lastRunAt = now;
    state.lastDurationMs = Date.now() - now;

    state.ticks += 1;
    if (state.ticks * env().METRICS_INTERVAL_MS >= PURGE_EVERY_MS) {
      state.ticks = 0;
      purgeMetrics(now);
    }
  } catch (error) {
    logger.error("metrics collection failed", errorFields(error));
  } finally {
    state.running = false;
  }
}

export function startMetricsCollector() {
  if (globalRef.__factorioMetrics) return;

  // Authoritative guard: no caller may arm the timer while the feature is off,
  // not even by bypassing instrumentation.ts.
  if (!env().METRICS_ENABLED) {
    logger.info("metrics disabled");
    return;
  }

  const intervalMs = env().METRICS_INTERVAL_MS;
  const state: State = {
    timer: setInterval(() => void tick(state), intervalMs),
    running: false,
    startedAt: Date.now(),
    lastRunAt: null,
    lastDurationMs: null,
    ticks: 0,
    lastTick: null,
    docker: newSource(),
    rcon: newSource(),
  };

  // `unref`: the timer must not keep the process alive at shutdown.
  state.timer.unref();
  globalRef.__factorioMetrics = state;

  logger.info("metrics collector started", {
    intervalMs,
    docker: env().METRICS_DOCKER ? env().DOCKER_API_URL : "disabled",
    ups: env().METRICS_UPS,
  });
}

export function stopMetricsCollector() {
  const state = globalRef.__factorioMetrics;
  if (!state) return;

  clearInterval(state.timer);
  globalRef.__factorioMetrics = undefined;
}
