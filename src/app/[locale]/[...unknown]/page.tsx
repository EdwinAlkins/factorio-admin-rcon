import { notFound } from "next/navigation";

/**
 * Catch-all: without it, an unknown URL landed on Next's built-in 404 page,
 * which is rendered **statically**. A nonce can only be stamped while rendering
 * a request, so that page went out without one and the CSP blocked all of its
 * scripts (see `src/proxy.ts`).
 *
 * Going through the locale segment's `not-found` boundary fixes both at once:
 * rendering becomes dynamic, and the 404 is translated.
 */
export const dynamic = "force-dynamic";

export default function UnknownPath() {
  notFound();
}
