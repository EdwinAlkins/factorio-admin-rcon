import { env } from "@/server/config/env";
import { FixedWindowLimiter } from "@/server/auth/rate-limit";

/**
 * Limiteurs partagés du processus.
 *
 * Deux niveaux pour la connexion :
 *  - par IP, seulement quand l'IP est fiable (TRUST_PROXY derrière un proxy) ;
 *  - global, toujours actif, qui couvre le cas où aucune IP n'est connaissable.
 *
 * Sans IP fiable, le seul seuil applicable est le seuil global : c'est
 * volontaire, un seuil « par IP » calculé sur un en-tête forgeable donnerait
 * une fausse impression de protection.
 */

type Limiters = {
  loginPerIp: FixedWindowLimiter;
  loginGlobal: FixedWindowLimiter;
  rconPerSession: FixedWindowLimiter;
};

const globalRef = globalThis as typeof globalThis & { __factorioLimiters?: Limiters };

export function limiters(): Limiters {
  if (globalRef.__factorioLimiters) return globalRef.__factorioLimiters;

  const config = env();
  const windowMs = config.LOGIN_WINDOW_MINUTES * 60 * 1000;

  globalRef.__factorioLimiters = {
    loginPerIp: new FixedWindowLimiter(config.LOGIN_MAX_ATTEMPTS, windowMs),
    loginGlobal: new FixedWindowLimiter(config.LOGIN_GLOBAL_MAX_ATTEMPTS, windowMs),
    rconPerSession: new FixedWindowLimiter(config.RCON_MAX_PER_MINUTE, 60 * 1000),
  };

  return globalRef.__factorioLimiters;
}

/** Réinitialise les limiteurs (tests). */
export function resetLimiters() {
  globalRef.__factorioLimiters = undefined;
}
