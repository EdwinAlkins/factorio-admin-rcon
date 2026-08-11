export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness : le processus Node répond. Volontairement sans authentification,
 * sans base et sans RCON — c'est la sonde utilisée par Docker pour décider
 * s'il faut redémarrer le conteneur.
 */
export function GET() {
  return Response.json({ status: "ok" });
}
