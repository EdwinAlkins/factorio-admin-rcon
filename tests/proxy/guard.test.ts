import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { SESSION_COOKIE } from "@/lib/session-cookie";

/**
 * The proxy guard and the protected pages answer each other: if the two
 * redirect on different criteria, they bounce the request back and forth
 * forever. That is exactly what happened with an expired cookie — the proxy saw
 * "signed in", the page saw "not signed in".
 */
function visit(path: string, cookie?: string) {
  const request = new NextRequest(new URL(`http://panel.test${path}`), {
    headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {},
  });

  const response = proxy(request);
  const location = response.headers.get("location");
  return { status: response.status, to: location ? new URL(location).pathname : null };
}

describe("the proxy's session guard", () => {
  it("redirects to sign-in when the cookie is absent", () => {
    expect(visit("/")).toMatchObject({ to: "/login" });
    expect(visit("/fr")).toMatchObject({ to: "/fr/login" });
  });

  it("lets the sign-in page render without a cookie", () => {
    expect(visit("/login").to).toBeNull();
    expect(visit("/fr/login").to).toBeNull();
  });

  it("does NOT divert the sign-in page on the mere presence of a cookie", () => {
    // The heart of the loop: the proxy does not know whether this cookie is
    // worth anything. The sign-in page decides, through `readSession()`.
    expect(visit("/login", "perime").to).toBeNull();
    expect(visit("/fr/login", "perime").to).toBeNull();
  });

  it("does not send a request that already carries a cookie to /login", () => {
    // Otherwise the protected page, which redirects to /login when the session
    // is invalid, would form the other half of the loop.
    expect(visit("/", "perime").to).toBeNull();
    expect(visit("/fr", "perime").to).toBeNull();
  });

  it("can no longer produce a cycle, whatever the cookie's state", () => {
    // A full round trip: every destination must be stable.
    for (const cookie of [undefined, "perime"]) {
      const first = visit("/fr", cookie);
      if (first.to === null) continue;

      const second = visit(first.to, cookie);
      expect(second.to, `${first.to} renvoie vers ${second.to}`).toBeNull();
    }
  });
});
