import { route } from "@/server/http/context";
import { ApiFailure } from "@/server/http/errors";
import { agentLogs } from "@/server/control/client";
import { requireControl } from "@/server/control/routes";
import type { ServerLogsResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Same bounds as the agent, checked here to answer with the panel's codes. */
const DEFAULT_TAIL = 200;
const MAX_TAIL = 1000;

/** Last lines of the Factorio container's output. Administrators only. */
export const GET = route({ name: "server.logs", permission: "server:logs" }, async ({ request }) => {
  requireControl();

  const raw = new URL(request.url).searchParams.get("tail");
  const tail = raw === null ? DEFAULT_TAIL : Number(raw);
  if (!Number.isInteger(tail) || tail < 1 || tail > MAX_TAIL) {
    throw ApiFailure.badRequest("invalid_tail", { max: MAX_TAIL });
  }

  const body: ServerLogsResult = { ok: true, lines: await agentLogs({ tail }) };
  return Response.json(body);
});
