import type messages from "../messages/en.json";
import type { routing } from "@/i18n/routing";

/**
 * Typing of the translation keys: `en.json` is the reference, which turns a
 * non-existent key into a compile error. Keys built at runtime go through
 * `useDynamicTranslations` and are covered by `tests/i18n/messages.test.ts`.
 */
declare module "next-intl" {
  interface AppConfig {
    Locale: (typeof routing.locales)[number];
    Messages: typeof messages;
  }
}
