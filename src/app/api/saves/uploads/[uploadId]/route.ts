import { route } from "@/server/http/context";
import { ApiFailure } from "@/server/http/errors";
import { limiters } from "@/server/auth/limiters";
import { recordAudit } from "@/server/audit/service";
import { dataUploadAbort, dataUploadChunk, dataUploadOffset } from "@/server/data/client";
import { UPLOAD_CHUNK_BYTES, uploadIdFrom } from "@/server/saves/routes";
import { requireSaves } from "@/server/saves/service";
import type { UploadResult } from "@/lib/api-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function answer(result: { upload: UploadResult["upload"]; chunkBytes: number }): Response {
  const body: UploadResult = { ok: true, upload: result.upload, chunkBytes: Math.min(result.chunkBytes, UPLOAD_CHUNK_BYTES) };
  return Response.json(body);
}

/** Where an upload stands: the browser resumes from there after a failed chunk. */
export const GET = route({ name: "saves.upload.offset", permission: "saves:upload" }, async ({ request }) => {
  requireSaves();
  return answer(await dataUploadOffset(uploadIdFrom(request)));
});

/**
 * One chunk, at `?offset=`. Read whole (8 MB at most) and passed on: each
 * request stays short, under Node's request timeout and a reverse proxy's
 * body limit, whatever the save weighs. Not audited one by one — the upload
 * is, when it opens and when it is published.
 */
export const PUT = route(
  { name: "saves.upload.chunk", mutation: true, permission: "saves:upload", maxBodyBytes: UPLOAD_CHUNK_BYTES },
  async ({ request, bytes, session }) => {
    requireSaves();
    const id = uploadIdFrom(request);
    const raw = new URL(request.url).searchParams.get("offset") ?? "";
    const offset = Number(raw);
    if (!/^[0-9]{1,16}$/.test(raw) || !Number.isSafeInteger(offset)) throw ApiFailure.badRequest("invalid_body");

    const verdict = limiters().uploadChunksPerSession.consume(`session:${session!.id}`);
    if (!verdict.allowed) throw ApiFailure.tooManyRequests("rate_limited_session", verdict.retryAfter);

    const chunk = await bytes();
    if (chunk.length === 0) throw ApiFailure.badRequest("invalid_body");
    return answer(await dataUploadChunk(id, offset, chunk));
  },
);

/** Abandons an upload; what it received is deleted. */
export const DELETE = route(
  { name: "saves.upload.abort", mutation: true, permission: "saves:upload" },
  async ({ request, session, ip, requestId }) => {
    requireSaves();
    const current = session!;
    const id = uploadIdFrom(request);
    await dataUploadAbort(id);
    recordAudit({
      username: current.username,
      role: current.role,
      kind: "saves",
      action: "upload_abort",
      status: "success",
      detail: id,
      ip,
      requestId,
    });
    return Response.json({ ok: true });
  },
);
