"use client";

import { useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing, type Locale } from "@/i18n/routing";

/**
 * Change la langue en restant sur la page courante. La navigation passe par le
 * proxy, qui met à jour le cookie de préférence au passage : le choix survit
 * donc à la session.
 */
export default function LocaleSwitcher() {
  const t = useTranslations("localeSwitcher");
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <label className="text-xs text-muted">
      <span className="sr-only">{t("label")}</span>
      <select
        className="field px-2 py-1 text-xs"
        value={locale}
        disabled={pending}
        aria-label={t("label")}
        onChange={(event) => {
          const next = event.target.value as Locale;
          startTransition(() => router.replace(pathname, { locale: next }));
        }}
      >
        {routing.locales.map((option) => (
          <option key={option} value={option}>
            {t(option)}
          </option>
        ))}
      </select>
    </label>
  );
}
