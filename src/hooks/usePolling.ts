"use client";

import { useEffect } from "react";

/**
 * Sondage périodique suspendu quand l'onglet n'est pas visible.
 *
 * Un onglet en arrière-plan n'a rien à afficher : le laisser interroger le
 * serveur solliciterait la file RCON — volontairement sérialisée — pour rien.
 * La reprise est immédiate au retour sur l'onglet, sans attendre le prochain
 * intervalle, sinon l'écran resterait périmé plusieurs secondes.
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
