import { englishError } from "@/server/error-text";
import type { ErrorParams } from "@/lib/api-types";

/**
 * Erreur applicative portant son code HTTP, transformée en JSON par `route()`.
 *
 * On ne manipule plus de texte ici : `code` est la clé de traduction et
 * `params` ses valeurs. Le message anglais n'est calculé que pour rester
 * lisible dans les logs et pour les appels hors interface.
 */
export class ApiFailure extends Error {
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
