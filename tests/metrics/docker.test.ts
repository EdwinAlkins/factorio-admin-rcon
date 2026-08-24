import { describe, expect, it } from "vitest";
import { cpuPercent, memoryUsage, type DockerStats } from "@/server/metrics/docker";

/** Relevé type d'un `GET /containers/{id}/stats?stream=false`. */
function statsWith(overrides: Partial<DockerStats> = {}): DockerStats {
  return {
    cpu_stats: {
      cpu_usage: { total_usage: 2_000_000_000 },
      system_cpu_usage: 40_000_000_000,
      online_cpus: 4,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 1_800_000_000 },
      system_cpu_usage: 39_000_000_000,
      online_cpus: 4,
    },
    ...overrides,
  };
}

describe("calcul de la charge CPU", () => {
  it("rapporte le delta au nombre de cœurs, comme docker stats", () => {
    // 0,2 s de CPU pour 1 s de système sur 4 cœurs → 80 %.
    expect(cpuPercent(statsWith())).toBeCloseTo(80, 5);
  });

  it("prend les deux bornes dans la même réponse", () => {
    // precpu_stats est rempli par le démon : le résultat ne doit dépendre
    // d'aucun état conservé entre deux échantillons.
    const first = cpuPercent(statsWith());
    const second = cpuPercent(statsWith());
    expect(second).toBe(first);
  });

  it("renvoie null plutôt que NaN quand le système n'a pas avancé", () => {
    const stats = statsWith();
    stats.precpu_stats!.system_cpu_usage = stats.cpu_stats!.system_cpu_usage;
    expect(cpuPercent(stats)).toBeNull();
  });

  it("se rabat sur percpu_usage quand online_cpus est absent", () => {
    const stats = statsWith();
    delete stats.cpu_stats!.online_cpus;
    stats.cpu_stats!.cpu_usage!.percpu_usage = [1, 2];
    expect(cpuPercent(stats)).toBeCloseTo(40, 5);
  });

  it("suppose un cœur unique sans aucune indication", () => {
    const stats = statsWith();
    delete stats.cpu_stats!.online_cpus;
    expect(cpuPercent(stats)).toBeCloseTo(20, 5);
  });

  it("ignore le tout premier relevé, où precpu_stats est vide", () => {
    expect(cpuPercent(statsWith({ precpu_stats: {} }))).toBeNull();
    expect(cpuPercent(statsWith({ precpu_stats: undefined }))).toBeNull();
  });
});

describe("calcul de la mémoire", () => {
  it("retranche le cache inactif de cgroup v2", () => {
    const usage = memoryUsage({
      memory_stats: { usage: 1000, limit: 4000, stats: { inactive_file: 400 } },
    });
    expect(usage).toEqual({ bytes: 600, limit: 4000 });
  });

  it("retranche aussi total_inactive_file en cgroup v1", () => {
    const usage = memoryUsage({
      memory_stats: { usage: 1000, limit: 4000, stats: { total_inactive_file: 250 } },
    });
    expect(usage?.bytes).toBe(750);
  });

  it("accepte un relevé sans bloc stats", () => {
    expect(memoryUsage({ memory_stats: { usage: 900, limit: 4000 } })?.bytes).toBe(900);
  });

  it("ne descend jamais sous zéro", () => {
    const usage = memoryUsage({
      memory_stats: { usage: 100, limit: 4000, stats: { inactive_file: 500 } },
    });
    expect(usage?.bytes).toBe(0);
  });

  it("signale l'absence de limite plutôt que d'inventer une échelle", () => {
    expect(memoryUsage({ memory_stats: { usage: 900, limit: 0 } })?.limit).toBeNull();
  });

  it("renvoie null quand le relevé mémoire est absent", () => {
    expect(memoryUsage({})).toBeNull();
    expect(memoryUsage({ memory_stats: {} })).toBeNull();
  });
});
