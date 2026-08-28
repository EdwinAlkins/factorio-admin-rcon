import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { SESSION_COOKIE } from "@/lib/session-cookie";

/**
 * The panel's CSP carries a nonce per request: `'unsafe-inline'` on
 * `script-src` let any injected script run.
 */

function visit(path: string, options: { cookie?: boolean } = {}) {
  const request = new NextRequest(new URL(`http://panel.test${path}`), {
    headers: options.cookie ? { cookie: `${SESSION_COOKIE}=jeton` } : {},
  });

  const response = proxy(request);
  return { request, response, csp: response.headers.get("content-security-policy") ?? "" };
}

function nonceOf(csp: string): string | null {
  return csp.match(/'nonce-([^']+)'/)?.[1] ?? null;
}

describe("content security policy", () => {
  it("sets a CSP on the pages", () => {
    const { csp } = visit("/login");

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it("allows no inline script without a nonce", () => {
    const { csp } = visit("/login");
    const scriptSrc = csp.split("; ").find((directive) => directive.startsWith("script-src"))!;

    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).not.toContain("unsafe-eval");
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(nonceOf(scriptSrc)).not.toBeNull();
  });

  it("generates an unpredictable nonce, different on every request", () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 20; i++) nonces.add(nonceOf(visit("/login").csp)!);

    expect(nonces.size).toBe(20);
    // 128 bits en base64.
    for (const nonce of nonces) expect(atob(nonce)).toHaveLength(16);
  });

  it("passes the nonce to Next through the request header", () => {
    // Next reads the request's CSP to stamp it on its own `<script>` tags:
    // without that propagation, no panel script starts at all.
    const { request, csp } = visit("/login");

    expect(request.headers.get("x-nonce")).toBe(nonceOf(csp));
    expect(request.headers.get("content-security-policy")).toBe(csp);
  });

  it("covers the session guard's redirect too", () => {
    // With no cookie, a protected page redirects to /login: that response is
    // built separately and could easily go out without the header.
    const redirected = visit("/");
    expect(redirected.response.headers.get("location")).toContain("/login");
    expect(nonceOf(redirected.csp)).not.toBeNull();

    // And the response that lets the request through carries one too.
    const passed = visit("/login", { cookie: true });
    expect(passed.response.headers.get("location")).toBeNull();
    expect(nonceOf(passed.csp)).not.toBeNull();
  });
});
