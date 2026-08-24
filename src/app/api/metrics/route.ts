import { route } from "@/server/http/context";
import { ApiFailure } from "@/server/http/errors";
import { env } from "@/server/config/env";
import { readSeries, readSummary, RANGES, type RangeKey } from "@/server/metrics/service";
import { metricsHealth } from "@/server/metrics/collector";
import type { MetricsResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_RANGE: RangeKey = "6h";

function parseRange(value: string | null): RangeKey {
  return value && value in RANGES ? (value as RangeKey) : DEFAULT_RANGE;
}

/**
 * `status:read` — donc accessible aux trois rôles : ces chiffres ne sont pas
 * plus sensibles que le nombre de joueurs déjà exposé par `/api/status`.
 */
export const GET = route({ name: "metrics", permission: "status:read" }, async ({ request }) => {
  // Fonctionnalité coupée : la route n'existe pas dans cette configuration.
  // Cas visé — un onglet resté ouvert avant le redémarrage : le client affiche
  // un message explicite plutôt qu'un graphe vide inexplicable.
  if (!env().METRICS_ENABLED) throw ApiFailure.notFound("metrics_disabled");

  const range = parseRange(new URL(request.url).searchParams.get("range"));
  // Un seul instant de référence pour les deux lectures et pour la fenêtre
  // annoncée : sinon les bornes ne correspondraient pas tout à fait aux points.
  const now = Date.now();
  const buckets = readSeries(range, now);
  const summary = readSummary(range, now);

  const body: MetricsResult = {
    ok: true,
    range,
    from: now - RANGES[range],
    to: now,
    buckets,
    summary,
    // Rapportée par le collecteur, pas déduite des points : une source tombée
    // et une fenêtre encore vide produisent les mêmes données mais appellent
    // des messages opposés.
    health: metricsHealth(),
  };

  return Response.json(body);
});
