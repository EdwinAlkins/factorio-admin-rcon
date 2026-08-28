import en from "../../messages/en.json";
import type { ErrorParams } from "@/lib/api-types";

/**
 * English fallback for error messages, taken from the same dictionary as the
 * interface: one source of truth, no second table to keep in sync.
 *
 * Interpolation is deliberately naive (`{key}`) — a subset of ICU. Messages
 * under `errors.*` must therefore contain neither plurals nor selectors, unlike
 * the rest of the dictionaries.
 */
const ERRORS: Record<string, string> = en.errors;

export function englishError(code: string, params?: ErrorParams): string {
  const template = ERRORS[code] ?? ERRORS.unknown;

  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params?.[key];
    return value === undefined ? match : String(value);
  });
}

/** True when the code has a dedicated message (otherwise the UI shows `errors.unknown`). */
export function isKnownErrorCode(code: string): boolean {
  return code in ERRORS;
}
