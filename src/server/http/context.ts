import { cookies } from "next/headers";
import { env } from "@/server/config/env";
import { verifySessionToken, type Session } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/lib/session-cookie";
import { can, type Permission } from "@/lib/permissions";
import { errorFields, logger, newRequestId } from "@/server/log";
import { isConfigError } from "@/server/config/env";
import { ApiFailure, isApiFailure, retryAfterOf } from "@/server/http/errors";
import { isRconError, RCON_HTTP_STATUS } from "@/server/rcon/errors";
import { englishError } from "@/server/error-text";
import type { ApiError, ErrorParams } from "@/lib/api-types";

export type ApiContext = {
  request: Request;
  requestId: string;
  ip: string | null;
  session: Session | null;
  /**
   * JSON body, **bounded** (see `maxBodyBytes`). Returns `null` when the body is
   * absent or unreadable — routes turn that into a 400 with their own code.
   * Throws a 413 before allocating anything if the body exceeds the limit.
   */
  json: () => Promise<unknown>;
};

/**
 * Default cap on a request body.
 *
 * Generous next to the largest legitimate payload (an RCON command tops out at
 * 4 kB), but finite: without it, `request.json()` allocates whatever it is sent
 * *before* zod gets a chance to say "too long".
 */
export const MAX_BODY_BYTES = 16 * 1024;

/**
 * The panel's single error body: `code` is the translation key the interface
 * uses, `error` its English fallback for non-browser callers.
 */
export function jsonError(status: number, code: string, params?: ErrorParams) {
  const body: ApiError = { ok: false, error: englishError(code, params), code, params };
  return Response.json(body, { status });
}

/**
 * Client IP. `X-Forwarded-For` is only taken into account when TRUST_PROXY=true:
 * otherwise anyone could forge a different IP on every request and reset their
 * own attempt limit.
 */
export function clientIp(request: Request): string | null {
  if (!env().TRUST_PROXY) return null;

  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || null;
}

/** Rate-limit key: per IP when it is trustworthy, otherwise a global bucket. */
export function rateKey(request: Request): { key: string; perIp: boolean } {
  const ip = clientIp(request);
  return ip ? { key: `ip:${ip}`, perIp: true } : { key: "global", perIp: false };
}

export function isSecureRequest(request: Request): boolean {
  if (env().TRUST_PROXY) {
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    if (proto) return proto === "https";
  }
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function cookieOptions(request: Request, maxAge: number) {
  const configured = env().COOKIE_SECURE;
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: configured === "auto" ? isSecureRequest(request) : configured === "true",
    maxAge,
  };
}

/**
 * CSRF defence complementing SameSite=Lax: on mutating requests, the announced
 * origin must match the host being served.
 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin) return true; // non-browser callers (curl, probes): no CSRF possible
  if (!host) return false;

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function readSession(): Promise<Session | null> {
  try {
    const store = await cookies();
    return verifySessionToken(store.get(SESSION_COOKIE)?.value);
  } catch (error) {
    logger.error("session read failed", errorFields(error));
    return null;
  }
}

type RouteOptions = {
  /** `false` for a public route (health). A session is required by default. */
  auth?: boolean;
  permission?: Permission;
  /** Enables the origin check (POST/PUT/DELETE). */
  mutation?: boolean;
  /** Maximum accepted body size, in bytes. */
  maxBodyBytes?: number;
  name: string;
};

/**
 * Bounded reading of the body.
 *
 * Two barriers, because they do not cover the same case: `Content-Length` lets
 * us refuse without reading anything, but it is absent under
 * `Transfer-Encoding: chunked` and does not bind the sender anyway. Counting
 * while reading is the only authoritative check.
 */
async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiFailure(413, "body_too_large", { max: maxBytes });
  }

  const body = request.body;
  if (!body) return null;

  const chunks: Uint8Array[] = [];
  let size = 0;

  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      size += value.byteLength;
      if (size > maxBytes) {
        throw new ApiFailure(413, "body_too_large", { max: maxBytes });
      }
      chunks.push(value);
    }
  } finally {
    // Cut the stream: without this, a refused sender would keep sending.
    await reader.cancel().catch(() => undefined);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Common wrapper: request id, origin check, session, permission, structured
 * logging and a net against silent 500s.
 */
export function route(options: RouteOptions, handler: (ctx: ApiContext) => Promise<Response>) {
  return async function handleRequest(request: Request): Promise<Response> {
    const requestId = newRequestId();
    const startedAt = Date.now();
    let response: Response;

    try {
      if (options.mutation && !sameOrigin(request)) {
        response = jsonError(403, "bad_origin");
      } else {
        const session = options.auth === false ? null : await readSession();

        if (options.auth !== false && !session) {
          response = jsonError(401, "unauthenticated");
        } else if (options.permission && session && !can(session.role, options.permission)) {
          response = jsonError(403, "forbidden");
        } else {
          const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
          response = await handler({
            request,
            requestId,
            ip: clientIp(request),
            session,
            json: () => readBoundedJson(request, maxBodyBytes),
          });
        }
      }
    } catch (error) {
      if (isApiFailure(error)) {
        const retryAfter = retryAfterOf(error);
        const body: ApiError = {
          ok: false,
          error: error.message,
          code: error.code,
          params: error.params,
        };
        response = Response.json(body, {
          status: error.status,
          headers: retryAfter ? { "retry-after": String(retryAfter) } : undefined,
        });
      } else if (isRconError(error)) {
        // Technical detail in the logs, neutral message for the client.
        logger.warn("rcon error", {
          requestId,
          route: options.name,
          code: error.code,
          detail: error.detail,
        });
        response = jsonError(RCON_HTTP_STATUS[error.code], error.key, error.params);
      } else if (isConfigError(error)) {
        // The detail of an invalid config stays in the logs: it may quote
        // variable names and internal paths.
        logger.error("invalid configuration", { requestId, ...errorFields(error) });
        response = jsonError(500, "config");
      } else {
        logger.error("unhandled error", {
          requestId,
          route: options.name,
          ...errorFields(error),
        });
        response = jsonError(500, "internal");
      }
    }

    logger.info("http", {
      requestId,
      route: options.name,
      method: request.method,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });

    return response;
  };
}
