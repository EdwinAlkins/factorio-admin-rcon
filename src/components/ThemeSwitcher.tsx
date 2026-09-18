"use client";

import { useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { THEME_COOKIE, isTheme, type Theme } from "@/lib/theme";

const ONE_YEAR = 60 * 60 * 24 * 365;

/**
 * `data-theme` on `<html>` is the source of truth: the layout stamps it from the
 * cookie before the first paint. Reading it through `useSyncExternalStore` keeps
 * React in sync with that attribute without copying it into state.
 */
function readTheme(): Theme {
  const current = document.documentElement.dataset.theme;
  return isTheme(current) ? current : "dark";
}

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

function serverTheme(): Theme {
  return "dark";
}

/**
 * Flips `data-theme` on `<html>`; the palette itself lives in `globals.css`.
 * The choice is mirrored into a cookie so the server can render the right theme
 * on the next load, and remembered for a year — same idea as the locale cookie.
 */
export default function ThemeSwitcher() {
  const t = useTranslations("themeSwitcher");
  const theme = useSyncExternalStore(subscribe, readTheme, serverTheme);

  function toggle() {
    const next: Theme = readTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
  }

  return (
    <button
      type="button"
      className="btn"
      onClick={toggle}
      aria-label={t("label")}
      title={t("label")}
    >
      {theme === "dark" ? t("light") : t("dark")}
    </button>
  );
}
