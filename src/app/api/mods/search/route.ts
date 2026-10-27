import { route } from "@/server/http/context";
import { ApiFailure } from "@/server/http/errors";
import { requireMods, searchMods } from "@/server/mods/service";
import type { ModSearchResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Full-text search on the mod portal, for this game version. */
export const GET = route({ name: "mods.search", permission: "mods:manage" }, async ({ request }) => {
  requireMods();
  const params = new URL(request.url).searchParams;
  const query = (params.get("q") ?? "").trim();
  const page = Number(params.get("page") ?? "1");
  if (query.length > 100 || /[\u0000-\u001f\u007f]/.test(query) || !Number.isInteger(page) || page < 1 || page > 500) {
    throw ApiFailure.badRequest("invalid_body");
  }
  const body: ModSearchResult = { ok: true, ...(await searchMods(query, page)) };
  return Response.json(body);
});
