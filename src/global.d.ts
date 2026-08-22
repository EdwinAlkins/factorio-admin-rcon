import type messages from "../messages/en.json";
import type { routing } from "@/i18n/routing";

/**
 * Typage des clés de traduction : `en.json` fait référence, ce qui transforme
 * une clé inexistante en erreur de compilation. Les clés construites à
 * l'exécution passent par `useDynamicTranslations` et sont couvertes par
 * `tests/i18n/messages.test.ts`.
 */
declare module "next-intl" {
  interface AppConfig {
    Locale: (typeof routing.locales)[number];
    Messages: typeof messages;
  }
}
