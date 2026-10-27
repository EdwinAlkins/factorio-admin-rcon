"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useErrorMessage } from "@/hooks/useErrorMessage";
import { fetchJson, type FetchOutcome } from "@/lib/fetch-json";
import type { ServerLogLineDto, ServerLogsResult } from "@/lib/api-types";

/** Enough to see a whole startup without making every refresh heavy. */
const TAIL = 200;

function fetchLogs() {
  return fetchJson<ServerLogsResult>(`/api/server/logs?tail=${TAIL}`);
}

type Props = {
  active: boolean;
  onUnauthorized: () => void;
};

/**
 * Last lines of the Factorio container's output. Loaded when the tab is
 * shown and on demand — not polled: the logs are for reading an incident, and
 * a list that keeps jumping while one reads it defeats that.
 */
export default function ServerLogs({ active, onUnauthorized }: Props) {
  const t = useTranslations("server.logs");
  const errorMessage = useErrorMessage();
  const [lines, setLines] = useState<ServerLogLineDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const box = useRef<HTMLPreElement>(null);

  const apply = useCallback(
    (outcome: FetchOutcome<ServerLogsResult>) => {
      setLoading(false);
      if (outcome.kind === "unauthorized") {
        onUnauthorized();
      } else if (outcome.kind === "error") {
        setError(errorMessage(outcome));
      } else {
        setError(null);
        setLines(outcome.data.lines);
      }
    },
    [errorMessage, onUnauthorized],
  );

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    void fetchLogs().then((outcome) => {
      if (!cancelled) apply(outcome);
    });

    return () => {
      cancelled = true;
    };
  }, [active, apply]);

  const refresh = useCallback(async () => {
    setLoading(true);
    apply(await fetchLogs());
  }, [apply]);

  // The newest lines are the ones that matter: keep them in view. Scrolls the
  // box only, never the page.
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between pb-1">
        <h3 className="text-xs font-medium">
          {t("title")} <span className="text-muted">· {t("hint", { count: TAIL })}</span>
        </h3>
        <button type="button" className="btn px-2 py-1 text-xs" disabled={loading} onClick={() => void refresh()}>
          {t("refresh")}
        </button>
      </div>

      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}

      {lines && (
        <pre
          ref={box}
          className="max-h-96 overflow-auto rounded border border-line bg-ground p-2 font-mono text-xs break-words whitespace-pre-wrap">
          {lines.length === 0 && <span className="text-muted">{t("empty")}</span>}
          {lines.map((line, index) => (
            <span key={index} className={line.stream === "stderr" ? "block text-danger" : "block"}>
              {line.text}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}
