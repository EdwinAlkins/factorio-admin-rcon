import { z } from "zod";

/**
 * Configuration, centralised and validated exactly once.
 *
 * Any malformed variable (a non-numeric port, a negative duration…) is caught
 * here rather than in the middle of a request. `src/instrumentation.ts` forces
 * this validation when the server starts.
 */

/** See `isRconError`: `instanceof` does not survive a duplicated module. */
const CONFIG_ERROR = Symbol.for("factorio-admin.ConfigError");

export function isConfigError(value: unknown): value is ConfigError {
  return typeof value === "object" && value !== null && CONFIG_ERROR in value;
}

export class ConfigError extends Error {
  readonly [CONFIG_ERROR] = true;

  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const booleanish = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const EnvSchema = z.object({
  // Authentication: one password per role. No password set at all means no
  // account, so the panel starts but refuses every sign-in.
  ADMIN_PASSWORD: z.string().min(1).optional(),
  MODERATOR_PASSWORD: z.string().min(1).optional(),
  VIEWER_PASSWORD: z.string().min(1).optional(),

  // Required, and independent from the passwords: a key derived from them tied
  // together two unrelated rotations (changing one password signed everybody
  // out) and made session signatures depend on a human-chosen secret.
  // `setup-admin.sh` generates one.
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().max(720).default(12),
  // "auto": `secure` cookie as soon as the request arrives over HTTPS.
  COOKIE_SECURE: z.enum(["auto", "true", "false"]).default("auto"),
  // Only enable behind a trusted reverse proxy: otherwise anyone can forge
  // X-Forwarded-For and walk around the per-IP limit.
  TRUST_PROXY: booleanish.default(false),

  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  LOGIN_GLOBAL_MAX_ATTEMPTS: z.coerce.number().int().positive().default(50),

  RCON_HOST: z.string().min(1).default("factorio"),
  RCON_PORT: z.coerce.number().int().min(1).max(65535).default(27015),
  RCON_PASSWORD: z.string().min(1).optional(),
  RCON_PASSWORD_FILE: z.string().min(1).default("/factorio-config/rconpw"),
  RCON_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  // Backpressure: beyond this, commands are refused (503) instead of piling
  // up indefinitely in front of a single socket.
  RCON_MAX_QUEUE: z.coerce.number().int().positive().default(20),
  RCON_MAX_PER_MINUTE: z.coerce.number().int().positive().default(60),
  STATUS_CACHE_MS: z.coerce.number().int().nonnegative().default(5000),

  // The operator's command catalogue, mounted read-only. An absent file means
  // the feature is inactive, not that the configuration is wrong.
  CUSTOM_COMMANDS_FILE: z.string().min(1).default("/factorio-config/commands.json"),

  DATA_DIR: z.string().min(1).default("./.data"),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  // Keeps raw-console commands verbatim in the audit log. Off by default: see
  // `recordAudit` — the log must not become a second place where a
  // mistakenly pasted secret lives on.
  AUDIT_FULL_COMMANDS: booleanish.default(false),

  // Server control (start/stop/restart/logs) and container metrics both go
  // through the control agent, the only component holding the Docker socket
  // (see services/agents). CONTROL_ENABLED=false removes the Server tab
  // and its endpoints; container metrics have their own flag below.
  CONTROL_ENABLED: booleanish.default(true),
  // Constrained on purpose: `z.url()` alone would accept "control-agent:8080"
  // by reading it as an exotic URL scheme, and the error would only surface on
  // the first fetch, hours later.
  CONTROL_AGENT_URL: z.url({ protocol: /^https?$/ }).default("http://control-agent:8080"),
  // Token shared with the agent. The file (a Compose secret) is preferred: a
  // variable shows up in `docker inspect`.
  CONTROL_AGENT_TOKEN: z.string().min(32).optional(),
  CONTROL_AGENT_TOKEN_FILE: z.string().min(1).default("/run/secrets/control_agent_token"),
  // Deadline of a read (status, stats, logs). Distinct from RCON_TIMEOUT_MS: a
  // stats reading ties up the daemon for ~1 s to compute its CPU delta, where
  // RCON is a low-latency persistent socket. Start/stop/restart get their own,
  // much longer deadline: they last as long as Factorio takes to quit.
  CONTROL_AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // How long a stop waits for Factorio to report "Saving finished" after
  // `/server-save` before giving up. Large maps take tens of seconds.
  CONTROL_SAVE_TIMEOUT_MS: z.coerce.number().int().min(5000).default(120_000),

  // Saves: archives, downloads, restores and scheduled backups, through the
  // data agent — the only component writing the game's files, and one that
  // never sees the Docker socket. SAVES_ENABLED=false removes the Saves tab,
  // its endpoints and the scheduler.
  SAVES_ENABLED: booleanish.default(true),
  DATA_AGENT_URL: z.url({ protocol: /^https?$/ }).default("http://data-agent:8080"),
  // Distinct from the control agent's: a compromised agent cannot use its
  // token to call the other.
  DATA_AGENT_TOKEN: z.string().min(32).optional(),
  DATA_AGENT_TOKEN_FILE: z.string().min(1).default("/run/secrets/data_agent_token"),
  // Deadline of a listing. Archiving and restoring get their own, much
  // longer one: they copy and verify whole saves.
  DATA_AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // Mods: installed list, updates, search and install from the official
  // portal, through the same data agent. MODS_ENABLED=false removes the Mods
  // tab and its endpoints. With both this and SAVES_ENABLED off, the data
  // agent is not used at all.
  MODS_ENABLED: booleanish.default(true),

  // Worlds: seed previews, world creation, a library of worlds, through the
  // world agent — which runs the game's binary and never touches the
  // server's saves. Activating a world is a restore through the data agent.
  // WORLDS_ENABLED=false removes the Worlds tab and its endpoints.
  WORLDS_ENABLED: booleanish.default(true),
  WORLD_AGENT_URL: z.url({ protocol: /^https?$/ }).default("http://world-agent:8080"),
  WORLD_AGENT_TOKEN: z.string().min(32).optional(),
  WORLD_AGENT_TOKEN_FILE: z.string().min(1).default("/run/secrets/world_agent_token"),
  // Deadline of a listing. Previews and new maps get their own, longer one:
  // they run the game.
  WORLD_AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // Metrics, in three levels: one master switch and two sources.
  //
  // METRICS_ENABLED=false turns the whole feature off — no collector, no tab,
  // no endpoint — and the two source flags below are then not even consulted.
  // The remaining variables keep being validated: a malformed value must show
  // up at startup, not months later on the day someone re-enables metrics.
  METRICS_ENABLED: booleanish.default(true),
  // Container source (CPU + memory), read from the control agent. At false,
  // only the RCON-sourced metrics are collected; the rest of the panel keeps
  // working.
  METRICS_DOCKER: booleanish.default(true),
  // Floored at 5 s: every Docker reading ties up the daemon for ~1 s to
  // compute the CPU delta, and an RCON sample crosses the serialised queue.
  METRICS_INTERVAL_MS: z.coerce.number().int().min(5000).default(15_000),
  METRICS_RETENTION_DAYS: z.coerce.number().int().positive().max(365).default(7),
  // Measures UPS through a Lua command: turn it off if the save's achievements
  // matter (they are disabled in multiplayer anyway).
  METRICS_UPS: booleanish.default(true),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof EnvSchema>;

const KEYS = Object.keys(EnvSchema.shape) as (keyof Env)[];

/** Configuration source: `process.env` in production, an object in tests. */
export type EnvSource = Record<string, string | undefined>;

/** An empty variable (`FOO=` in docker-compose) counts as "unset". */
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

/** Validated configuration, cached for the lifetime of the process. */
export function env(): Env {
  return (globalRef.__factorioEnv ??= parseEnv());
}
