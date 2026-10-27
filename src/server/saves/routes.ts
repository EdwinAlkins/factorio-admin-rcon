import { ApiFailure } from "@/server/http/errors";
import { limiters } from "@/server/auth/limiters";
import { recordAudit } from "@/server/audit/service";
import { BACKUP_ID } from "@/server/saves/service";
import type { Session } from "@/server/auth/session";

/**
 * The archive id from `/api/saves/<id>/…`, validated before anything else
 * sees it. The route wrapper hands handlers the request only, so the id is
 * read from the path rather than from Next's params.
 */
export function backupIdFrom(request: Request): string {
  const id = new URL(request.url).pathname.split("/")[3] ?? "";
  if (!BACKUP_ID.test(id)) throw ApiFailure.notFound("backup_not_found");
  return id;
}

/** Same budget as start/stop/restart: each of these copies or rewrites a whole map. */
export function limitSavesMutation(session: Session, action: string, ip: string | null, requestId: string) {
  const verdict = limiters().serverPerSession.consume(`session:${session.id}`);
  if (verdict.allowed) return;
  recordAudit({
    username: session.username,
    role: session.role,
    kind: "saves",
    action,
    status: "denied",
    detail: "rate limit",
    ip,
    requestId,
  });
  throw ApiFailure.tooManyRequests("rate_limited_session", verdict.retryAfter);
}
