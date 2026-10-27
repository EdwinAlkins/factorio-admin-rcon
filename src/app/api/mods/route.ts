import { route } from "@/server/http/context";
import { listMods, requireMods } from "@/server/mods/service";
import type { ModsResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The server's mods, the updates available, and any operation in progress. */
export const GET = route({ name: "mods", permission: "mods:read" }, async () => {
  requireMods();
  const body: ModsResult = { ok: true, ...(await listMods()) };
  return Response.json(body);
});
