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
    logger.error("Configuration invalide au démarrage", errorFields(error));
    return;
  }

  const { hasAnyAccount } = await import("@/server/auth/users");
  if (!hasAnyAccount()) {
    logger.warn("Aucun mot de passe configuré : toute connexion sera refusée");
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
    logger.error("Initialisation du stockage impossible", errorFields(error));
  }

  const { registerShutdownHooks } = await import("@/server/shutdown");
  registerShutdownHooks();
}
