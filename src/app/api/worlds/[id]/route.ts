import { route } from "@/server/http/context";
import { limitSavesMutation } from "@/server/saves/routes";
import { worldIdFrom } from "@/server/worlds/routes";
import { deleteWorld, requireWorlds } from "@/server/worlds/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Removes a world from the library. A world already put in play is not
 * affected: the server runs its own copy, and the archives keep theirs.
 */
export const DELETE = route(
  { name: "worlds.delete", mutation: true, permission: "worlds:delete" },
  async ({ request, session, ip, requestId }) => {
    requireWorlds();
    const current = session!;
    const id = worldIdFrom(request);
    limitSavesMutation(current, "delete", ip, requestId, "worlds");

    await deleteWorld(id, { session: current, ip, requestId });
    return Response.json({ ok: true });
  },
);
