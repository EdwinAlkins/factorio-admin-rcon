import { route } from "@/server/http/context";
import { recordAudit } from "@/server/audit/service";
import { dataDownload } from "@/server/data/client";
import { backupIdFrom } from "@/server/saves/routes";
import { requireSaves } from "@/server/saves/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Streams an archive from the data agent to the browser. The body is piped,
 * never buffered: a large map does not land in the panel's memory. Audited —
 * an archive is a full copy of the world.
 */
export const GET = route({ name: "saves.download", permission: "saves:download" }, async ({ request, session, ip, requestId }) => {
  requireSaves();
  const current = session!;
  const id = backupIdFrom(request);

  const upstream = await dataDownload(id);
  recordAudit({
    username: current.username,
    role: current.role,
    kind: "saves",
    action: "download",
    status: "success",
    detail: id,
    ip,
    requestId,
  });

  const headers = new Headers({
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="factorio-${id}.zip"`,
    "cache-control": "no-store",
  });
  for (const name of ["content-length", "x-content-sha256", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: 200, headers });
});
