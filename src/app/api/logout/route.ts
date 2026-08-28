import { cookies } from "next/headers";
import { revokeSession } from "@/server/auth/session";
import { cookieOptions, route } from "@/server/http/context";
import { recordAudit } from "@/server/audit/service";
import { SESSION_COOKIE } from "@/lib/session-cookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(
  { name: "logout", mutation: true },
  async ({ request, session, ip, requestId }) => {
    if (session) {
      // Revoked in the database: the cookie becomes useless even if stolen.
      revokeSession(session.id);
      recordAudit({
        username: session.username,
        role: session.role,
        kind: "auth",
        action: "logout",
        status: "success",
        ip,
        requestId,
      });
    }

    const store = await cookies();
    store.set(SESSION_COOKIE, "", cookieOptions(request, 0));

    return Response.json({ ok: true });
  },
);
