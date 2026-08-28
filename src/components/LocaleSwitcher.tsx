"use client";

import { useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing, type Locale } from "@/i18n/routing";

/**
 * Changes the language while staying on the current page. Navigation goes
 * through the proxy, which updates the preference cookie on the way, so the
 * choice outlives the session.
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
