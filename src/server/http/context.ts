import { cookies } from "next/headers";
import { env } from "@/server/config/env";
import { verifySessionToken, type Session } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/lib/session-cookie";
import { can, type Permission } from "@/lib/permissions";
import { errorFields, logger, newRequestId } from "@/server/log";
import { ConfigError } from "@/server/config/env";
import { ApiFailure, retryAfterOf } from "@/server/http/errors";
import { RCON_HTTP_STATUS, RconError } from "@/server/rcon/errors";

export type ApiContext = {
  request: Request;
  requestId: string;
  ip: string | null;
  session: Session | null;
};

export function jsonError(message: string, status: number, code?: string) {
  return Response.json({ ok: false, error: message, code }, { status });
}

/**
 * IP du client. `X-Forwarded-For` n'est pris en compte que si TRUST_PROXY=true :
 * sinon n'importe qui pourrait forger une IP différente à chaque requête et
 * réinitialiser sa limite de tentatives.
 */
export function clientIp(request: Request): string | null {
  if (!env().TRUST_PROXY) return null;

  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || null;
}

/** Clé de limitation : par IP si elle est fiable, sinon un seau global. */
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
 * Défense CSRF complémentaire de SameSite=Lax : sur les requêtes mutantes,
 * l'origine annoncée doit correspondre à l'hôte servi.
 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin) return true; // requêtes non-navigateur (curl, sondes) : pas de CSRF possible
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
    logger.error("Lecture de session impossible", errorFields(error));
    return null;
  }
}

type RouteOptions = {
  /** `false` pour une route publique (health). Par défaut une session est exigée. */
  auth?: boolean;
  permission?: Permission;
  /** Active la vérification d'origine (POST/PUT/DELETE). */
  mutation?: boolean;
  name: string;
};

/**
 * Enveloppe commune : identifiant de requête, contrôle d'origine, session,
 * permission, log structuré et filet anti-500 silencieux.
 */
export function route(options: RouteOptions, handler: (ctx: ApiContext) => Promise<Response>) {
  return async function handleRequest(request: Request): Promise<Response> {
    const requestId = newRequestId();
    const startedAt = Date.now();
    let response: Response;

    try {
      if (options.mutation && !sameOrigin(request)) {
        response = jsonError("Origine non autorisée.", 403, "bad_origin");
      } else {
        const session = options.auth === false ? null : await readSession();

        if (options.auth !== false && !session) {
          response = jsonError("Non authentifié.", 401, "unauthenticated");
        } else if (options.permission && session && !can(session.role, options.permission)) {
          response = jsonError("Permission insuffisante.", 403, "forbidden");
        } else {
          response = await handler({ request, requestId, ip: clientIp(request), session });
        }
      }
    } catch (error) {
      if (error instanceof ApiFailure) {
        const retryAfter = retryAfterOf(error);
        response = Response.json(
          { ok: false, error: error.message, code: error.code },
          {
            status: error.status,
            headers: retryAfter ? { "retry-after": String(retryAfter) } : undefined,
          },
        );
      } else if (error instanceof RconError) {
        // Détail technique dans les logs, message neutre pour le client.
        logger.warn("rcon error", {
          requestId,
          route: options.name,
          code: error.code,
          detail: error.detail,
        });
        response = jsonError(error.message, RCON_HTTP_STATUS[error.code], error.code);
      } else if (error instanceof ConfigError) {
        logger.error("Configuration invalide", { requestId, ...errorFields(error) });
        response = jsonError(error.message, 500, "config");
      } else {
        logger.error("Erreur non gérée", {
          requestId,
          route: options.name,
          ...errorFields(error),
        });
        response = jsonError("Erreur interne du panneau.", 500, "internal");
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
