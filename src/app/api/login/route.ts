import { cookies } from "next/headers";
import { z } from "zod";
import { authenticate, hasAnyAccount } from "@/server/auth/users";
import { createSession } from "@/server/auth/session";
import { limiters } from "@/server/auth/limiters";
import { ApiFailure } from "@/server/http/errors";
import { cookieOptions, rateKey, route } from "@/server/http/context";
import { recordAudit } from "@/server/audit/service";
import { env } from "@/server/config/env";
import { SESSION_COOKIE } from "@/lib/session-cookie";
import { logger } from "@/server/log";
import type { LoginResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LoginBody = z.object({ password: z.string().min(1).max(512) });

export const POST = route(
  { name: "login", auth: false, mutation: true },
  async ({ request, ip, requestId }) => {
    const { key, perIp } = rateKey(request);
    const { loginPerIp, loginGlobal } = limiters();

    const globalVerdict = loginGlobal.check("all");
    if (!globalVerdict.allowed) {
      throw ApiFailure.tooManyRequests(
        `Trop de tentatives sur le panneau. Réessayez dans ${globalVerdict.retryAfter} s.`,
        globalVerdict.retryAfter,
      );
    }

    if (perIp) {
      const verdict = loginPerIp.check(key);
      if (!verdict.allowed) {
        throw ApiFailure.tooManyRequests(
          `Trop de tentatives. Réessayez dans ${verdict.retryAfter} s.`,
          verdict.retryAfter,
        );
      }
    }

    const parsed = LoginBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw ApiFailure.badRequest("Mot de passe manquant.");
    }

    if (!hasAnyAccount()) {
      logger.error("Aucun mot de passe configuré : toute connexion est refusée", { requestId });
      throw new ApiFailure(
        500,
        "Aucun compte configuré : définissez ADMIN_PASSWORD pour utiliser le panneau.",
        "no_account",
      );
    }

    const user = authenticate(parsed.data.password);
    if (!user) {
      loginGlobal.consume("all");
      if (perIp) loginPerIp.consume(key);

      recordAudit({
        username: "?",
        role: "?",
        kind: "auth",
        action: "login",
        status: "denied",
        detail: "mot de passe incorrect",
        ip,
        requestId,
      });

      throw new ApiFailure(401, "Mot de passe incorrect.", "bad_credentials");
    }

    if (perIp) loginPerIp.reset(key);

    const { token } = createSession(user);
    const store = await cookies();
    store.set(
      SESSION_COOKIE,
      token,
      cookieOptions(request, env().SESSION_TTL_HOURS * 60 * 60),
    );

    recordAudit({
      username: user.username,
      role: user.role,
      kind: "auth",
      action: "login",
      status: "success",
      ip,
      requestId,
    });

    const body: LoginResult = { ok: true, username: user.username, role: user.role };
    return Response.json(body);
  },
);
