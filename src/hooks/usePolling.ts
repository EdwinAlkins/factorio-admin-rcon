"use client";

import { useEffect } from "react";

/**
 * Periodic polling, suspended while the tab is not visible.
 *
 * A background tab has nothing to display: letting it query the server would
 * exercise the deliberately serialised RCON queue for nothing. Polling resumes
 * immediately when the tab comes back, without waiting for the next interval —
 * otherwise the screen would stay stale for several seconds.
 */
export function usePolling(
  tick: () => void,
  options: { enabled: boolean; intervalMs: number },
) {
  const { enabled, intervalMs } = options;

  useEffect(() => {
    if (!enabled) return;

    const run = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      tick();
    };

    run();
    const timer = window.setInterval(run, intervalMs);
    document.addEventListener("visibilitychange", run);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
    };
  }, [enabled, intervalMs, tick]);
}
