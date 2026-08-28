import { logger } from "@/server/log";
import { shutdownRcon } from "@/server/rcon";
import { stopMetricsCollector } from "@/server/metrics/collector";

/**
 * Clean shutdown: the metrics collector is stopped and the RCON connection
 * closed when the container is stopped.
 * Isolated in its own module so it is only loaded from the Node runtime.
 */
export function registerShutdownHooks() {
  const shutdown = async (signal: string) => {
    logger.info("panel stopping", { signal });
    stopMetricsCollector();
    await shutdownRcon();
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
