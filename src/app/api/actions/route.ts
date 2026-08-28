import { z } from "zod";
import { hasLocale } from "next-intl";
import { routing } from "@/i18n/routing";
import { route } from "@/server/http/context";
import { ApiFailure } from "@/server/http/errors";
import { limiters } from "@/server/auth/limiters";
import { catalogFor, executeAction } from "@/server/actions/service";
import type { ActionCatalogResult, RconResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ActionBody = z.object({
  // Les commandes du fichier de l'opérateur sont préfixées « custom: ».
  action: z.string().min(1).max(96),
  values: z.record(z.string(), z.string()).optional(),
});

/**
 * Catalogue filtré selon le rôle de la session.
 *
 * `?locale=` ne concerne que les commandes du fichier de l'opérateur : elles
 * portent leur texte, là où les actions intégrées sont traduites côté client.
 */
export const GET = route({ name: "actions:list" }, async ({ request, session }) => {
  const requested = new URL(request.url).searchParams.get("locale");
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

  const body: ActionCatalogResult = { ok: true, actions: catalogFor(session!, locale) };
  return Response.json(body);
});

export const POST = route(
  { name: "actions:execute", mutation: true },
  async ({ request, session, ip, requestId }) => {
    const current = session!;

    const verdict = limiters().rconPerSession.consume(`session:${current.id}`);
    if (!verdict.allowed) {
      throw ApiFailure.tooManyRequests("rate_limited_session", verdict.retryAfter);
    }

    const parsed = ActionBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw ApiFailure.badRequest("action_body_invalid");
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
