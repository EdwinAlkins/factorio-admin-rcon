import { englishError } from "@/server/error-text";
import type { ErrorParams } from "@/lib/api-types";

/**
 * Application error carrying its HTTP status, turned into JSON by `route()`.
 *
 * No text is handled here any more: `code` is the translation key and `params`
 * its values. The English message is only computed to stay readable in the logs
 * and for callers outside the interface.
 */
/** See `isRconError`: `instanceof` does not survive a duplicated module. */
const BRAND = Symbol.for("factorio-admin.ApiFailure");

export function isApiFailure(value: unknown): value is ApiFailure {
  return typeof value === "object" && value !== null && BRAND in value;
}

export class ApiFailure extends Error {
  readonly [BRAND] = true;
  readonly status: number;
  readonly code: string;
  readonly params?: ErrorParams;

  constructor(status: number, code: string, params?: ErrorParams) {
    super(englishError(code, params));
    this.name = "ApiFailure";
    this.status = status;
    this.code = code;
    this.params = params;
  }

  static badRequest(code: string, params?: ErrorParams) {
    return new ApiFailure(400, code, params);
  }

  static forbidden(code = "forbidden", params?: ErrorParams) {
    return new ApiFailure(403, code, params);
  }

  static notFound(code: string, params?: ErrorParams) {
    return new ApiFailure(404, code, params);
  }

  static tooManyRequests(code: string, retryAfter: number) {
    const failure = new ApiFailure(429, code, { seconds: retryAfter });
    return Object.assign(failure, { retryAfter });
  }
}

export function retryAfterOf(error: unknown): number | null {
  const value = (error as { retryAfter?: unknown })?.retryAfter;
  return typeof value === "number" ? value : null;
}
