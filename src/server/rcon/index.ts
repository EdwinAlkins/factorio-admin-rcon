import { env } from "@/server/config/env";
import { RconService } from "@/server/rcon/service";

/**
 * One instance per process (one RCON connection, one queue), kept on
 * `globalThis` to survive `next dev`'s hot reload.
 *
 * Deliberate deployment constraint: 1 container = 1 Node process = 1 RCON
 * connection. See "security model" in the README.
 */
const globalRef = globalThis as typeof globalThis & { __factorioRconService?: RconService };

export function getRcon(): RconService {
  if (globalRef.__factorioRconService) return globalRef.__factorioRconService;

  const config = env();
  globalRef.__factorioRconService = new RconService({
    host: config.RCON_HOST,
    port: config.RCON_PORT,
    timeoutMs: config.RCON_TIMEOUT_MS,
    maxQueue: config.RCON_MAX_QUEUE,
    password: config.RCON_PASSWORD,
    passwordFile: config.RCON_PASSWORD_FILE,
  });

  return globalRef.__factorioRconService;
}

/**
 * Permanent shutdown of the process's RCON connection.
 *
 * The singleton is deliberately **not** cleared: a request arriving after the
 * signal must land on the shutting-down service, which refuses it, rather than
 * building a fresh one that would reopen a socket right after the SIGTERM.
 */
export async function shutdownRcon(): Promise<void> {
  await globalRef.__factorioRconService?.shutdown();
}

export function rconTarget(): string {
  const config = env();
  return `${config.RCON_HOST}:${config.RCON_PORT}`;
}
