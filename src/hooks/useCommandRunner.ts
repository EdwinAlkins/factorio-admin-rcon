"use client";

import { useCallback, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { fetchJson } from "@/lib/fetch-json";
import { useErrorMessage } from "@/hooks/useErrorMessage";
import type { RconResult } from "@/lib/api-types";
import { MAX_LOG_ENTRIES, type LogEntry, type NewLogEntry } from "@/lib/types";

/**
 * Exécution des commandes (console brute et actions) et journal affiché.
 * Les deux chemins alimentent le même journal, borné pour ne pas faire enfler
 * indéfiniment le DOM au fil d'une longue session.
 */
export function useCommandRunner(options: { onUnauthorized: () => void; onSuccess?: () => void }) {
  const { onUnauthorized, onSuccess } = options;
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const nextId = useRef(0);
  const running = useRef(false);

  const append = useCallback(
    (entry: NewLogEntry) => {
      const complete: LogEntry = {
        ...entry,
        id: nextId.current++,
        // Fuseau du navigateur, langue de l'interface : l'horodatage n'est
        // produit que côté client, donc aucun écart d'hydratation possible.
        at: new Date().toLocaleTimeString(locale),
      };
      setEntries((current) => [...current, complete].slice(-MAX_LOG_ENTRIES));
    },
    [locale],
  );

  const send = useCallback(
    async (label: string, url: string, body: unknown) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      const startedAt = Date.now();

      try {
        const outcome = await fetchJson<RconResult>(url, {
          method: "POST",
          body: JSON.stringify(body),
        });

        if (outcome.kind === "unauthorized") {
          onUnauthorized();
          return;
        }

        if (outcome.kind === "error") {
          append({
            kind: "error",
            command: label,
            error: errorMessage(outcome),
            durationMs: Date.now() - startedAt,
          });
          return;
        }

        append({
          kind: "success",
          command: outcome.data.command,
          output: outcome.data.output,
          durationMs: outcome.data.durationMs,
        });
        onSuccess?.();
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [append, errorMessage, onSuccess, onUnauthorized],
  );

  /** Console brute : nécessite la permission `rcon:raw`. */
  const runCommand = useCallback(
    (command: string) => send(command, "/api/rcon", { command }),
    [send],
  );

  /** Action métier : le serveur construit la commande à partir de l'identifiant. */
  const runAction = useCallback(
    (actionId: string, label: string, values: Record<string, string>) =>
      send(label, "/api/actions", { action: actionId, values }),
    [send],
  );

  const clear = useCallback(() => setEntries([]), []);

  return { entries, busy, runCommand, runAction, clear };
}
