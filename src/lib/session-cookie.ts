/**
 * Name of the session cookie, isolated in its own module: the middleware may
 * run on the Edge runtime and must not import `lib/auth` (which depends on
 * `node:crypto`).
 */
export const SESSION_COOKIE = "fa_session";
