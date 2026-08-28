"use client";

import { useCallback, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { fetchJson } from "@/lib/fetch-json";
import { useErrorMessage } from "@/hooks/useErrorMessage";
import type { RconResult } from "@/lib/api-types";
import { MAX_LOG_ENTRIES, type LogEntry, type NewLogEntry } from "@/lib/types";

/**
 * Command execution (raw console and actions) and the log shown on screen.
 * Both paths feed the same log, bounded so the DOM does not grow indefinitely
 * over a long session.
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
        // Browser time zone, interface language: the timestamp is only
        // produced client-side, so no hydration mismatch is possible.
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

  /** Raw console: requires the `rcon:raw` permission. */
  const runCommand = useCallback(
    (command: string) => send(command, "/api/rcon", { command }),
    [send],
  );

  /** Business action: the server builds the command from the identifier. */
  const runAction = useCallback(
    (actionId: string, label: string, values: Record<string, string>) =>
      send(label, "/api/actions", { action: actionId, values }),
    [send],
  );

  const clear = useCallback(() => setEntries([]), []);

  return { entries, busy, runCommand, runAction, clear };
}
