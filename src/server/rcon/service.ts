import { readFile } from "node:fs/promises";
import { Rcon } from "rcon-client";
import { errnoOf, isRconError, RconError } from "@/server/rcon/errors";
import { normalizeCommand } from "@/server/rcon/command";
import { errorFields, logger } from "@/server/log";

export type RconConfig = {
  host: string;
  port: number;
  timeoutMs: number;
  /** Maximum queued commands before refusing (backpressure). */
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

/** A command waiting its turn on the single socket. */
type QueueItem = {
  command: string;
  resolve: (execution: RconExecution) => void;
  reject: (error: unknown) => void;
};

/**
 * RCON service: one connection, a bounded queue, some metrics.
 *
 * Factorio's RCON protocol handles one command at a time on a socket, so
 * commands are serialised. The queue is **bounded** so an authenticated client
 * cannot stack up thousands of requests (denial of service).
 *
 * The queue is a real list with a single consumer, not a `Promise` chain: a
 * chain cannot be drained. At shutdown we must be able to *refuse* what has not
 * started — otherwise already-chained tasks wake up after the socket is closed
 * and reopen one (see `shutdown()`).
 */
export class RconService {
  private connection: Rcon | null = null;
  private pending: QueueItem[] = [];
  private draining = false;
  /** Terminal state: the service refuses everything and never reconnects. */
  private stopping: Promise<void> | null = null;
  private totalCommands = 0;
  private failedCommands = 0;
  private connections = 0;
  private lastLatencyMs: number | null = null;
  private lastErrorAt: number | null = null;

  constructor(private readonly config: RconConfig) {}

  /** Commands accepted but not yet settled, the in-flight one included. */
  private get depth(): number {
    return this.pending.length + (this.draining ? 1 : 0);
  }

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
   * Re-read on every new connection (rather than cached for the life of the
   * process): a regenerated `rconpw` is picked up without a restart.
   */
  private async readPassword(): Promise<string> {
    if (this.config.password) return this.config.password;

    let raw: string;
    try {
      // turbopackIgnore: the path is supplied at runtime.
      raw = await readFile(/* turbopackIgnore: true */ this.config.passwordFile, "utf8");
    } catch (error) {
      throw new RconError("config_password", {
        detail: `passwordFile=${this.config.passwordFile} ${errorFields(error).error}`,
      });
    }

    // Same handling as read_password() in docker/rcon/main.c.
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

    // No errno during rcon-client's connect+auth phase: the socket is open, so
    // it is authentication that failed.
    return new RconError("auth_rejected", { detail: `${target} ${message}` });
  }

  private classifySend(error: unknown): RconError {
    if (isRconError(error)) return error;

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

    // The single place a socket is opened, so the shutdown guard lives here and
    // therefore also covers `run()`'s retry, which could otherwise reconnect
    // while the close is under way.
    if (this.stopping) throw new RconError("service_stopping");

    const password = await this.readPassword();
    const connection = new Rcon({
      host: this.config.host,
      port: this.config.port,
      password,
      timeout: this.config.timeoutMs,
    });

    // Listeners attached before connect(): an 'error' with no listener would
    // surface as an uncaught exception from the EventEmitter.
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

    // Two attempts: the cached socket may have been closed by a Factorio
    // restart without the event having arrived yet.
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

  /** Runs a command, honouring the bounded queue. */
  async execute(rawCommand: string): Promise<RconExecution> {
    // Checked before anything else: once shutdown has begun, the service gives
    // one answer and one only, whatever the command.
    if (this.stopping) throw new RconError("service_stopping");

    const command = normalizeCommand(rawCommand);

    if (this.depth >= this.config.maxQueue) {
      throw new RconError("backpressure", {
        detail: `queueDepth=${this.depth} maxQueue=${this.config.maxQueue}`,
      });
    }

    return new Promise<RconExecution>((resolve, reject) => {
      this.pending.push({ command, resolve, reject });
      void this.drain();
    });
  }

  /**
   * The queue's only consumer. Re-entrant: a second call while a command is in
   * flight returns immediately, and the running loop picks up the rest.
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      for (let item = this.pending.shift(); item; item = this.pending.shift()) {
        // Shutdown may have been requested while the previous command ran.
        if (this.stopping) {
          item.reject(new RconError("service_stopping"));
          continue;
        }

        try {
          item.resolve(await this.run(item.command));
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Checks that the server answers; used by the readiness probe. */
  async healthCheck(): Promise<{ ok: true; latencyMs: number } | { ok: false; error: RconError }> {
    try {
      const result = await this.execute("/version");
      return { ok: true, latencyMs: result.durationMs };
    } catch (error) {
      return {
        ok: false,
        error:
          isRconError(error) ? error : new RconError("probe_failed"),
      };
    }
  }

  /**
   * Closes the socket without stopping the service: the next command reopens
   * one and re-reads the password. Used when Factorio restarts.
   */
  async disconnect(): Promise<void> {
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

  /**
   * **Permanent** shutdown of the service (SIGTERM). Idempotent: concurrent
   * callers share the same promise and await the same completion.
   *
   * The order is imposed: mark the shutdown, *then* refuse the queue, *then*
   * close the socket. The reverse would let a queued command start and reopen a
   * connection right after the signal.
   *
   * Any in-flight command is not awaited: it fails along with the socket. A
   * shutdown must be bounded, not suspended on the RCON timeout.
   */
  shutdown(): Promise<void> {
    return (this.stopping ??= this.stop());
  }

  private async stop(): Promise<void> {
    const refused = this.pending;
    this.pending = [];
    for (const item of refused) item.reject(new RconError("service_stopping"));

    if (refused.length > 0) {
      logger.info("rcon queue drained on shutdown", { refused: refused.length });
    }

    await this.disconnect();
  }
}
