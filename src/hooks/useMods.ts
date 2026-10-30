"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson, type FetchFailure } from "@/lib/fetch-json";
import { usePolling } from "@/hooks/usePolling";
import type {
  ModChangeDto,
  ModDetailsResult,
  ModPlanResult,
  ModSearchResult,
  ModsResult,
  ServerOperationResult,
} from "@/lib/api-types";

/** Refusals the operator can override by confirming a second time. */
const FORCEABLE = new Set(["players_online", "rcon_unavailable_force_required"]);

export type ModsOutcome =
  | { kind: "done" }
  | { kind: "needs_force"; failure: FetchFailure }
  | { kind: "failed"; failure: FetchFailure };

/** A read that either succeeds or carries the failure to show. */
export type ModsRead<T> = { kind: "ok"; data: T } | { kind: "failed"; failure: FetchFailure } | { kind: "unauthorized" };

const BASKET_KEY = "factorio-admin.mods.basket";

function loadBasket(): ModChangeDto[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(BASKET_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as ModChangeDto[]) : [];
  } catch {
    return [];
  }
}

function storeBasket(basket: ModChangeDto[]) {
  try {
    if (basket.length === 0) sessionStorage.removeItem(BASKET_KEY);
    else sessionStorage.setItem(BASKET_KEY, JSON.stringify(basket));
  } catch {
    // Private window or blocked storage: the basket just won't survive a reload.
  }
}

/**
 * Mods tab data (`GET /api/mods`), the basket of pending changes, and the
 * calls behind search, a mod's page, the preview and the apply. Polled only
 * while the tab is shown; callbacks read through refs so `load` stays stable
 * (see useServerControl).
 *
 * The basket lives in the browser — in sessionStorage, so a reload keeps it —
 * and reaches the server only as a whole, when previewed or applied.
 */
export function useMods(options: { enabled: boolean; onUnauthorized: () => void }) {
  const { enabled, onUnauthorized } = options;
  const [data, setData] = useState<ModsResult | null>(null);
  const [failure, setFailure] = useState<FetchFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Read on the first client render. The server renders an empty basket, but
  // no mismatch follows: the basket is only shown once `data` has loaded,
  // after hydration.
  const [basket, setBasket] = useState<ModChangeDto[]>(loadBasket);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const unauthorized = useRef(onUnauthorized);
  useEffect(() => {
    unauthorized.current = onUnauthorized;
  });

  const load = useCallback(async () => {
    const outcome = await fetchJson<ModsResult>("/api/mods");
    if (!alive.current) return;
    if (outcome.kind === "unauthorized") {
      unauthorized.current();
    } else if (outcome.kind === "error") {
      setFailure(outcome);
    } else {
      setFailure(null);
      setData(outcome.data);
    }
  }, []);

  const tick = useCallback(() => void load(), [load]);
  usePolling(tick, { enabled, intervalMs: data?.operation ? 2000 : 30_000 });

  /** Adds a change, replacing any earlier one for the same mod. */
  const addChange = useCallback((change: ModChangeDto) => {
    setBasket((current) => {
      const next = [...current.filter((entry) => entry.name !== change.name), change];
      storeBasket(next);
      return next;
    });
  }, []);

  const removeChange = useCallback((name: string) => {
    setBasket((current) => {
      const next = current.filter((entry) => entry.name !== name);
      storeBasket(next);
      return next;
    });
  }, []);

  const clearBasket = useCallback(() => {
    storeBasket([]);
    setBasket([]);
  }, []);

  const read = useCallback(async <T>(input: string, init?: RequestInit): Promise<ModsRead<T>> => {
    const outcome = await fetchJson<T>(input, init);
    if (outcome.kind === "unauthorized") {
      unauthorized.current();
      return { kind: "unauthorized" };
    }
    if (outcome.kind === "error") return { kind: "failed", failure: outcome };
    return { kind: "ok", data: outcome.data };
  }, []);

  const search = useCallback(
    (query: string, page: number) =>
      read<ModSearchResult>(`/api/mods/search?${new URLSearchParams({ q: query, page: String(page) })}`),
    [read],
  );

  const details = useCallback(
    (name: string) => read<ModDetailsResult>(`/api/mods/portal/${encodeURIComponent(name)}`),
    [read],
  );

  const preview = useCallback(
    (changes: ModChangeDto[]) =>
      read<ModPlanResult>("/api/mods/plan", { method: "POST", body: JSON.stringify({ changes }) }),
    [read],
  );

  const apply = useCallback(
    async (changes: ModChangeDto[], planHash: string, force = false): Promise<ModsOutcome> => {
      setSubmitting(true);
      try {
        const outcome = await fetchJson<ServerOperationResult>("/api/mods/apply", {
          method: "POST",
          body: JSON.stringify(force ? { changes, planHash, force: true } : { changes, planHash }),
        });
        if (outcome.kind === "unauthorized") {
          unauthorized.current();
          return { kind: "done" };
        }
        if (outcome.kind === "error") {
          return !force && FORCEABLE.has(outcome.code)
            ? { kind: "needs_force", failure: outcome }
            : { kind: "failed", failure: outcome };
        }
        await load();
        return { kind: "done" };
      } finally {
        if (alive.current) setSubmitting(false);
      }
    },
    [load],
  );

  return {
    data,
    failure,
    submitting,
    refresh: load,
    basket,
    addChange,
    removeChange,
    clearBasket,
    search,
    details,
    preview,
    apply,
  };
}
