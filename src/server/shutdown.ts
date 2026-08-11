import { logger } from "@/server/log";
import { shutdownRcon } from "@/server/rcon";

/**
 * Arrêt propre : fermeture de la connexion RCON quand le conteneur est stoppé.
 * Isolé dans son module pour n'être chargé que depuis le runtime Node.
 */
export function registerShutdownHooks() {
  const shutdown = async (signal: string) => {
    logger.info("panel stopping", { signal });
    await shutdownRcon();
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
