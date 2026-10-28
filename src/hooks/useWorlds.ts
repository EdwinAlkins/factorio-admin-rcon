"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson, type FetchFailure } from "@/lib/fetch-json";
import { usePolling } from "@/hooks/usePolling";
import type {
  ServerOperationResult,
  WorldCatalogDto,
  WorldCatalogResult,
  WorldDto,
  WorldPreviewDto,
  WorldPreviewResult,
  WorldResult,
  WorldSettings,
  WorldsResult,
} from "@/lib/api-types";

/** Refusals the operator can override by confirming a second time. */
const FORCEABLE = new Set(["players_online", "rcon_unavailable_force_required", "restore_incompatible"]);

export type WorldsOutcome<T = undefined> =
  | { kind: "done"; data: T }
  | { kind: "needs_force"; failure: FetchFailure }
  | { kind: "failed"; failure: FetchFailure }
  | { kind: "unauthorized" };

export type PreviewInput = {
  settings: WorldSettings;
  seed?: number;
  size: number;
  planet: string;
  offset: { x: number; y: number };
};

/**
 * Worlds tab data (`GET /api/worlds`) and its actions. The library is polled
 * only while the tab is shown — slowly at rest, fast while an activation
 * runs. The catalogue is loaded once, when the creation form is first opened:
 * the first load dumps the game's data.
 */
export function useWorlds(options: { enabled: boolean; onUnauthorized: () => void }) {
  const { enabled, onUnauthorized } = options;
  const [data, setData] = useState<WorldsResult | null>(null);
  const [failure, setFailure] = useState<FetchFailure | null>(null);
  const [catalog, setCatalog] = useState<WorldCatalogDto | null>(null);
  const [catalogFailure, setCatalogFailure] = useState<FetchFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
    const outcome = await fetchJson<WorldsResult>("/api/worlds");
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

  const loading = useRef(false);
  const loadCatalog = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const outcome = await fetchJson<WorldCatalogResult>("/api/worlds/catalog");
      if (!alive.current) return;
      if (outcome.kind === "unauthorized") unauthorized.current();
      else if (outcome.kind === "error") setCatalogFailure(outcome);
      else {
        setCatalogFailure(null);
        setCatalog(outcome.data.catalog);
      }
    } finally {
      loading.current = false;
    }
  }, []);

  /** Sends a call; maps its outcome. `forceable` refusals ask for a second confirmation. */
  const send = useCallback(async <T>(input: string, init: RequestInit, forceable = false): Promise<WorldsOutcome<T>> => {
    const outcome = await fetchJson<T>(input, init);
    if (outcome.kind === "unauthorized") {
      unauthorized.current();
      return { kind: "unauthorized" };
    }
    if (outcome.kind === "error") {
      return forceable && FORCEABLE.has(outcome.code)
        ? { kind: "needs_force", failure: outcome }
        : { kind: "failed", failure: outcome };
    }
    return { kind: "done", data: outcome.data };
  }, []);

  const preview = useCallback(
    async (input: PreviewInput): Promise<WorldsOutcome<WorldPreviewDto>> => {
      const outcome = await send<WorldPreviewResult>("/api/worlds/previews", { method: "POST", body: JSON.stringify(input) });
      return outcome.kind === "done" ? { kind: "done", data: outcome.data.preview } : outcome;
    },
    [send],
  );

  /** Wraps a mutation: one at a time from this tab, then the list is refreshed. */
  const mutate = useCallback(
    async <T>(run: () => Promise<WorldsOutcome<T>>): Promise<WorldsOutcome<T>> => {
      setSubmitting(true);
      try {
        const outcome = await run();
        if (outcome.kind === "done") await load();
        return outcome;
      } finally {
        if (alive.current) setSubmitting(false);
      }
    },
    [load],
  );

  const create = useCallback(
    (input: { name: string; settings: WorldSettings; seed?: number }) =>
      mutate(async (): Promise<WorldsOutcome<WorldDto>> => {
        const outcome = await send<WorldResult>("/api/worlds", { method: "POST", body: JSON.stringify(input) });
        return outcome.kind === "done" ? { kind: "done", data: outcome.data.world } : outcome;
      }),
    [mutate, send],
  );

  const activate = useCallback(
    (id: string, force = false) =>
      mutate(() =>
        send<ServerOperationResult>(
          `/api/worlds/${encodeURIComponent(id)}/activate`,
          { method: "POST", body: JSON.stringify(force ? { force: true } : {}) },
          !force,
        ),
      ),
    [mutate, send],
  );

  const remove = useCallback(
    (id: string) => mutate(() => send<{ ok: true }>(`/api/worlds/${encodeURIComponent(id)}`, { method: "DELETE" })),
    [mutate, send],
  );

  return {
    data,
    failure,
    catalog,
    catalogFailure,
    submitting,
    refresh: load,
    loadCatalog,
    preview,
    create,
    activate,
    remove,
  };
}
