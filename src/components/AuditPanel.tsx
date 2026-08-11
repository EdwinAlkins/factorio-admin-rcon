"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "@/lib/fetch-json";
import type { AuditEntryDto, AuditResult } from "@/lib/api-types";

type AuditLoad =
  | { kind: "unauthorized" }
  | { kind: "error"; message: string }
  | { kind: "ok"; entries: AuditEntryDto[] };

const STATUS_STYLE: Record<string, string> = {
  success: "text-ok",
  denied: "text-accent",
  error: "text-danger",
};

/** Journal d'audit : trace serveur durable de ce qui a été fait via le panneau. */
export default function AuditPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [entries, setEntries] = useState<AuditEntryDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async (): Promise<AuditLoad> => {
    const outcome = await fetchJson<AuditResult>("/api/audit?limit=50");
    if (outcome.kind === "unauthorized") return { kind: "unauthorized" };
    if (outcome.kind === "error") return { kind: "error", message: outcome.message };
    return { kind: "ok", entries: outcome.data.entries };
  }, []);

  const apply = useCallback(
    (result: AuditLoad) => {
      if (result.kind === "unauthorized") {
        onUnauthorized();
        return;
      }
      if (result.kind === "error") {
        setError(result.message);
        return;
      }
      setEntries(result.entries);
      setError(null);
    },
    [onUnauthorized],
  );

  const refresh = useCallback(async () => apply(await load()), [apply, load]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    void load().then((result) => {
      if (!cancelled) apply(result);
    });

    return () => {
      cancelled = true;
    };
  }, [apply, load, open]);

  return (
    <section className="rounded-lg border border-line bg-surface">
      <header className="flex items-center justify-between border-b border-line px-4 py-2">
        <h2 className="text-sm font-medium">Journal d&apos;audit</h2>
        <div className="flex gap-2">
          {open && (
            <button type="button" className="btn px-2 py-1 text-xs" onClick={() => void refresh()}>
              Rafraîchir
            </button>
          )}
          <button
            type="button"
            className="btn px-2 py-1 text-xs"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            {open ? "Masquer" : "Afficher"}
          </button>
        </div>
      </header>

      {open && (
        <div className="max-h-64 overflow-y-auto px-4 py-3 text-xs">
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
          {!error && entries.length === 0 && <p className="text-muted">Aucune entrée.</p>}
          {entries.length > 0 && (
            <table className="w-full border-collapse font-mono">
              <thead className="text-muted">
                <tr className="text-left">
                  <th className="py-1 pr-3 font-normal">Date</th>
                  <th className="py-1 pr-3 font-normal">Compte</th>
                  <th className="py-1 pr-3 font-normal">Action</th>
                  <th className="py-1 pr-3 font-normal">Statut</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id} className="border-t border-line/60 align-top">
                    <td className="whitespace-nowrap py-1 pr-3 text-muted">
                      {new Date(entry.ts).toLocaleString("fr-FR")}
                    </td>
                    <td className="py-1 pr-3">
                      {entry.username}
                      <span className="text-muted"> ({entry.role})</span>
                    </td>
                    <td className="py-1 pr-3">
                      {entry.action}
                      {entry.command && <div className="text-muted">{entry.command}</div>}
                      {entry.detail && <div className="text-muted">{entry.detail}</div>}
                    </td>
                    <td className={`py-1 pr-3 ${STATUS_STYLE[entry.status] ?? ""}`}>
                      {entry.status}
                      {entry.durationMs !== null && (
                        <span className="text-muted"> {entry.durationMs} ms</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
