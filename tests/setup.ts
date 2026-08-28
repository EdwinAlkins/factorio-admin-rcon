import { vi } from "vitest";

/**
 * `SESSION_SECRET` has been required ever since the password-derived key was
 * removed. The tests supply an explicit one rather than reintroducing a
 * fallback: they must run in the same configuration as production.
 */
process.env.SESSION_SECRET ??= "cle-de-signature-de-test-32-octets";

/**
 * Cookie store for the request in progress.
 *
 * The API tests call the route handlers directly, with no server: outside a
 * Next request context, `cookies()` throws. It is replaced by a store the
 * harness (`tests/api/helpers.ts`) drives and inspects, which is what allows
 * asserting on the attributes actually set on the session cookie.
 */
export type TestCookie = { name: string; value: string; options: Record<string, unknown> };

const jar = vi.hoisted(() => new Map<string, { name: string; value: string; options: Record<string, unknown> }>());

(globalThis as typeof globalThis & { __testCookieJar?: typeof jar }).__testCookieJar = jar;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => jar.get(name),
    set: (name: string, value: string, options: Record<string, unknown> = {}) => {
      jar.set(name, { name, value, options });
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
}));
