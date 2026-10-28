import { env } from "@/server/config/env";
import { FixedWindowLimiter } from "@/server/auth/rate-limit";

/**
 * Rate limiters shared across the process.
 *
 * Two levels for sign-in:
 *  - per IP, only when the IP is trustworthy (TRUST_PROXY behind a proxy);
 *  - global, always active, covering the case where no IP can be known.
 *
 * Without a trustworthy IP the only applicable threshold is the global one.
 * That is deliberate: a "per IP" threshold computed from a forgeable header
 * would give a false impression of protection.
 */

type Limiters = {
  loginPerIp: FixedWindowLimiter;
  loginGlobal: FixedWindowLimiter;
  rconPerSession: FixedWindowLimiter;
  serverPerSession: FixedWindowLimiter;
  uploadChunksPerSession: FixedWindowLimiter;
  worldPreviewsPerSession: FixedWindowLimiter;
};

const globalRef = globalThis as typeof globalThis & { __factorioLimiters?: Limiters };

export const SERVER_OPERATIONS_PER_MINUTE = 6;

/** 8 MB each: 80 MB/s, past any uplink, and still a bound on disk writes. */
export const UPLOAD_CHUNKS_PER_MINUTE = 600;

/** Each runs the game for a second or two: enough to try seeds one after another. */
export const WORLD_PREVIEWS_PER_MINUTE = 20;

export function limiters(): Limiters {
  if (globalRef.__factorioLimiters) return globalRef.__factorioLimiters;

  const config = env();
  const windowMs = config.LOGIN_WINDOW_MINUTES * 60 * 1000;

  globalRef.__factorioLimiters = {
    loginPerIp: new FixedWindowLimiter(config.LOGIN_MAX_ATTEMPTS, windowMs),
    loginGlobal: new FixedWindowLimiter(config.LOGIN_GLOBAL_MAX_ATTEMPTS, windowMs),
    rconPerSession: new FixedWindowLimiter(config.RCON_MAX_PER_MINUTE, 60 * 1000),
    // Start/stop/restart: a handful per minute is already more than a human
    // needs, and each one disconnects every player.
    serverPerSession: new FixedWindowLimiter(SERVER_OPERATIONS_PER_MINUTE, 60 * 1000),
    uploadChunksPerSession: new FixedWindowLimiter(UPLOAD_CHUNKS_PER_MINUTE, 60 * 1000),
    worldPreviewsPerSession: new FixedWindowLimiter(WORLD_PREVIEWS_PER_MINUTE, 60 * 1000),
  };

  return globalRef.__factorioLimiters;
}

/** Resets the limiters (tests). */
export function resetLimiters() {
  globalRef.__factorioLimiters = undefined;
}
