import { route } from "@/server/http/context";
import { listAudit } from "@/server/audit/service";
import type { AuditResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route({ name: "audit", permission: "audit:read" }, async ({ request }) => {
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? 50);
  const body: AuditResult = {
    ok: true,
    entries: listAudit(Number.isFinite(limit) ? limit : 50),
  };
  return Response.json(body);
});
