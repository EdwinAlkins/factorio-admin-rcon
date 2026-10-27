import { z } from "zod";
import { route } from "@/server/http/context";
import { ApiFailure } from "@/server/http/errors";
import { ModChanges, planMods, requireMods } from "@/server/mods/service";
import type { ModPlanResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PlanBody = z.object({ changes: ModChanges }).strict();

/**
 * What a basket would do — downloads, dependencies, conflicts — without
 * changing anything. A POST because it carries the basket, and a mutation
 * for the origin check: it makes the data agent call the portal.
 */
export const POST = route(
  { name: "mods.plan", mutation: true, permission: "mods:manage", maxBodyBytes: 16 * 1024 },
  async ({ json }) => {
    requireMods();
    const parsed = PlanBody.safeParse(await json());
    if (!parsed.success) throw ApiFailure.badRequest("invalid_body");
    const body: ModPlanResult = { ok: true, plan: await planMods(parsed.data.changes) };
    return Response.json(body);
  },
);
