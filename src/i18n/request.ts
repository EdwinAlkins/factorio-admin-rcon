import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { routing } from "@/i18n/routing";

/**
 * `timeZone` is set explicitly: without it, next-intl would use the Node
 * process's zone for any server rendering, which is not the browser's.
 * Displayed timestamps are formatted client-side anyway (the admin's local
 * zone); this setting only covers formats that happen to render server-side.
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
