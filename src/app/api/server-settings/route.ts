import { route } from "@/server/http/context";
import { ApiFailure } from "@/server/http/errors";
import { limiters } from "@/server/auth/limiters";
import { recordAudit } from "@/server/audit/service";
import {
  readServerSettings,
  requestServerSettingsApply,
  requireServerSettings,
  ServerSettingsChange,
  writeServerSettings,
} from "@/server/server-settings/service";
import type { ServerOperationResult, ServerSettingsResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The editable keys of server-settings.json, and which secrets are set. Never a secret's value. */
export const GET = route({ name: "server-settings", permission: "server:configure" }, async () => {
  requireServerSettings();
  const body: ServerSettingsResult = { ok: true, ...(await readServerSettings()) };
  return Response.json(body);
});

/**
 * Changes them. `restart: false` writes the file for the next start and
 * answers the new view; `restart: true` is an operation (`202`), which
 * restarts the server and rolls the file back if it does not come back.
 */
export const PUT = route(
  { name: "server-settings.update", mutation: true, permission: "server:configure", maxBodyBytes: 32 * 1024 },
  async ({ json, session, ip, requestId }) => {
    requireServerSettings();
    const current = session!;
    const actor = { username: current.username, role: current.role, ip, requestId };

    // Validated first: a malformed body reaches nothing, so it spends no budget.
    const parsed = ServerSettingsChange.safeParse(await json());
    if (!parsed.success) throw ApiFailure.badRequest("invalid_body");

    const verdict = limiters().serverPerSession.consume(`session:${current.id}`);
    if (!verdict.allowed) {
      recordAudit({ ...actor, kind: "server", action: "server_settings", status: "denied", detail: "rate limit" });
      throw ApiFailure.tooManyRequests("rate_limited_session", verdict.retryAfter);
    }

    if (parsed.data.restart) {
      const operation = await requestServerSettingsApply(parsed.data, actor);
      const body: ServerOperationResult = { ok: true, operation };
      return Response.json(body, { status: 202 });
    }
    const view = await writeServerSettings(parsed.data, actor);
    const body: ServerSettingsResult = { ok: true, ...view, operation: null };
    return Response.json(body);
  },
);
