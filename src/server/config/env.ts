import { z } from "zod";

/**
 * Configuration centralisée et validée une seule fois.
 *
 * Toute variable mal formée (port non numérique, durée négative…) est détectée
 * ici plutôt qu'au milieu d'une requête. `src/instrumentation.ts` force cette
 * validation au démarrage du serveur.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const booleanish = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const EnvSchema = z.object({
  // Authentification : un mot de passe par rôle. Aucun mot de passe défini =
  // aucun compte, le panneau démarre mais refuse toute connexion.
  ADMIN_PASSWORD: z.string().min(1).optional(),
  MODERATOR_PASSWORD: z.string().min(1).optional(),
  VIEWER_PASSWORD: z.string().min(1).optional(),

  SESSION_SECRET: z.string().min(16).optional(),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().max(720).default(12),
  // "auto" : cookie `secure` dès que la requête arrive en HTTPS.
  COOKIE_SECURE: z.enum(["auto", "true", "false"]).default("auto"),
  // N'activer que derrière un reverse proxy de confiance : sinon n'importe qui
  // peut forger X-Forwarded-For et contourner la limite par IP.
  TRUST_PROXY: booleanish.default(false),

  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  LOGIN_GLOBAL_MAX_ATTEMPTS: z.coerce.number().int().positive().default(50),

  RCON_HOST: z.string().min(1).default("factorio"),
  RCON_PORT: z.coerce.number().int().min(1).max(65535).default(27015),
  RCON_PASSWORD: z.string().min(1).optional(),
  RCON_PASSWORD_FILE: z.string().min(1).default("/factorio-config/rconpw"),
  RCON_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  // Backpressure : au-delà, les commandes sont refusées (503) au lieu de
  // s'empiler indéfiniment devant une seule socket.
  RCON_MAX_QUEUE: z.coerce.number().int().positive().default(20),
  RCON_MAX_PER_MINUTE: z.coerce.number().int().positive().default(60),
  STATUS_CACHE_MS: z.coerce.number().int().nonnegative().default(5000),

  DATA_DIR: z.string().min(1).default("./.data"),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof EnvSchema>;

const KEYS = Object.keys(EnvSchema.shape) as (keyof Env)[];

/** Source de configuration : `process.env` en production, un objet dans les tests. */
export type EnvSource = Record<string, string | undefined>;

/** Une variable vide (`FOO=` dans docker-compose) vaut « non définie ». */
function readRawEnv(source: EnvSource): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const key of KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") {
      raw[key] = value;
    }
  }
  return raw;
}

export function parseEnv(source: EnvSource = process.env): Env {
  const result = EnvSchema.safeParse(readRawEnv(source));

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(racine)"} : ${issue.message}`)
      .join(" ; ");
    throw new ConfigError(`Configuration invalide — ${details}`);
  }

  return result.data;
}

const globalRef = globalThis as typeof globalThis & { __factorioEnv?: Env };

/** Configuration validée, mise en cache pour la durée du processus. */
export function env(): Env {
  return (globalRef.__factorioEnv ??= parseEnv());
}
