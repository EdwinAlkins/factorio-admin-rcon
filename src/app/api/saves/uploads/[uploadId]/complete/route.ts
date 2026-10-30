import { z } from "zod";
import { route } from "@/server/http/context";
import { ApiFailure } from "@/server/http/errors";
import { limitSavesMutation, uploadIdFrom } from "@/server/saves/routes";
import { requestImport, requireSaves } from "@/server/saves/service";
import type { ServerOperationResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CompleteBody = z.object({ label: z.string().trim().max(100).optional() }).strict();

/**
 * Publishes a fully received upload as an archive, as an operation: the data
 * agent reads the whole file back to verify it is a save. Restoring it is a
 * separate, ordinary restore.
 */
export const POST = route(
  { name: "saves.upload.complete", mutation: true, permission: "saves:upload", maxBodyBytes: 1024 },
  async ({ request, json, session, ip, requestId }) => {
    requireSaves();
    const current = session!;
    const uploadId = uploadIdFrom(request);
    limitSavesMutation(current, "import", ip, requestId);

    const parsed = CompleteBody.safeParse((await json()) ?? {});
    if (!parsed.success || (parsed.data.label && /[\u0000-\u001f\u007f]/.test(parsed.data.label))) {
      throw ApiFailure.badRequest("invalid_body");
    }

    const operation = await requestImport({
      username: current.username,
      role: current.role,
      ip,
      requestId,
      uploadId,
      label: parsed.data.label || undefined,
    });
    const body: ServerOperationResult = { ok: true, operation };
    return Response.json(body, { status: 202 });
  },
);
