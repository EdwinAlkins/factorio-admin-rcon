import { defineRouting } from "next-intl/routing";

/**
 * `as-needed` : la locale par défaut n'est pas préfixée (`/login`), les autres
 * le sont (`/fr/login`). Le choix de l'utilisateur est mémorisé dans un cookie
 * posé par le proxy, ce qui évite de lui réimposer `Accept-Language` à chaque
 * visite.
 */
export const routing = defineRouting({
  locales: ["en", "fr"],
  defaultLocale: "en",
  localePrefix: "as-needed",
});

export type Locale = (typeof routing.locales)[number];

/** Chemin préfixé pour cette locale, en respectant `as-needed`. */
export function localizedPath(locale: Locale, path: string): string {
  if (locale === routing.defaultLocale) return path;
  return path === "/" ? `/${locale}` : `/${locale}${path}`;
}
