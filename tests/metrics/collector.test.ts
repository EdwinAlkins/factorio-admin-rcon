import { afterEach, describe, expect, it } from "vitest";
import {
  deriveUps,
  metricsHealth,
  rconBackoff,
  startMetricsCollector,
  stopMetricsCollector,
} from "@/server/metrics/collector";
import { resetEnvCache, withEnv } from "../helpers";

const INTERVAL = 15_000;

describe("dérivation de l'UPS", () => {
  it("convertit un delta de ticks en ticks par seconde", () => {
    // 900 ticks en 15 s = 60 UPS, la cadence nominale de Factorio.
    const ups = deriveUps({ tick: 1000, at: 0 }, { tick: 1900, at: 15_000 }, INTERVAL);
    expect(ups).toBeCloseTo(60, 5);
  });

  it("rend visible un serveur qui rame", () => {
    const ups = deriveUps({ tick: 1000, at: 0 }, { tick: 1450, at: 15_000 }, INTERVAL);
    expect(ups).toBeCloseTo(30, 5);
  });

  it("ne renvoie rien au tout premier échantillon", () => {
    expect(deriveUps(null, { tick: 1000, at: 0 }, INTERVAL)).toBeNull();
  });

  it("refuse de moyenner sur un trou de collecte", () => {
    // Panneau redémarré : la moyenne sur l'intervalle manqué serait trompeuse.
    expect(deriveUps({ tick: 0, at: 0 }, { tick: 900, at: 10 * 60 * 1000 }, INTERVAL)).toBeNull();
  });

  it("ignore un tick qui recule, signe d'un chargement de sauvegarde", () => {
    expect(deriveUps({ tick: 5000, at: 0 }, { tick: 900, at: 15_000 }, INTERVAL)).toBeNull();
  });

  it("laisse passer un dépassement de la cadence nominale", () => {
    // Rattrapage après un à-coup, ou `game.speed` modifié : ces valeurs sont
    // réelles. Les ramener à 60 effacerait exactement l'anomalie recherchée.
    const ups = deriveUps({ tick: 1000, at: 0 }, { tick: 1900, at: 14_000 }, INTERVAL);
    expect(ups).toBeCloseTo(64.3, 1);
  });

  it("rejette une valeur physiquement impossible plutôt que de la rogner", () => {
    // 900 000 ticks en 15 s : c'est l'horloge ou la sonde qui ment, pas le jeu.
    expect(deriveUps({ tick: 0, at: 0 }, { tick: 9_000_000, at: 15_000 }, INTERVAL)).toBeNull();
  });

  it("traite un serveur en pause comme 0 UPS, pas comme une absence de mesure", () => {
    expect(deriveUps({ tick: 1000, at: 0 }, { tick: 1000, at: 15_000 }, INTERVAL)).toBe(0);
  });

  it("écarte deux relevés au même instant", () => {
    expect(deriveUps({ tick: 1000, at: 5 }, { tick: 1100, at: 5 }, INTERVAL)).toBeNull();
  });
});

describe("espacement des sondes RCON", () => {
  it("réessaie sans délai tant que le serveur répond", () => {
    // Le premier échec ne saute aucune période : une coupure d'un instant ne
    // doit pas créer de trou dans la série.
    expect(rconBackoff(1)).toBe(1);
  });

  it("espace exponentiellement les tentatives suivantes", () => {
    expect(rconBackoff(2)).toBe(2);
    expect(rconBackoff(3)).toBe(4);
    expect(rconBackoff(5)).toBe(16);
  });

  it("plafonne l'espacement pour continuer à détecter un retour", () => {
    // Sans plafond, un serveur éteint une nuit ne serait plus sondé pendant des
    // heures après son redémarrage.
    expect(rconBackoff(10)).toBe(20);
    expect(rconBackoff(50)).toBe(20);
  });
});

describe("interrupteur maître", () => {
  afterEach(() => {
    // Le minuteur vit sur `globalThis` : sans arrêt explicite il fuirait
    // d'un test à l'autre.
    stopMetricsCollector();
    withEnv({ METRICS_ENABLED: undefined, METRICS_DOCKER: undefined });
    resetEnvCache();
  });

  it("ne démarre aucun collecteur quand les métriques sont coupées", () => {
    withEnv({ METRICS_ENABLED: "false" });
    startMetricsCollector();

    // Garde faisant autorité : même appelé directement, rien ne s'arme.
    expect(metricsHealth().running).toBe(false);
    expect(metricsHealth().startedAt).toBeNull();
  });

  it("démarre le collecteur quand elles sont activées", () => {
    withEnv({ METRICS_ENABLED: "true", METRICS_DOCKER: "false" });
    startMetricsCollector();

    const health = metricsHealth();
    expect(health.running).toBe(true);
    // Couper la seule source Docker n'empêche pas la collecte RCON.
    expect(health.docker.enabled).toBe(false);
    expect(health.rcon.enabled).toBe(true);
  });

  it("rapporte la source Docker coupée sans la dire en panne", () => {
    withEnv({ METRICS_ENABLED: "true", METRICS_DOCKER: "false" });
    startMetricsCollector();

    const docker = metricsHealth().docker;
    // Désactivée n'est pas défaillante : aucun échec à signaler.
    expect(docker.enabled).toBe(false);
    expect(docker.consecutiveFailures).toBe(0);
  });
});
