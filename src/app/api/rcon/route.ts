import { z } from "zod";
import { route } from "@/server/http/context";
import { ApiFailure } from "@/server/http/errors";
import { limiters } from "@/server/auth/limiters";
import { getRcon } from "@/server/rcon";
import { invalidateStatusCache } from "@/server/rcon/status";
import { isRconError } from "@/server/rcon/errors";
import { MAX_COMMAND_BYTES } from "@/server/rcon/command";
import { recordAudit } from "@/server/audit/service";
import type { RconResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RconBody = z.object({ command: z.string().min(1).max(MAX_COMMAND_BYTES) });

/**
 * Raw console: full RCON access, reserved for the role holding `rcon:raw`.
 * Lower roles go through /api/actions, whose commands the server builds itself.
 */
export const POST = route(
  { name: "rcon", mutation: true, permission: "rcon:raw" },
  async ({ json, session, ip, requestId }) => {
    const current = session!;

    // A legitimate account must not be able to saturate the RCON queue.
    const verdict = limiters().rconPerSession.consume(`session:${current.id}`);
    if (!verdict.allowed) {
      recordAudit({
        username: current.username,
        role: current.role,
        kind: "rcon",
        action: "command",
        status: "denied",
        detail: "rate limit",
        ip,
        requestId,
      });
      throw ApiFailure.tooManyRequests("rate_limited_session", verdict.retryAfter);
    }

    const parsed = RconBody.safeParse(await json());
    if (!parsed.success) {
      throw ApiFailure.badRequest("command_missing");
    }

    try {
      const execution = await getRcon().execute(parsed.data.command);
      invalidateStatusCache();

      recordAudit({
        username: current.username,
        role: current.role,
        kind: "rcon",
        action: "command",
        command: execution.command,
        status: "success",
        durationMs: execution.durationMs,
        ip,
        requestId,
      });

      const body: RconResult = {
        ok: true,
        command: execution.command,
        output: execution.output,
        durationMs: execution.durationMs,
      };
      return Response.json(body);
    } catch (error) {
      recordAudit({
        username: current.username,
        role: current.role,
        kind: "rcon",
        action: "command",
        command: parsed.data.command,
        status: "error",
        detail: isRconError(error) ? `${error.code}: ${error.detail}` : String(error),
        ip,
        requestId,
      });
      throw error;
    }
  },
);
