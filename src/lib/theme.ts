/**
 * Theme cookie, shared by the server layout (which stamps `data-theme` on
 * `<html>`) and the client switcher (which flips it). Kept dependency-free so
 * both sides can import it.
 */
export const THEME_COOKIE = "theme";

export const THEMES = ["dark", "light"] as const;

export type Theme = (typeof THEMES)[number];

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}
