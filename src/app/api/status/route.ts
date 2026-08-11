import { route } from "@/server/http/context";
import { getServerStatus } from "@/server/rcon/status";
import type { StatusResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route({ name: "status", permission: "status:read" }, async () => {
  const snapshot = await getServerStatus();

  const body: StatusResult = {
    ok: true,
    online: snapshot.online,
    count: snapshot.count,
    version: snapshot.version,
    target: snapshot.target,
    cachedAt: snapshot.cachedAt,
  };
  return Response.json(body);
});
