"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson, type FetchFailure } from "@/lib/fetch-json";
import { usePolling } from "@/hooks/usePolling";
import type { BackupSettingsDto, BackupSettingsResult, SavesResult, ServerOperationResult } from "@/lib/api-types";

/** Refusals the operator can override by confirming a second time. */
const FORCEABLE = new Set(["players_online", "rcon_unavailable_force_required", "restore_incompatible"]);

export type SavesOutcome =
  | { kind: "done" }
  | { kind: "needs_force"; failure: FetchFailure }
  | { kind: "failed"; failure: FetchFailure };

/**
 * Saves tab data (`GET /api/saves`) and its actions. Polled only while the tab
 * is shown — slowly at rest, fast while an operation runs. Callbacks are read
 * through refs so `load` stays stable (see useServerControl).
 */
export function useSaves(options: { enabled: boolean; onUnauthorized: () => void }) {
  const { enabled, onUnauthorized } = options;
  const [data, setData] = useState<SavesResult | null>(null);
  const [failure, setFailure] = useState<FetchFailure | null>(null);
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
    const outcome = await fetchJson<SavesResult>("/api/saves");
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
  usePolling(tick, { enabled, intervalMs: data?.operation ? 2000 : 15_000 });

  /** Sends a mutation, then refreshes the list. */
  const send = useCallback(
    async (input: string, init: RequestInit, forceable = false): Promise<SavesOutcome> => {
      setSubmitting(true);
      try {
        const outcome = await fetchJson<ServerOperationResult | { ok: true }>(input, init);
        if (outcome.kind === "unauthorized") {
          unauthorized.current();
          return { kind: "done" };
        }
        if (outcome.kind === "error") {
          return forceable && FORCEABLE.has(outcome.code)
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

  const backup = useCallback(
    (label: string) => send("/api/saves", { method: "POST", body: JSON.stringify(label ? { label } : {}) }),
    [send],
  );

  const restore = useCallback(
    (id: string, force = false) =>
      send(
        `/api/saves/${encodeURIComponent(id)}/restore`,
        { method: "POST", body: JSON.stringify(force ? { force: true } : {}) },
        !force,
      ),
    [send],
  );

  const remove = useCallback(
    (id: string) => send(`/api/saves/${encodeURIComponent(id)}`, { method: "DELETE" }),
    [send],
  );

  const saveSettings = useCallback(
    async (settings: Omit<BackupSettingsDto, "lastRunAt">): Promise<SavesOutcome> => {
      const outcome = await fetchJson<BackupSettingsResult>("/api/saves/settings", {
        method: "PUT",
        body: JSON.stringify(settings),
      });
      if (outcome.kind === "error") return { kind: "failed", failure: outcome };
      if (outcome.kind === "unauthorized") unauthorized.current();
      await load();
      return { kind: "done" };
    },
    [load],
  );

  return { data, failure, submitting, refresh: load, backup, restore, remove, saveSettings };
}
