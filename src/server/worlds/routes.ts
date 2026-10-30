import { ApiFailure } from "@/server/http/errors";
import { PREVIEW_ID, WORLD_ID } from "@/server/worlds/service";

/**
 * The world id from `/api/worlds/<id>/…`, validated before anything else sees
 * it. Read from the path, as the route wrapper hands handlers the request only.
 */
export function worldIdFrom(request: Request): string {
  const id = new URL(request.url).pathname.split("/")[3] ?? "";
  if (!WORLD_ID.test(id)) throw ApiFailure.notFound("world_not_found");
  return id;
}

/** The preview id from `/api/worlds/previews/<id>`. */
export function previewIdFrom(request: Request): string {
  const id = new URL(request.url).pathname.split("/")[4] ?? "";
  if (!PREVIEW_ID.test(id)) throw ApiFailure.notFound("preview_not_found");
  return id;
}

/**
 * Passes an agent's image on: never cached (a preview id is short-lived,
 * a world can be deleted), never sniffed.
 */
export function imageResponse(upstream: Response): Response {
  const headers = new Headers({
    "content-type": "image/png",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  const length = upstream.headers.get("content-length");
  if (length) headers.set("content-length", length);
  return new Response(upstream.body, { status: 200, headers });
}
