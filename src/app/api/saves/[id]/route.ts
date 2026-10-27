import { route } from "@/server/http/context";
import { ApiFailure } from "@/server/http/errors";
import { recordAudit } from "@/server/audit/service";
import { dataDeleteBackup } from "@/server/data/client";
import { currentOperation } from "@/server/operations/engine";
import { backupIdFrom, limitSavesMutation } from "@/server/saves/routes";
import { requireSaves } from "@/server/saves/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Deletes an archive. Refused while an operation runs: it might be restoring this one. */
export const DELETE = route(
  { name: "saves.delete", mutation: true, permission: "saves:delete" },
  async ({ request, session, ip, requestId }) => {
    requireSaves();
    const current = session!;
    const id = backupIdFrom(request);
    limitSavesMutation(current, "delete", ip, requestId);

    const audit = (status: "success" | "denied" | "error", detail: string | null) =>
      recordAudit({ username: current.username, role: current.role, kind: "saves", action: "delete", status, detail, ip, requestId });

    if (currentOperation()) {
      audit("denied", `${id}: operation_in_progress`);
      throw new ApiFailure(409, "operation_in_progress");
    }

    try {
      await dataDeleteBackup(id);
    } catch (error) {
      audit("error", id);
      throw error;
    }
    audit("success", id);
    return Response.json({ ok: true });
  },
);
