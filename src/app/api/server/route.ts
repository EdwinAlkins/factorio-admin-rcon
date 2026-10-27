import { route } from "@/server/http/context";
import { requireControl } from "@/server/control/routes";
import { getServerState } from "@/server/control/service";
import type { ServerResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server state for every role: container (Docker), game (RCON) and the
 * operation in progress. An unreachable agent is part of the answer
 * (`state: "unknown"`), not an error: the interface must still render.
 */
export const GET = route({ name: "server", permission: "server:read" }, async () => {
  requireControl();
  const body: ServerResult = { ok: true, ...(await getServerState()) };
  return Response.json(body);
});
