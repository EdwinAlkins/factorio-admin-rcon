import { route } from "@/server/http/context";
import { ApiFailure } from "@/server/http/errors";
import { preview, PreviewInput, requireWorlds } from "@/server/worlds/service";
import type { WorldPreviewResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Renders the terrain a seed and settings give, without creating anything.
 * The image is fetched next, from `/api/worlds/previews/<id>`.
 */
export const POST = route(
  { name: "worlds.preview", mutation: true, permission: "worlds:create", maxBodyBytes: 128 * 1024 },
  async ({ json, session, ip, requestId }) => {
    requireWorlds();
    const parsed = PreviewInput.safeParse(await json());
    if (!parsed.success) throw ApiFailure.badRequest("invalid_world_settings", { reason: parsed.error.issues[0]?.path.join(".") ?? "" });

    const body: WorldPreviewResult = { ok: true, preview: await preview(parsed.data, { session: session!, ip, requestId }) };
    return Response.json(body);
  },
);
