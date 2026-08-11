import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/session-cookie";

/**
 * Redirection de confort uniquement : on ne vérifie ici que la PRÉSENCE du
 * cookie, pas sa signature. Le contrôle réel est fait par getSession() dans
 * chaque route API et dans les pages protégées.
 */
export function proxy(request: NextRequest) {
  const hasCookie = request.cookies.has(SESSION_COOKIE);
  const isLoginPage = request.nextUrl.pathname === "/login";

  if (!hasCookie && !isLoginPage) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (hasCookie && isLoginPage) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/login"],
};
