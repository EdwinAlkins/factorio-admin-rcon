import createMiddleware from "next-intl/middleware";
import { hasLocale } from "next-intl";
import { NextResponse, type NextRequest } from "next/server";
import { routing, localizedPath, type Locale } from "@/i18n/routing";
import { SESSION_COOKIE } from "@/lib/session-cookie";

const handleI18nRouting = createMiddleware(routing);

/**
 * A 128-bit nonce, unpredictable and unique per request. Global `crypto` and
 * `btoa` both exist in the two runtimes the proxy may run in.
 */
function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Nonce-based CSP. An `'unsafe-inline'` on `script-src` reduced the policy to
 * very little: any injected script ran. With a nonce, only scripts the server
 * emitted start — and `'unsafe-inline'` becomes inert as soon as a nonce is
 * present, which is exactly the intended effect.
 *
 * `style-src` keeps `'unsafe-inline'`: the charts set `style` attributes on SVG
 * elements, which `style-src` blocks without it. CSS injection does not carry
 * the reach of script injection — the trade-off is deliberate, and it no longer
 * concerns JavaScript.
 */
function contentSecurityPolicy(nonce: string): string {
  // React uses `eval` in development to reconstruct server call stacks in the
  // browser. Nothing of the sort happens in production.
  const dev = process.env.NODE_ENV === "development";

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/** Splits the locale prefix from the rest of the path: `/fr/login` → `fr` + `/login`. */
function splitLocale(pathname: string): { locale: Locale; path: string } {
  const [, first, ...rest] = pathname.split("/");

  if (hasLocale(routing.locales, first)) {
    return { locale: first, path: `/${rest.join("/")}` };
  }

  // No prefix: with `as-needed`, that means the default locale.
  return { locale: routing.defaultLocale, path: pathname };
}

/**
 * Two responsibilities chained in this order:
 *
 * 1. i18n normalises the URL (it alone knows which language applies: prefix,
 *    then cookie, then `Accept-Language`);
 * 2. the session guard reasons on the path stripped of its prefix, and rebuilds
 *    its redirect targets with that prefix.
 *
 * That guard stays a convenience redirect: it only checks the PRESENCE of the
 * cookie, not its signature — the proxy has access to neither the signing key
 * nor the session store. It can therefore only redirect in the direction where
 * an absent cookie is conclusive; any inference from a present cookie would be
 * a bet, and a lost bet loops with the page, which does know.
 *
 * The real check is done by `readSession()` in every API route and in the
 * protected pages, sign-in included.
 */
export function proxy(request: NextRequest) {
  const nonce = newNonce();
  const csp = contentSecurityPolicy(nonce);
  const withCsp = <T extends { headers: Headers }>(value: T): T => {
    value.headers.set("content-security-policy", csp);
    return value;
  };

  // Next reads the nonce from the header carried by the **request** to stamp it
  // on its own `<script>` tags during rendering; the response header is what
  // imposes it on the browser. Both are needed.
  // next-intl copies the request headers (`new Headers(request.headers)`) into
  // the response it builds, so mutating them here is enough to propagate them.
  request.headers.set("x-nonce", nonce);
  request.headers.set("content-security-policy", csp);

  const response = handleI18nRouting(request);

  // i18n decided on a redirect (non-canonical URL): let it through. The browser
  // will come back on the canonical URL and the guard will apply then.
  if (response.headers.has("location")) return withCsp(response);

  const { locale, path } = splitLocale(request.nextUrl.pathname);

  // An ABSENT cookie is a certainty: nobody can be signed in without one, so
  // the redirect is safe. The converse is not — a present cookie may be
  // expired, revoked or forged — and redirecting on that presence alone created
  // a loop: the proxy sent /login to /, the page checked the real session, did
  // not find one, and sent back to /login.
  //
  // The symmetric case (valid session landing on /login) is handled by the
  // sign-in page itself, which calls `readSession()` and is authoritative.
  if (!request.cookies.has(SESSION_COOKIE) && path !== "/login") {
    return withCsp(NextResponse.redirect(new URL(localizedPath(locale, "/login"), request.url)));
  }

  return withCsp(response);
}

export const config = {
  // Broader than `["/", "/login"]`: with a locale prefix the URLs become `/fr`,
  // `/fr/login`…, which an exact match would miss. `/api` stays excluded —
  // those routes run their own session check.
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
