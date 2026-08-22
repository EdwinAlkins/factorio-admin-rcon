import { isApiError, type ErrorParams } from "@/lib/api-types";

/**
 * Appel JSON typé : `response.json()` renvoie `any`, on force le passage par un
 * résultat discriminé pour que les composants ne manipulent jamais de `any`.
 *
 * Les échecs sont décrits par un `code` (clé de traduction) plutôt que par une
 * phrase : c'est l'interface qui choisit la langue, via `useErrorMessage()`.
 */

export type FetchFailure = {
  kind: "error";
  status: number;
  code: string;
  params?: ErrorParams;
  /** Repli anglais renvoyé par le serveur, si le code est inconnu du dictionnaire. */
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
