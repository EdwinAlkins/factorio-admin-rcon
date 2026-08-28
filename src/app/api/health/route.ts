export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness: the Node process answers. Deliberately without authentication,
 * database or RCON — this is the probe Docker uses to decide whether to restart
 * the container.
 */
export function GET() {
  return Response.json({ status: "ok" });
}
