/** Erreur applicative portant son code HTTP, transformée en JSON par `route()`. */
export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code = "error") {
    super(message);
    this.name = "ApiFailure";
    this.status = status;
    this.code = code;
  }

  static badRequest(message: string, code = "bad_request") {
    return new ApiFailure(400, message, code);
  }

  static forbidden(message = "Permission insuffisante.", code = "forbidden") {
    return new ApiFailure(403, message, code);
  }

  static notFound(message: string, code = "not_found") {
    return new ApiFailure(404, message, code);
  }

  static tooManyRequests(message: string, retryAfter: number) {
    const failure = new ApiFailure(429, message, "rate_limited");
    return Object.assign(failure, { retryAfter });
  }
}

export function retryAfterOf(error: unknown): number | null {
  const value = (error as { retryAfter?: unknown })?.retryAfter;
  return typeof value === "number" ? value : null;
}
