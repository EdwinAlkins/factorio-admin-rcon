import { expect } from "vitest";
import { createSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/lib/session-cookie";
import type { Role } from "@/lib/permissions";

/**
 * API test harness: the exported route handlers are invoked with a real
 * `Request`, which goes through the whole `route()` wrapper — origin, session,
 * permission, body size, error translation.
 */

export const HOST = "panel.test";
export const ORIGIN = `http://${HOST}`;

type Jar = Map<string, { name: string; value: string; options: Record<string, unknown> }>;

/** Cookies set and read by the routes; see the `next/headers` mock. */
export function cookieJar(): Jar {
  return (globalThis as typeof globalThis & { __testCookieJar: Jar }).__testCookieJar;
}

export function clearCookies() {
  cookieJar().clear();
}

/** Opens a valid session and puts it in the cookie store. */
export function signIn(role: Role, username = role): string {
  const { token } = createSession({ username, role });
  cookieJar().set(SESSION_COOKIE, { name: SESSION_COOKIE, value: token, options: {} });
  return token;
}

export function setCookie(value: string) {
  cookieJar().set(SESSION_COOKIE, { name: SESSION_COOKIE, value, options: {} });
}

/** Some routes (`health`, `ready`) are not asynchronous. */
export type Handler = (request: Request) => Response | Promise<Response>;

type CallOptions = {
  method?: string;
  path?: string;
  /** Body serialised as JSON. */
  body?: unknown;
  /** Raw body, for cases `JSON.stringify` cannot express. */
  raw?: string;
  /** `null` simule un appel hors navigateur (curl, sonde) : aucune origine. */
  origin?: string | null;
  headers?: Record<string, string>;
};

export type CallResult = {
  status: number;
  body: Record<string, unknown>;
  response: Response;
};

export async function call(handler: Handler, options: CallOptions = {}): Promise<CallResult> {
  const { method = "GET", path = "/api/test", body, raw, origin = ORIGIN, headers = {} } = options;

  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));

  const response = await handler(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        host: HOST,
        ...(origin === null ? {} : { origin }),
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(payload === undefined ? {} : { body: payload }),
    }),
  );

  return {
    status: response.status,
    body: (await response.clone().json().catch(() => ({}))) as Record<string, unknown>,
    response,
  };
}

/** Shorthand: an error response always carries `{ ok: false, code }`. */
export function expectError(result: CallResult, status: number, code: string) {
  expect({ status: result.status, code: result.body.code }).toEqual({ status, code });
}
