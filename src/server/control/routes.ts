import { z } from "zod";
import { env } from "@/server/config/env";
import { route } from "@/server/http/context";
import { ApiFailure } from "@/server/http/errors";
import { limiters } from "@/server/auth/limiters";
import { recordAudit } from "@/server/audit/service";
import { AgentError } from "@/server/agents/errors";
import { requestOperation } from "@/server/control/service";
import type { Permission } from "@/lib/permissions";
import type { ServerOperationResult } from "@/lib/api-types";

/** CONTROL_ENABLED=false: the endpoints answer as if they did not exist. */
export function requireControl() {
  if (!env().CONTROL_ENABLED) throw new AgentError("control_disabled");
}

/**
 * `force` bypasses the two safety checks of a stop or restart: players still
 * connected, and RCON not answering (no save possible before stopping).
 */
const OperationBody = z.object({ force: z.boolean().optional() }).strict();

/** Handler shared by `POST /api/server/{start,stop,restart}`. */
export function operationRoute(type: "start" | "stop" | "restart", permission: Permission) {
  return route(
    { name: `server.${type}`, mutation: true, permission, maxBodyBytes: 1024 },
    async ({ json, session, ip, requestId }) => {
      requireControl();
      const current = session!;

      const verdict = limiters().serverPerSession.consume(`session:${current.id}`);
      if (!verdict.allowed) {
        recordAudit({
          username: current.username,
          role: current.role,
          kind: "server",
          action: type,
          status: "denied",
          detail: "rate limit",
          ip,
          requestId,
        });
        throw ApiFailure.tooManyRequests("rate_limited_session", verdict.retryAfter);
      }

      // An empty body means "no options".
      const parsed = OperationBody.safeParse((await json()) ?? {});
      if (!parsed.success) throw ApiFailure.badRequest("invalid_body");

      const operation = await requestOperation({
        type,
        force: parsed.data.force ?? false,
        username: current.username,
        role: current.role,
        ip,
        requestId,
      });

      const body: ServerOperationResult = { ok: true, operation };
      return Response.json(body, { status: 202 });
    },
  );
}
