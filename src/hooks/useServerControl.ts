"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson, type FetchFailure } from "@/lib/fetch-json";
import { usePolling } from "@/hooks/usePolling";
import type {
  ServerOperationResult,
  ServerLifecycleType,
  ServerResult,
} from "@/lib/api-types";

/** Refusals the operator can override by confirming a second time. */
const FORCEABLE = new Set(["players_online", "rcon_unavailable_force_required"]);

export type OperationOutcome =
  | { kind: "started" }
  | { kind: "needs_force"; failure: FetchFailure }
  | { kind: "failed"; failure: FetchFailure }
  | { kind: "unauthorized" };

/**
 * Server lifecycle state (`GET /api/server`) and the start/stop/restart calls.
 *
 * Polled slowly at rest, fast while something is moving: an operation in
 * progress, or a server that is starting or stopping on its own.
 */
export function useServerControl(options: {
  enabled: boolean;
  onUnauthorized: () => void;
  /** Called when an operation the panel followed comes to an end. */
  onSettled?: () => void;
}) {
  const { enabled, onUnauthorized, onSettled } = options;
  const [server, setServer] = useState<ServerResult | null>(null);
  const [failure, setFailure] = useState<FetchFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // A reading still in flight at unmount must no longer touch state.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Callbacks are read through refs so `load` stays stable. If it depended on
  // them, a parent passing an inline function would recreate `load`, hence
  // `tick`, and `usePolling` — which fetches as soon as its tick changes —
  // would refetch on every render: one request per response, in a loop.
  const callbacks = useRef({ onUnauthorized, onSettled });
  useEffect(() => {
    callbacks.current = { onUnauthorized, onSettled };
  });

  const hadOperation = useRef(false);

  const load = useCallback(async () => {
    const outcome = await fetchJson<ServerResult>("/api/server");
    if (!alive.current) return;

    if (outcome.kind === "unauthorized") {
      callbacks.current.onUnauthorized();
      return;
    }
    if (outcome.kind === "error") {
      setFailure(outcome);
      return;
    }

    setFailure(null);
    setServer(outcome.data);

    const running = outcome.data.operation !== null;
    if (hadOperation.current && !running) callbacks.current.onSettled?.();
    hadOperation.current = running;
  }, []);

  const tick = useCallback(() => void load(), [load]);

  const moving =
    server?.operation != null || server?.state === "starting" || server?.state === "stopping";
  usePolling(tick, { enabled, intervalMs: moving ? 2000 : 10_000 });

  const run = useCallback(
    async (type: ServerLifecycleType, force = false): Promise<OperationOutcome> => {
      setSubmitting(true);
      try {
        const outcome = await fetchJson<ServerOperationResult>(`/api/server/${type}`, {
          method: "POST",
          body: JSON.stringify(force ? { force: true } : {}),
        });

        if (outcome.kind === "unauthorized") {
          callbacks.current.onUnauthorized();
          return { kind: "unauthorized" };
        }
        if (outcome.kind === "error") {
          return FORCEABLE.has(outcome.code) && !force
            ? { kind: "needs_force", failure: outcome }
            : { kind: "failed", failure: outcome };
        }

        hadOperation.current = true;
        await load();
        return { kind: "started" };
      } finally {
        if (alive.current) setSubmitting(false);
      }
    },
    [load],
  );

  return { server, failure, submitting, run, refresh: load };
}
