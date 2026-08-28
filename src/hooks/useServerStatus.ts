"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson } from "@/lib/fetch-json";
import { useErrorMessage } from "@/hooks/useErrorMessage";
import { usePolling } from "@/hooks/usePolling";
import type { StatusResult } from "@/lib/api-types";
import type { ServerStatus } from "@/lib/types";

/**
 * Server status, refreshed periodically through `usePolling` (which suspends
 * polling while the tab is not visible).
 */
export function useServerStatus(options: {
  enabled: boolean;
  intervalMs?: number;
  onUnauthorized: () => void;
}) {
  const { enabled, intervalMs = 15_000, onUnauthorized } = options;
  const errorMessage = useErrorMessage();
  const [status, setStatus] = useState<ServerStatus>({ state: "loading" });

  const load = useCallback(async (): Promise<ServerStatus | "unauthorized"> => {
    const outcome = await fetchJson<StatusResult>("/api/status");

    if (outcome.kind === "unauthorized") return "unauthorized";
    if (outcome.kind === "error") return { state: "error", message: errorMessage(outcome) };

    return {
      state: "ok",
      online: outcome.data.online,
      count: outcome.data.count,
      version: outcome.data.version,
      target: outcome.data.target,
      cachedAt: outcome.data.cachedAt,
    };
  }, [errorMessage]);

  const refresh = useCallback(async () => {
    const next = await load();
    if (next === "unauthorized") onUnauthorized();
    else setStatus(next);
  }, [load, onUnauthorized]);

  // A reading still in flight at unmount must no longer touch state.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const tick = useCallback(() => {
    void load().then((next) => {
      if (!alive.current) return;
      if (next === "unauthorized") onUnauthorized();
      else setStatus(next);
    });
  }, [load, onUnauthorized]);

  usePolling(tick, { enabled, intervalMs });

  return { status, refresh };
}
