import { route } from "@/server/http/context";
import { catalog, requireWorlds } from "@/server/worlds/service";
import type { WorldCatalogResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the creation form is built from, read from the game with the server's
 * mods: planets, resources, presets, the default rules. The first call after
 * a mod change dumps the game's data (a few seconds); later ones are cached.
 */
export const GET = route({ name: "worlds.catalog", permission: "worlds:create" }, async () => {
  requireWorlds();
  const body: WorldCatalogResult = { ok: true, catalog: await catalog() };
  return Response.json(body);
});
