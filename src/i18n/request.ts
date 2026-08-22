import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { routing } from "@/i18n/routing";

/**
 * `timeZone` est fixé explicitement : sans lui, next-intl utiliserait le fuseau
 * du process Node pour tout rendu serveur, qui n'est pas celui du navigateur.
 * Les horodatages affichés sont malgré tout formatés côté client (fuseau local
 * de l'admin) ; ce réglage ne sert que d'éventuels formats rendus côté serveur.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
    timeZone: process.env.TZ || "UTC",
  };
});
