import { env } from "@/server/config/env";
import { getDb } from "@/server/db";
import { getRcon } from "@/server/rcon";
import { loadCustomCatalog } from "@/server/actions/custom";
import { hasAnyAccount } from "@/server/auth/users";
import { errorFields, logger } from "@/server/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Check = { name: string; ok: boolean };

/**
 * Readiness: valid configuration, reachable database, reachable Factorio
 * server. Kept distinct from /api/health so a Factorio outage does not restart
 * the panel in a loop.
 */
export async function GET() {
  const checks: Check[] = [];

  try {
    env();
    checks.push({ name: "config", ok: true });
  } catch (error) {
    logger.error("readiness: configuration invalide", errorFields(error));
    checks.push({ name: "config", ok: false });
    return Response.json({ status: "unavailable", checks }, { status: 503 });
  }

  checks.push({ name: "accounts", ok: hasAnyAccount() });

  // An absent file means the feature is inactive, hence "ok". Only a file that
  // is present but unreadable or malformed is a configuration fault.
  const commands = loadCustomCatalog();
  if (commands.error) {
    logger.error("readiness: catalogue de commandes illisible", {
      file: commands.path,
      reason: commands.error,
    });
  }
  checks.push({ name: "commands", ok: commands.error === null });

  try {
    getDb().prepare("SELECT 1").get();
    checks.push({ name: "database", ok: true });
  } catch (error) {
    logger.error("readiness: base indisponible", errorFields(error));
    checks.push({ name: "database", ok: false });
  }

  const rcon = await getRcon().healthCheck();
  if (!rcon.ok) {
    logger.warn("readiness: rcon unavailable", { code: rcon.error.code, detail: rcon.error.detail });
  }
  checks.push({ name: "rcon", ok: rcon.ok });

  const ready = checks.every((check) => check.ok);
  return Response.json({ status: ready ? "ready" : "unavailable", checks }, {
    status: ready ? 200 : 503,
  });
}
