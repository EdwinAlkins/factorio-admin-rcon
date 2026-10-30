import { z } from "zod";
import { route } from "@/server/http/context";
import { ApiFailure } from "@/server/http/errors";
import { backupIdFrom, limitSavesMutation } from "@/server/saves/routes";
import { requestRestore, requireSaves } from "@/server/saves/service";
import type { ServerOperationResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `force` overrides the refusals a restore can meet: a different game version
 * or mod set, players online, RCON unavailable.
 */
const RestoreBody = z.object({ force: z.boolean().optional() }).strict();

export const POST = route(
  { name: "saves.restore", mutation: true, permission: "saves:restore", maxBodyBytes: 1024 },
  async ({ request, json, session, ip, requestId }) => {
    requireSaves();
    const current = session!;
    const id = backupIdFrom(request);
    limitSavesMutation(current, "restore", ip, requestId);

    const parsed = RestoreBody.safeParse((await json()) ?? {});
    if (!parsed.success) throw ApiFailure.badRequest("invalid_body");

    const operation = await requestRestore({
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
