import { writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Faux client RCON piloté par les tests (aucune socket réelle). */
const fake = vi.hoisted(() => ({
  instances: [] as { password: string }[],
  onConnect: null as null | (() => Promise<void>),
  onSend: null as null | ((command: string) => Promise<string>),
  concurrent: 0,
  maxConcurrent: 0,
}));

vi.mock("rcon-client", () => ({
  Rcon: class {
    config: { password: string };

    constructor(config: { password: string }) {
      this.config = config;
    }

    on() {}

    async connect() {
      if (fake.onConnect) await fake.onConnect();
      fake.instances.push({ password: this.config.password });
      return this;
    }

    async send(command: string) {
      fake.concurrent += 1;
      fake.maxConcurrent = Math.max(fake.maxConcurrent, fake.concurrent);
      try {
        return fake.onSend ? await fake.onSend(command) : `écho: ${command}`;
      } finally {
        fake.concurrent -= 1;
      }
    }

    async end() {}
  },
}));

const { RconService } = await import("@/server/rcon/service");

function service(overrides: Partial<ConstructorParameters<typeof RconService>[0]> = {}) {
  return new RconService({
    host: "factorio",
    port: 27015,
    timeoutMs: 500,
    maxQueue: 20,
    password: "secret",
    passwordFile: "/inexistant",
    ...overrides,
  });
}

beforeEach(() => {
  fake.instances = [];
  fake.onConnect = null;
  fake.onSend = null;
  fake.concurrent = 0;
  fake.maxConcurrent = 0;
});

describe("RconService", () => {
  it("exécute une commande et mesure sa durée", async () => {
    const result = await service().execute("/players");

    expect(result.output).toBe("écho: /players");
    expect(result.command).toBe("/players");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("réutilise la connexion entre deux commandes", async () => {
    const rcon = service();
    await rcon.execute("/players");
    await rcon.execute("/version");

    expect(fake.instances).toHaveLength(1);
    expect(rcon.getStats().connections).toBe(1);
  });

  it("sérialise les commandes : jamais deux en vol sur la socket", async () => {
    const rcon = service();
    fake.onSend = async (command) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return command;
    };

    const results = await Promise.all([
      rcon.execute("/a"),
      rcon.execute("/b"),
      rcon.execute("/c"),
    ]);

    expect(results.map((r) => r.output)).toEqual(["/a", "/b", "/c"]);
    expect(fake.maxConcurrent).toBe(1);
  });

  it("refuse au-delà de la file maximale au lieu d'empiler indéfiniment", async () => {
    const rcon = service({ maxQueue: 2 });
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    fake.onSend = async (command) => {
      await gate;
      return command;
    };

    const first = rcon.execute("/a");
    const second = rcon.execute("/b");

    // Les deux premières occupent la file ; la troisième est refusée tout de suite.
    await expect(rcon.execute("/c")).rejects.toMatchObject({ code: "backpressure" });

    open();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(rcon.getStats().queueDepth).toBe(0);
  });

  it("classe un refus d'authentification", async () => {
    fake.onConnect = async () => {
      throw new Error("Authentication failed");
    };

    await expect(service().execute("/players")).rejects.toMatchObject({
      code: "authentication",
    });
  });

  it("classe une erreur réseau et ne divulgue pas l'hôte au client", async () => {
    fake.onConnect = async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    };

    const error = await service()
      .execute("/players")
      .catch((caught) => caught);

    expect(error.code).toBe("connection");
    expect(error.message).not.toContain("27015");
    // Le détail technique reste disponible pour les logs serveur.
    expect(error.detail).toContain("ECONNREFUSED");
    expect(error.detail).toContain("port=27015");
  });

  it("réessaie une fois après une socket coupée", async () => {
    const rcon = service();
    let attempt = 0;
    fake.onSend = async (command) => {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error("socket fermée"), { code: "ECONNRESET" });
      return command;
    };

    await expect(rcon.execute("/players")).resolves.toMatchObject({ output: "/players" });
    expect(fake.instances).toHaveLength(2);
  });

  it("relit le fichier de mot de passe à chaque nouvelle connexion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rconpw-"));
    const file = join(dir, "rconpw");
    writeFileSync(file, "premier\n");

    const rcon = service({ password: undefined, passwordFile: file });
    await rcon.execute("/players");

    // Régénération du mot de passe côté serveur Factorio.
    writeFileSync(file, "second\n");
    await rcon.shutdown();
    await rcon.execute("/players");

    expect(fake.instances.map((instance) => instance.password)).toEqual(["premier", "second"]);
  });

  it("signale une erreur de configuration si le fichier est absent", async () => {
    const rcon = service({ password: undefined, passwordFile: "/inexistant/rconpw" });

    await expect(rcon.execute("/players")).rejects.toMatchObject({ code: "configuration" });
  });

  it("compte les échecs dans les métriques", async () => {
    const rcon = service();
    fake.onSend = async () => {
      throw Object.assign(new Error("nope"), { code: "ECONNRESET" });
    };

    await rcon.execute("/players").catch(() => undefined);

    const stats = rcon.getStats();
    expect(stats.failedCommands).toBe(1);
    expect(stats.lastErrorAt).not.toBeNull();
    expect(stats.queueDepth).toBe(0);
  });
});
