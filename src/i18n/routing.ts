import { defineRouting } from "next-intl/routing";

/**
 * `as-needed`: the default locale is not prefixed (`/login`), the others are
 * (`/fr/login`). The user's choice is remembered in a cookie set by the proxy,
 * which avoids forcing `Accept-Language` on them at every visit.
 */
export const routing = defineRouting({
  locales: ["en", "fr"],
  defaultLocale: "en",
  localePrefix: "as-needed",
});

export type Locale = (typeof routing.locales)[number];

/** Prefixed path for this locale, honouring `as-needed`. */
export function localizedPath(locale: Locale, path: string): string {
  if (locale === routing.defaultLocale) return path;
  return path === "/" ? `/${locale}` : `/${locale}${path}`;
}
