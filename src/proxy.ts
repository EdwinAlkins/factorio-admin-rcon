import createMiddleware from "next-intl/middleware";
import { hasLocale } from "next-intl";
import { NextResponse, type NextRequest } from "next/server";
import { routing, localizedPath, type Locale } from "@/i18n/routing";
import { SESSION_COOKIE } from "@/lib/session-cookie";

const handleI18nRouting = createMiddleware(routing);

/** Sépare le préfixe de langue du reste du chemin : `/fr/login` → `fr` + `/login`. */
function splitLocale(pathname: string): { locale: Locale; path: string } {
  const [, first, ...rest] = pathname.split("/");

  if (hasLocale(routing.locales, first)) {
    return { locale: first, path: `/${rest.join("/")}` };
  }

  // Pas de préfixe : avec `as-needed`, c'est la locale par défaut.
  return { locale: routing.defaultLocale, path: pathname };
}

/**
 * Deux responsabilités enchaînées, dans cet ordre :
 *
 * 1. l'i18n normalise l'URL (elle seule sait quelle langue s'applique : préfixe,
 *    puis cookie, puis `Accept-Language`) ;
 * 2. le garde de session raisonne sur le chemin débarrassé du préfixe, et
 *    reconstruit ses cibles de redirection avec ce préfixe.
 *
 * Ce garde reste une redirection de confort : on ne vérifie que la PRÉSENCE du
 * cookie, pas sa signature. Le contrôle réel est fait par getSession() dans
 * chaque route API et dans les pages protégées.
 */
export function proxy(request: NextRequest) {
  const response = handleI18nRouting(request);

  // L'i18n a décidé une redirection (URL non canonique) : on la laisse aboutir.
  // Le navigateur reviendra sur l'URL canonique et le garde s'appliquera alors.
  if (response.headers.has("location")) return response;

  const { locale, path } = splitLocale(request.nextUrl.pathname);
  const hasCookie = request.cookies.has(SESSION_COOKIE);
  const isLoginPage = path === "/login";

  if (!hasCookie && !isLoginPage) {
    return NextResponse.redirect(new URL(localizedPath(locale, "/login"), request.url));
  }

  if (hasCookie && isLoginPage) {
    return NextResponse.redirect(new URL(localizedPath(locale, "/"), request.url));
  }

  return response;
}

export const config = {
  // Élargi par rapport à `["/", "/login"]` : avec un préfixe de langue les URLs
  // deviennent `/fr`, `/fr/login`…, qu'une correspondance exacte manquerait.
  // `/api` reste exclu — ces routes font leur propre contrôle de session.
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
