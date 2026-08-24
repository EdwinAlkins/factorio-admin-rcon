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
 * Le « cron » du panneau.
 *
 * Le projet n'a pas d'ordonnanceur : on reprend le motif singleton utilisé
 * partout ailleurs (`getDb`, `getRcon`, cache de statut), avec un garde sur
 * `globalThis` pour survivre au rechargement à chaud de `next dev`.
 */

/** Santé d'une source de mesure, telle qu'exposée par l'API. */
export type SourceHealth = {
  enabled: boolean;
  healthy: boolean;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
};

export type CollectorHealth = {
  running: boolean;
  startedAt: number | null;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  intervalMs: number;
  /** Écritures SQLite perdues : sans ce compteur, elles ne se voient nulle part. */
  storageFailures: number;
  docker: SourceHealth;
  rcon: SourceHealth;
};

type Source = {
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
  /** Dernier relevé de tick, pour dériver l'UPS. */
  lastTick: { tick: number; at: number } | null;
  docker: Source;
  rcon: Source;
};

const globalRef = globalThis as typeof globalThis & { __factorioMetrics?: State };

/** Purge ~toutes les heures plutôt que dans un second minuteur. */
const PURGE_EVERY_MS = 60 * 60 * 1000;

/**
 * Garde-fou sur l'UPS mesurée.
 *
 * On ne ramène **pas** la valeur à 60 : un serveur qui rattrape son retard, ou
 * dont la vitesse a été changée (`game.speed`), dépasse légitimement la cadence
 * nominale, et l'écraser effacerait précisément l'anomalie qu'on cherche. Seule
 * une valeur physiquement absurde — nécessairement une erreur d'horloge — est
 * rejetée, et elle l'est franchement plutôt que corrigée en douce.
 */
const IMPLAUSIBLE_UPS = 600;

/**
 * Le collecteur tourne en continu, y compris sans navigateur ouvert : sonder
 * une source morte à chaque intervalle remplirait le journal de milliers de
 * lignes par jour. On espace donc les tentatives, jusqu'à une toutes les
 * 20 périodes (5 min avec l'intervalle par défaut).
 */
const MAX_BACKOFF = 20;

/** Nombre de périodes à sauter après `failures` échecs consécutifs. */
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

function healthOf(source: Source, enabled: boolean): SourceHealth {
  return {
    enabled,
    healthy: enabled && source.failures === 0 && source.lastSuccessAt !== null,
    lastSuccessAt: source.lastSuccessAt,
    consecutiveFailures: source.failures,
  };
}

/**
 * État du collecteur, pour que le panneau distingue « pas encore de données »
 * de « la source est tombée ». Sans cela, l'interface ne peut que déduire la
 * santé de la présence de points, ce qui confond les deux cas.
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
 * UPS = ticks de jeu écoulés par seconde réelle.
 *
 * Renvoie `null` plutôt qu'un chiffre trompeur quand la fenêtre n'est pas
 * exploitable : trou de collecte (le panneau a redémarré, l'onglet a dormi) ou
 * tick qui recule, ce qui signale un chargement de sauvegarde.
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

  // Valeur physiquement impossible : c'est l'horloge ou la sonde qui a menti,
  // pas le serveur. On la rejette au lieu de la ramener à 60, ce qui aurait
  // maquillé l'erreur en mesure plausible.
  return ups > IMPLAUSIBLE_UPS ? null : ups;
}

/** Métriques du conteneur, ou `null` si le proxy Docker ne répond pas. */
async function collectDocker(state: State, now: number) {
  if (!env().METRICS_DOCKER) return null;

  // Même espacement que pour RCON : inutile de réinterroger un proxy mort
  // toutes les 15 s pendant des heures.
  if (now < state.docker.retryAt) return null;

  try {
    const id = await findContainerId();
    if (!id) throw new Error(`aucun conteneur pour « ${env().METRICS_CONTAINER} »`);

    const stats = await readStats(id);
    if (!stats) {
      // 404 : le conteneur a été recréé, l'identifiant mémorisé est périmé.
      forgetContainerId();
      throw new Error("conteneur introuvable");
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
    // Une seule ligne par panne : sinon 5 760 lignes de log par jour quand le
    // proxy est absent, ce qui noierait tout le reste.
    if (state.docker.failures === 0) {
      logger.warn("docker metrics unavailable", errorFields(error));
    }
    fail(state.docker, now, env().METRICS_INTERVAL_MS);
    return null;
  }
}

/**
 * Joueurs connectés et UPS, les deux mesures qui passent par RCON.
 *
 * Renseigne `sample` en place et laisse les trous tels quels : un serveur
 * éteint ne doit pas empêcher d'enregistrer les métriques du conteneur.
 */
async function collectRcon(state: State, sample: MetricSample, now: number) {
  try {
    // Passe par le cache de `status.ts` : à 15 s d'intervalle la mesure est
    // fraîche, et on ne double pas le trafic RCON déjà généré par l'interface.
    sample.players = (await getServerStatus()).count;

    if (env().METRICS_UPS) {
      // Volontairement hors `executeAction` : cette sonde ne doit pas apparaître
      // dans le journal d'audit, qui trace les gestes humains.
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
    // Le service RCON journalise déjà l'échec ; on se contente d'espacer.
    fail(state.rcon, now, env().METRICS_INTERVAL_MS);
    // Le prochain relevé de tick ne doit pas être daté d'avant la coupure :
    // l'UPS dérivée sur l'intervalle manqué serait une moyenne trompeuse.
    state.lastTick = null;
  }
}

async function tick(state: State) {
  // Le relevé Docker immobilise le démon ~1 s : sans ce garde, un intervalle
  // court ferait se chevaucher deux collectes.
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

    // Sauter les sondes RCON tant que le serveur est jugé injoignable :
    // une tentative espacée suffit à détecter son retour.
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

  // Garde faisant autorité : aucun appelant ne doit pouvoir armer le minuteur
  // quand la fonctionnalité est coupée, même en contournant instrumentation.ts.
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

  // `unref` : le minuteur ne doit pas retenir le processus à l'arrêt.
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
