import { z } from "zod";
import { route } from "@/server/http/context";
import { ApiFailure } from "@/server/http/errors";
import { limitModsMutation, ModChanges, requestModsApply, requireMods } from "@/server/mods/service";
import type { ServerOperationResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `planHash` is the plan the operator confirmed; `force` overrides the
 * players-online and RCON-unavailable refusals.
 */
const ApplyBody = z
  .object({
    changes: ModChanges,
    planHash: z.string().regex(/^[0-9a-f]{64}$/),
    force: z.boolean().optional(),
  })
  .strict();

/** Applies a basket as one operation, with a single restart. */
export const POST = route(
  { name: "mods.apply", mutation: true, permission: "mods:manage", maxBodyBytes: 16 * 1024 },
  async ({ json, session, ip, requestId }) => {
    requireMods();
    const current = session!;
    limitModsMutation(current, ip, requestId);

    const parsed = ApplyBody.safeParse(await json());
    if (!parsed.success) throw ApiFailure.badRequest("invalid_body");

    const operation = await requestModsApply({
      username: current.username,
      role: current.role,
      ip,
      requestId,
      changes: parsed.data.changes,
      planHash: parsed.data.planHash,
      force: parsed.data.force ?? false,
    });
    const body: ServerOperationResult = { ok: true, operation };
    return Response.json(body, { status: 202 });
  },
);
