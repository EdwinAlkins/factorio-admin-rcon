import { route } from "@/server/http/context";
import { worldImage } from "@/server/worlds/client";
import { imageResponse, worldIdFrom } from "@/server/worlds/routes";
import { requireWorlds } from "@/server/worlds/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A world's preview, as kept in the library. */
export const GET = route({ name: "worlds.image", permission: "worlds:read" }, async ({ request }) => {
  requireWorlds();
  return imageResponse(await worldImage(worldIdFrom(request)));
});
