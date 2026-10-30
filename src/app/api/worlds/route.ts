import { route } from "@/server/http/context";
import { ApiFailure } from "@/server/http/errors";
import { limitSavesMutation } from "@/server/saves/routes";
import { CreateInput, createWorld, listWorlds, requireWorlds } from "@/server/worlds/service";
import type { WorldResult, WorldsResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The library of worlds, the game versions to compare, and any operation in progress. */
export const GET = route({ name: "worlds", permission: "worlds:read" }, async () => {
  requireWorlds();
  const body: WorldsResult = { ok: true, ...(await listWorlds()) };
  return Response.json(body);
});

/**
 * Generates a new world into the library. Answers once the map exists — a
 * few seconds — without touching the server.
 */
export const POST = route(
  { name: "worlds.create", mutation: true, permission: "worlds:create", maxBodyBytes: 128 * 1024 },
  async ({ json, session, ip, requestId }) => {
    requireWorlds();
    const current = session!;
    limitSavesMutation(current, "create", ip, requestId, "worlds");

    const parsed = CreateInput.safeParse(await json());
    if (!parsed.success) throw ApiFailure.badRequest("invalid_world_settings", { reason: parsed.error.issues[0]?.path.join(".") ?? "" });

    const world = await createWorld(parsed.data, { session: current, ip, requestId });
    const body: WorldResult = { ok: true, world };
    return Response.json(body, { status: 201 });
  },
);
