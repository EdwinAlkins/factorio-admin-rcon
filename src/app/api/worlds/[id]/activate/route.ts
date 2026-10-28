import { z } from "zod";
import { route } from "@/server/http/context";
import { ApiFailure } from "@/server/http/errors";
import { limitSavesMutation } from "@/server/saves/routes";
import { requireSaves } from "@/server/saves/service";
import { worldIdFrom } from "@/server/worlds/routes";
import { requestActivate, requireWorlds } from "@/server/worlds/service";
import type { ServerOperationResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `force` overrides the refusals a restore can meet: a different game version
 * or mod set, players online, RCON unavailable.
 */
const ActivateBody = z.object({ force: z.boolean().optional() }).strict();

/**
 * Puts a world in play, as a restore: the current map is archived first and
 * brought back if the server does not start on the new one.
 */
export const POST = route(
  { name: "worlds.activate", mutation: true, permission: "worlds:activate", maxBodyBytes: 1024 },
  async ({ request, json, session, ip, requestId }) => {
    requireWorlds();
    // The data agent archives the world and restores it.
    requireSaves();
    const current = session!;
    const id = worldIdFrom(request);
    limitSavesMutation(current, "activate", ip, requestId, "worlds");

    const parsed = ActivateBody.safeParse((await json()) ?? {});
    if (!parsed.success) throw ApiFailure.badRequest("invalid_body");

    const operation = await requestActivate({
      username: current.username,
      role: current.role,
      ip,
      requestId,
      id,
      force: parsed.data.force ?? false,
    });
    const body: ServerOperationResult = { ok: true, operation };
    return Response.json(body, { status: 202 });
  },
);
