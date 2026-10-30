import { route } from "@/server/http/context";
import { ApiFailure } from "@/server/http/errors";
import { MOD_NAME, modDetails, requireMods } from "@/server/mods/service";
import type { ModDetailsResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A mod's page on the portal: releases, game versions, dependencies. The name
 * is read from the path rather than Next's params, as the route wrapper hands
 * handlers the request only.
 */
export const GET = route({ name: "mods.details", permission: "mods:manage" }, async ({ request }) => {
  requireMods();
  const name = decodeURIComponent(new URL(request.url).pathname.split("/")[4] ?? "");
  if (!MOD_NAME.test(name)) throw ApiFailure.notFound("mod_not_found");
  const body: ModDetailsResult = { ok: true, mod: await modDetails(name) };
  return Response.json(body);
});
