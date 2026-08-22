/**
 * Exécuté une fois au démarrage du serveur Next.
 * Valide la configuration immédiatement plutôt qu'à la première requête,
 * purge les données expirées et ferme proprement la connexion RCON.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { env } = await import("@/server/config/env");
  const { logger, errorFields } = await import("@/server/log");

  let config;
  try {
    config = env();
  } catch (error) {
    // Le panneau démarre quand même : /api/ready le signalera « unavailable »
    // et chaque route renverra une erreur explicite.
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
    logger.info("panel started", {
      rcon: `${config.RCON_HOST}:${config.RCON_PORT}`,
      dataDir: config.DATA_DIR,
      auditPurged: purged,
      trustProxy: config.TRUST_PROXY,
    });
  } catch (error) {
    logger.error("storage initialisation failed", errorFields(error));
  }

  const { registerShutdownHooks } = await import("@/server/shutdown");
  registerShutdownHooks();
}
