import { isApiError, type ErrorParams } from "@/lib/api-types";

/**
 * Typed JSON call: `response.json()` returns `any`, so everything goes through
 * a discriminated result and components never handle `any`.
 *
 * Failures are described by a `code` (a translation key) rather than a
 * sentence: the interface picks the language, through `useErrorMessage()`.
 */

export type FetchFailure = {
  kind: "error";
  status: number;
  code: string;
  params?: ErrorParams;
  /** English fallback from the server, when the dictionary does not know the code. */
  fallback?: string;
};

export type FetchOutcome<T> = { kind: "ok"; data: T } | { kind: "unauthorized" } | FetchFailure;

export async function fetchJson<T>(input: string, init?: RequestInit): Promise<FetchOutcome<T>> {
  let response: Response;

  try {
    response = await fetch(input, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
      cache: "no-store",
    });
  } catch {
    return { kind: "error", status: 0, code: "network" };
  }

  if (response.status === 401) return { kind: "unauthorized" };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      kind: "error",
      status: response.status,
      code: "unreadable",
      params: { status: response.status },
    };
  }

  if (!response.ok || isApiError(payload)) {
    if (isApiError(payload)) {
      return {
        kind: "error",
        status: response.status,
        code: payload.code,
        params: payload.params,
        fallback: payload.error,
      };
    }

    return {
      kind: "error",
      status: response.status,
      code: "http",
      params: { status: response.status },
    };
  }

  return { kind: "ok", data: payload as T };
}
