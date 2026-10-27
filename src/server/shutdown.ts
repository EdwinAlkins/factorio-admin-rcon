import { logger } from "@/server/log";
import { shutdownRcon } from "@/server/rcon";
import { stopMetricsCollector } from "@/server/metrics/collector";
import { stopBackupScheduler } from "@/server/saves/scheduler";

/**
 * Clean shutdown: the metrics collector and the backup scheduler are stopped
 * and the RCON connection closed when the container is stopped.
 * Isolated in its own module so it is only loaded from the Node runtime.
 */
export function registerShutdownHooks() {
  const shutdown = async (signal: string) => {
    logger.info("panel stopping", { signal });
    stopMetricsCollector();
    stopBackupScheduler();
    await shutdownRcon();
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
