import { route } from "@/server/http/context";
import { ApiFailure } from "@/server/http/errors";
import { recordAudit } from "@/server/audit/service";
import { BackupSettingsInput, backupSettings, requireSaves, updateBackupSettings } from "@/server/saves/service";
import type { BackupSettingsResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route({ name: "saves.settings", permission: "saves:read" }, async () => {
  requireSaves();
  const body: BackupSettingsResult = { ok: true, settings: backupSettings() };
  return Response.json(body);
});

/** The backup schedule and retention. Applies from the scheduler's next minute. */
export const PUT = route(
  { name: "saves.settings.update", mutation: true, permission: "saves:configure", maxBodyBytes: 1024 },
  async ({ json, session, ip, requestId }) => {
    requireSaves();
    const current = session!;

    const parsed = BackupSettingsInput.safeParse(await json());
    if (!parsed.success) throw ApiFailure.badRequest("invalid_body");

    const settings = updateBackupSettings(parsed.data, current.username);
    recordAudit({
      username: current.username,
      role: current.role,
      kind: "saves",
      action: "settings",
      status: "success",
      detail: JSON.stringify(parsed.data),
      ip,
      requestId,
    });
    const body: BackupSettingsResult = { ok: true, settings };
    return Response.json(body);
  },
);
