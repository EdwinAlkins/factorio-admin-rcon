import { z } from "zod";
import { route } from "@/server/http/context";
import { ApiFailure } from "@/server/http/errors";
import { recordAudit } from "@/server/audit/service";
import { dataUploadBegin } from "@/server/data/client";
import { limitSavesMutation, UPLOAD_CHUNK_BYTES } from "@/server/saves/routes";
import { requireSaves } from "@/server/saves/service";
import type { UploadResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BeginBody = z
  .object({
    size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    name: z.string().max(255),
  })
  .strict();

/**
 * Opens an upload: a save sent from the operator's computer in chunks (see
 * `[uploadId]/route.ts`), then published as an archive by `complete`. The
 * data agent bounds the size and keeps one upload at a time.
 */
export const POST = route(
  { name: "saves.upload", mutation: true, permission: "saves:upload", maxBodyBytes: 1024 },
  async ({ json, session, ip, requestId }) => {
    requireSaves();
    const current = session!;
    limitSavesMutation(current, "upload", ip, requestId);

    const parsed = BeginBody.safeParse(await json());
    if (!parsed.success || /[\u0000-\u001f\u007f]/.test(parsed.data.name)) {
      throw ApiFailure.badRequest("invalid_body");
    }
    const { size, name } = parsed.data;

    const audit = (status: "success" | "error", detail: string) =>
      recordAudit({ username: current.username, role: current.role, kind: "saves", action: "upload", status, detail, ip, requestId });
    let started;
    try {
      started = await dataUploadBegin(size, name);
    } catch (error) {
      audit("error", `${name} ${size} B`);
      throw error;
    }
    audit("success", `${name} ${size} B`);

    const body: UploadResult = {
      ok: true,
      upload: started.upload,
      chunkBytes: Math.min(started.chunkBytes, UPLOAD_CHUNK_BYTES),
    };
    return Response.json(body, { status: 201 });
  },
);
