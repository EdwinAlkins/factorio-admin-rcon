import { route } from "@/server/http/context";
import { recordAudit } from "@/server/audit/service";
import { worldDownload } from "@/server/worlds/client";
import { worldIdFrom } from "@/server/worlds/routes";
import { requireWorlds } from "@/server/worlds/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Streams a world's save, to keep or to load elsewhere. Piped, never buffered. */
export const GET = route({ name: "worlds.download", permission: "worlds:create" }, async ({ request, session, ip, requestId }) => {
  requireWorlds();
  const current = session!;
  const id = worldIdFrom(request);

  const upstream = await worldDownload(id);
  recordAudit({
    username: current.username,
    role: current.role,
    kind: "worlds",
    action: "download",
    status: "success",
    detail: id,
    ip,
    requestId,
  });

  const headers = new Headers({
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="factorio-world-${id}.zip"`,
    "cache-control": "no-store",
  });
  for (const name of ["content-length", "x-content-sha256", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: 200, headers });
});
