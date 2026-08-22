import { readFile } from "node:fs/promises";
import { Rcon } from "rcon-client";
import { RconError, errnoOf } from "@/server/rcon/errors";
import { normalizeCommand } from "@/server/rcon/command";
import { errorFields, logger } from "@/server/log";

export type RconConfig = {
  host: string;
  port: number;
  timeoutMs: number;
  /** Nombre maximal de commandes en attente avant refus (backpressure). */
  maxQueue: number;
  password?: string;
  passwordFile: string;
};

export type RconStats = {
  connected: boolean;
  queueDepth: number;
  totalCommands: number;
  failedCommands: number;
  connections: number;
  lastLatencyMs: number | null;
  lastErrorAt: number | null;
};

export type RconExecution = {
  command: string;
  output: string;
  durationMs: number;
};

/**
 * Service RCON : une connexion, une file d'attente bornée, des métriques.
 *
 * Le protocole RCON de Factorio traite une commande à la fois sur une socket ;
 * les commandes sont donc sérialisées. La file est **bornée** pour qu'un client
 * authentifié ne puisse pas empiler des milliers de requêtes (déni de service).
 */
export class RconService {
  private connection: Rcon | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private depth = 0;
  private totalCommands = 0;
  private failedCommands = 0;
  private connections = 0;
  private lastLatencyMs: number | null = null;
  private lastErrorAt: number | null = null;

  constructor(private readonly config: RconConfig) {}

  getStats(): RconStats {
    return {
      connected: this.connection !== null,
      queueDepth: this.depth,
      totalCommands: this.totalCommands,
      failedCommands: this.failedCommands,
      connections: this.connections,
      lastLatencyMs: this.lastLatencyMs,
      lastErrorAt: this.lastErrorAt,
    };
  }

  /**
   * Relu à chaque nouvelle connexion (et non mis en cache pour la vie du
   * processus) : une régénération de `rconpw` est reprise sans redémarrage.
   */
  private async readPassword(): Promise<string> {
    if (this.config.password) return this.config.password;

    let raw: string;
    try {
      // turbopackIgnore : chemin fourni à l'exécution.
      raw = await readFile(/* turbopackIgnore: true */ this.config.passwordFile, "utf8");
    } catch (error) {
      throw new RconError("config_password", {
        detail: `passwordFile=${this.config.passwordFile} ${errorFields(error).error}`,
      });
    }

    // Même traitement que read_password() dans docker/rcon/main.c.
    const password = raw.trim();
    if (!password) {
      throw new RconError("config_password", {
        detail: `passwordFile=${this.config.passwordFile} vide`,
      });
    }
    return password;
  }

  private drop(connection: Rcon | null) {
    if (connection && this.connection === connection) this.connection = null;
  }

  private classifyConnect(error: unknown): RconError {
    const errno = errnoOf(error);
    const target = `host=${this.config.host} port=${this.config.port}`;

    if (errno) {
      return new RconError("connection_refused", { detail: `${target} errno=${errno}` });
    }

    const message = error instanceof Error ? error.message : String(error);
    if (/timeout/i.test(message)) {
      return new RconError("timeout", { detail: `${target} ${message}` });
    }

    // Pas de code errno pendant la phase connexion+auth de rcon-client :
    // la socket est ouverte, c'est donc l'authentification qui a échoué.
    return new RconError("auth_rejected", { detail: `${target} ${message}` });
  }

  private classifySend(error: unknown): RconError {
    if (error instanceof RconError) return error;

    const errno = errnoOf(error);
    const target = `host=${this.config.host} port=${this.config.port}`;

    if (errno) {
      return new RconError("connection_lost", { detail: `${target} errno=${errno}` });
    }

    const message = error instanceof Error ? error.message : String(error);
    if (/timeout/i.test(message)) {
      return new RconError("timeout", { detail: `${target} ${message}` });
    }

    return new RconError("protocol", { detail: `${target} ${message}` });
  }

  private async connect(): Promise<Rcon> {
    if (this.connection) return this.connection;

    const password = await this.readPassword();
    const connection = new Rcon({
      host: this.config.host,
      port: this.config.port,
      password,
      timeout: this.config.timeoutMs,
    });

    // Listeners posés avant connect() : un 'error' sans listener ferait
    // remonter une exception non rattrapée depuis l'EventEmitter.
    connection.on("error", (error) => {
      this.lastErrorAt = Date.now();
      logger.warn("rcon socket error", errorFields(error));
      this.drop(connection);
    });
    connection.on("end", () => this.drop(connection));

    try {
      await connection.connect();
    } catch (error) {
      throw this.classifyConnect(error);
    }

    this.connections += 1;
    this.connection = connection;
    logger.info("rcon connected", { host: this.config.host, port: this.config.port });
    return connection;
  }

  private async run(command: string): Promise<RconExecution> {
    const startedAt = Date.now();
    let lastError: RconError | null = null;

    // Deux tentatives : la socket en cache peut avoir été fermée par un
    // redémarrage de Factorio sans que l'événement soit encore arrivé.
    for (let attempt = 0; attempt < 2; attempt++) {
      let connection: Rcon | null = null;
      try {
        connection = await this.connect();
        const output = await connection.send(command);
        this.lastLatencyMs = Date.now() - startedAt;
        this.totalCommands += 1;
        return { command, output, durationMs: this.lastLatencyMs };
      } catch (error) {
        lastError = this.classifySend(error);
        this.drop(connection);

        if (lastError.code === "configuration" || lastError.code === "invalid_command") break;
      }
    }

    this.failedCommands += 1;
    this.lastErrorAt = Date.now();
    const failure = lastError ?? new RconError("internal");
    logger.warn("rcon command failed", {
      code: failure.code,
      detail: failure.detail,
      head: command.split(/\s+/)[0],
    });
    throw failure;
  }

  /** Exécute une commande, en respectant la file bornée. */
  async execute(rawCommand: string): Promise<RconExecution> {
    const command = normalizeCommand(rawCommand);

    if (this.depth >= this.config.maxQueue) {
      throw new RconError("backpressure", {
        detail: `queueDepth=${this.depth} maxQueue=${this.config.maxQueue}`,
      });
    }

    this.depth += 1;
    const task = this.queue.then(
      () => this.run(command),
      () => this.run(command),
    );
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );

    try {
      return await task;
    } finally {
      this.depth -= 1;
    }
  }

  /** Vérifie que le serveur répond ; utilisé par la sonde de readiness. */
  async healthCheck(): Promise<{ ok: true; latencyMs: number } | { ok: false; error: RconError }> {
    try {
      const result = await this.execute("/version");
      return { ok: true, latencyMs: result.durationMs };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof RconError
            ? error
            : new RconError("probe_failed"),
      };
    }
  }

  async shutdown(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    if (!connection) return;

    try {
      await connection.end();
      logger.info("rcon disconnected");
    } catch (error) {
      logger.warn("rcon disconnect failed", errorFields(error));
    }
  }
}
