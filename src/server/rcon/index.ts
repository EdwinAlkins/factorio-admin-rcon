import { env } from "@/server/config/env";
import { RconService } from "@/server/rcon/service";

/**
 * Instance unique par processus (une connexion RCON, une file).
 * Conservée sur `globalThis` pour survivre au hot-reload de `next dev`.
 *
 * Contrainte de déploiement assumée : 1 conteneur = 1 processus Node =
 * 1 connexion RCON. Voir « modèle de sécurité » dans le README.
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

export async function shutdownRcon(): Promise<void> {
  const service = globalRef.__factorioRconService;
  globalRef.__factorioRconService = undefined;
  await service?.shutdown();
}

export function rconTarget(): string {
  const config = env();
  return `${config.RCON_HOST}:${config.RCON_PORT}`;
}
