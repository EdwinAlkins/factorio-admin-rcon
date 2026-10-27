import { z } from "zod";
import { route } from "@/server/http/context";
import { ApiFailure } from "@/server/http/errors";
import { limitSavesMutation } from "@/server/saves/routes";
import { listSaves, requestBackup, requireSaves } from "@/server/saves/service";
import type { SavesResult, ServerOperationResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The saves folder, the archives, the schedule and any operation in progress. */
export const GET = route({ name: "saves", permission: "saves:read" }, async () => {
  requireSaves();
  const body: SavesResult = { ok: true, ...(await listSaves()) };
  return Response.json(body);
});

const BackupBody = z.object({ label: z.string().trim().max(100).optional() }).strict();

/**
 * Takes an archive now. A manual backup always asks Factorio to save first,
 * when it runs: the operator expects the archive to hold the game as it is.
 */
export const POST = route(
  { name: "saves.create", mutation: true, permission: "saves:create", maxBodyBytes: 1024 },
  async ({ json, session, ip, requestId }) => {
    requireSaves();
    const current = session!;
    limitSavesMutation(current, "backup", ip, requestId);

    const parsed = BackupBody.safeParse((await json()) ?? {});
    if (!parsed.success) throw ApiFailure.badRequest("invalid_body");
    if (parsed.data.label && /[\u0000-\u001f\u007f]/.test(parsed.data.label)) {
      throw ApiFailure.badRequest("invalid_body");
    }

    const operation = await requestBackup({
      username: current.username,
      role: current.role,
      ip,
      requestId,
      source: "manual",
      label: parsed.data.label || undefined,
      triggerSave: true,
    });
    const body: ServerOperationResult = { ok: true, operation };
    return Response.json(body, { status: 202 });
  },
);
