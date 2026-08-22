"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "@/lib/fetch-json";
import { useErrorMessage } from "@/hooks/useErrorMessage";
import type { StatusResult } from "@/lib/api-types";
import type { ServerStatus } from "@/lib/types";

/**
 * Statut du serveur, rafraîchi périodiquement.
 * Le polling est suspendu quand l'onglet n'est pas visible : inutile de
 * solliciter la file RCON pour un onglet en arrière-plan.
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

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void load().then((next) => {
        if (cancelled) return;
        if (next === "unauthorized") onUnauthorized();
        else setStatus(next);
      });
    };

    tick();
    const timer = window.setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [enabled, intervalMs, load, onUnauthorized]);

  return { status, refresh };
}
