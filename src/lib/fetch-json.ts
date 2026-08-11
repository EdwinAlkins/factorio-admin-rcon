import { isApiError } from "@/lib/api-types";

/**
 * Appel JSON typé : `response.json()` renvoie `any`, on force le passage par un
 * résultat discriminé pour que les composants ne manipulent jamais de `any`.
 */

export type FetchOutcome<T> =
  | { kind: "ok"; data: T }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string; status: number; code?: string };

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
    return { kind: "error", message: "Panneau injoignable (requête réseau échouée).", status: 0 };
  }

  if (response.status === 401) return { kind: "unauthorized" };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      kind: "error",
      message: `Réponse illisible du serveur (HTTP ${response.status}).`,
      status: response.status,
    };
  }

  if (!response.ok || isApiError(payload)) {
    return {
      kind: "error",
      message: isApiError(payload) ? payload.error : `Erreur HTTP ${response.status}.`,
      status: response.status,
      code: isApiError(payload) ? payload.code : undefined,
    };
  }

  return { kind: "ok", data: payload as T };
}
