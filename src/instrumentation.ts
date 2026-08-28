/**
 * Runs once when the Next server starts.
 * Validates the configuration immediately rather than on the first request,
 * purges expired data and closes the RCON connection cleanly.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { env } = await import("@/server/config/env");
  const { logger, errorFields } = await import("@/server/log");

  let config;
  try {
    config = env();
  } catch (error) {
    // The panel starts anyway: /api/ready will report it "unavailable" and
    // every route will return an explicit error.
    logger.error("invalid configuration at startup", errorFields(error));
    return;
  }

  const { hasAnyAccount } = await import("@/server/auth/users");
  if (!hasAnyAccount()) {
    logger.warn("no password configured: every sign-in will be refused");
  }

  try {
    const { purgeExpiredSessions } = await import("@/server/auth/session");
    const { purgeAudit } = await import("@/server/audit/service");
    purgeExpiredSessions();
    const purged = purgeAudit();

    // Metrics off: nothing to purge, and above all nothing to start. Rows
    // already collected stay in the database — re-enabling must give the
    // history back, not start from scratch.
    if (config.METRICS_ENABLED) {
      const { purgeMetrics } = await import("@/server/metrics/service");
      purgeMetrics();
    }

    // Load the operator's catalogue here rather than on the first request: a
    // faulty entry must show up in the startup logs.
    const { loadCustomCatalog } = await import("@/server/actions/custom");
    const commands = loadCustomCatalog();

    logger.info("panel started", {
      rcon: `${config.RCON_HOST}:${config.RCON_PORT}`,
      dataDir: config.DATA_DIR,
      auditPurged: purged,
      metrics: config.METRICS_ENABLED,
      commands: commands.actions.length,
      commandsRejected: commands.rejected,
      trustProxy: config.TRUST_PROXY,
    });

    const { startMetricsCollector } = await import("@/server/metrics/collector");
    startMetricsCollector();
  } catch (error) {
    logger.error("storage initialisation failed", errorFields(error));
  }

  const { registerShutdownHooks } = await import("@/server/shutdown");
  registerShutdownHooks();
}
