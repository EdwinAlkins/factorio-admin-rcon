import { route } from "@/server/http/context";
import { worldPreviewImage } from "@/server/worlds/client";
import { imageResponse, previewIdFrom } from "@/server/worlds/routes";
import { requireWorlds } from "@/server/worlds/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A preview's image. The agent keeps the latest few only. */
export const GET = route({ name: "worlds.previewImage", permission: "worlds:create" }, async ({ request }) => {
  requireWorlds();
  return imageResponse(await worldPreviewImage(previewIdFrom(request)));
});
