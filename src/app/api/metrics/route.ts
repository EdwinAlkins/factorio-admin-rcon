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
 * `status:read` — so available to all three roles: these figures are no more
 * sensitive than the player count `/api/status` already exposes.
 */
export const GET = route({ name: "metrics", permission: "status:read" }, async ({ request }) => {
  // Feature off: the route does not exist in this configuration. The case in
  // mind is a tab left open across a restart: the client shows an explicit
  // message rather than an unexplained empty chart.
  if (!env().METRICS_ENABLED) throw ApiFailure.notFound("metrics_disabled");

  const range = parseRange(new URL(request.url).searchParams.get("range"));
  // One reference instant for both reads and for the announced window:
  // otherwise the bounds would not quite line up with the points.
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
    // Reported by the collector, not inferred from the points: a source that
    // went down and a window that is still empty produce the same data but call
    // for opposite messages.
    health: metricsHealth(),
  };

  return Response.json(body);
});
