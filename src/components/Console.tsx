"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import type { LogEntry } from "@/lib/types";

const HISTORY_KEY = "factorio-admin:history";
/**
 * Historique volontairement court : il vit dans localStorage, lisible par tout
 * script de la page, et peut contenir des commandes sensibles (`/c …`).
 */
const HISTORY_MAX = 50;

function readHistory(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = window.localStorage.getItem(HISTORY_KEY);
    return stored ? (JSON.parse(stored) as string[]) : [];
  } catch {
    return [];
  }
}

type Props = {
  entries: LogEntry[];
  busy: boolean;
  /** `false` pour un rôle sans permission `rcon:raw` : la saisie est masquée. */
  canRun: boolean;
  onRun: (command: string) => void | Promise<void>;
  onClear: () => void;
  /** Sert à masquer la console (`hidden`) sans la démonter : la saisie et le
   *  défilement en cours survivent au passage sur l'onglet Statistiques. */
  className?: string;
};

export default function Console({ entries, busy, canRun, onRun, onClear, className }: Props) {
  const t = useTranslations("console");
  const [input, setInput] = useState("");
  // L'historique n'est jamais rendu dans le DOM (uniquement ↑/↓) : le lire au
  // premier render côté client ne crée donc pas d'écart d'hydratation.
  const [history, setHistory] = useState<string[]>(readHistory);
  // -1 = saisie en cours, sinon index dans `history` (0 = plus récent).
  const [cursor, setCursor] = useState(-1);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [entries]);

  function persist(next: string[]) {
    try {
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {
      // quota plein / mode privé : l'historique reste en mémoire
    }
  }

  function pushHistory(command: string) {
    setHistory((previous) => {
      if (previous[0] === command) return previous;
      const next = [command, ...previous].slice(0, HISTORY_MAX);
      persist(next);
      return next;
    });
  }

  function forgetHistory() {
    setHistory([]);
    setCursor(-1);
    try {
      window.localStorage.removeItem(HISTORY_KEY);
    } catch {
      // rien à faire : l'historique en mémoire est déjà vidé
    }
  }

  function submit() {
    const command = input.trim();
    if (!command || busy) return;
    pushHistory(command);
    setCursor(-1);
    setInput("");
    void onRun(command);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
      return;
    }

    if (event.key === "l" && event.ctrlKey) {
      event.preventDefault();
      onClear();
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      const next = Math.min(cursor + 1, history.length - 1);
      if (next < 0) return;
      setCursor(next);
      setInput(history[next]);
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = cursor - 1;
      setCursor(next);
      setInput(next < 0 ? "" : history[next]);
    }
  }

  return (
    <section
      className={`flex min-h-0 flex-1 flex-col rounded-lg border border-line bg-surface ${className ?? ""}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
        <h2 className="text-sm font-medium">{canRun ? t("title") : t("titleReadOnly")}</h2>
        <div className="flex items-center gap-3 text-xs text-muted">
          {canRun && <span>{t("shortcuts")}</span>}
          <button type="button" className="btn px-2 py-1 text-xs" onClick={onClear}>
            {t("clear")}
          </button>
          {canRun && history.length > 0 && (
            <button type="button" className="btn px-2 py-1 text-xs" onClick={forgetHistory}>
              {t("forgetHistory")}
            </button>
          )}
        </div>
      </header>

      <div
        ref={outputRef}
        aria-live="polite"
        className="min-h-64 flex-1 overflow-y-auto px-4 py-3 font-mono text-[13px] leading-relaxed"
      >
        {entries.length === 0 ? (
          <p className="text-muted">{canRun ? t("emptyWritable") : t("emptyReadOnly")}</p>
        ) : (
          <ul className="space-y-3">
            {entries.map((entry) => (
              <li key={entry.id}>
                <p className="text-accent">
                  <span className="text-muted">{entry.at} </span>
                  <span className="text-muted">&gt; </span>
                  {entry.command}
                  {entry.durationMs !== null && (
                    <span className="text-muted"> ({entry.durationMs} ms)</span>
                  )}
                </p>
                {entry.kind === "error" ? (
                  <pre role="alert" className="whitespace-pre-wrap break-words text-danger">
                    {entry.error}
                  </pre>
                ) : (
                  <pre className="whitespace-pre-wrap break-words">
                    {entry.output.trim() ? entry.output : t("noOutput")}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {canRun && (
        <div className="flex items-center gap-2 border-t border-line px-4 py-3">
          <span aria-hidden="true" className="font-mono text-accent">
            &gt;
          </span>
          <input
            autoFocus
            aria-label={t("inputLabel")}
            className="field font-mono"
            placeholder={t("inputPlaceholder")}
            value={input}
            disabled={busy}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button type="button" className="btn-primary" onClick={submit} disabled={busy}>
            {busy ? t("sending") : t("send")}
          </button>
        </div>
      )}
    </section>
  );
}
