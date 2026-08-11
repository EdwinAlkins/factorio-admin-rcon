import { z } from "zod";
import { route } from "@/server/http/context";
import { ApiFailure } from "@/server/http/errors";
import { limiters } from "@/server/auth/limiters";
import { catalogFor, executeAction } from "@/server/actions/service";
import type { ActionCatalogResult, RconResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ActionBody = z.object({
  action: z.string().min(1).max(64),
  values: z.record(z.string(), z.string()).optional(),
});

/** Catalogue filtré selon le rôle de la session. */
export const GET = route({ name: "actions:list" }, async ({ session }) => {
  const body: ActionCatalogResult = { ok: true, actions: catalogFor(session!) };
  return Response.json(body);
});

export const POST = route(
  { name: "actions:execute", mutation: true },
  async ({ request, session, ip, requestId }) => {
    const current = session!;

    const verdict = limiters().rconPerSession.consume(`session:${current.id}`);
    if (!verdict.allowed) {
      throw ApiFailure.tooManyRequests(
        `Trop de commandes envoyées. Réessayez dans ${verdict.retryAfter} s.`,
        verdict.retryAfter,
      );
    }

    const parsed = ActionBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw ApiFailure.badRequest("Requête d'action invalide.");
    }

    const execution = await executeAction(
      { session: current, ip, requestId },
      parsed.data.action,
      parsed.data.values ?? {},
    );

    const body: RconResult = {
      ok: true,
      command: execution.command,
      output: execution.output,
      durationMs: execution.durationMs,
    };
    return Response.json(body);
  },
);
