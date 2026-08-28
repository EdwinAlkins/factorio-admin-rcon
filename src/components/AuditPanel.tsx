"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { fetchJson } from "@/lib/fetch-json";
import { useDynamicTranslations } from "@/hooks/useDynamicTranslations";
import { useErrorMessage } from "@/hooks/useErrorMessage";
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

/**
 * Audit log: the durable server-side trace of what was done through the panel.
 *
 * Stored rows contain identifiers only (`ban`, `denied`…), never translated
 * text, so the history stays readable in any language — including for entries
 * written before that language was added.
 */
export default function AuditPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const t = useTranslations("audit");
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const actionText = useDynamicTranslations("actions");
  const auditText = useDynamicTranslations("audit");
  const roleText = useDynamicTranslations("roles");
  const [entries, setEntries] = useState<AuditEntryDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  /** `action` is a catalogue id for actions, an internal verb otherwise. */
  function actionLabel(entry: AuditEntryDto): string {
    const catalogKey = `items.${entry.action}.label`;
    if (entry.kind === "action" && actionText.has(catalogKey)) return actionText(catalogKey);

    const auditKey = `actions.${entry.action}`;
    return auditText.has(auditKey) ? auditText(auditKey) : entry.action;
  }

  const load = useCallback(async (): Promise<AuditLoad> => {
    const outcome = await fetchJson<AuditResult>("/api/audit?limit=50");
    if (outcome.kind === "unauthorized") return { kind: "unauthorized" };
    if (outcome.kind === "error") return { kind: "error", message: errorMessage(outcome) };
    return { kind: "ok", entries: outcome.data.entries };
  }, [errorMessage]);

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
    <section className="shrink-0 rounded-lg border border-line bg-surface">
      <header className="flex items-center justify-between border-b border-line px-4 py-2">
        <h2 className="text-sm font-medium">{t("title")}</h2>
        <div className="flex gap-2">
          {open && (
            <button type="button" className="btn px-2 py-1 text-xs" onClick={() => void refresh()}>
              {t("refresh")}
            </button>
          )}
          <button
            type="button"
            className="btn px-2 py-1 text-xs"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            {open ? t("hide") : t("show")}
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
          {!error && entries.length === 0 && <p className="text-muted">{t("empty")}</p>}
          {entries.length > 0 && (
            <table className="w-full border-collapse font-mono">
              <thead className="text-muted">
                <tr className="text-left">
                  <th className="py-1 pr-3 font-normal">{t("columns.date")}</th>
                  <th className="py-1 pr-3 font-normal">{t("columns.account")}</th>
                  <th className="py-1 pr-3 font-normal">{t("columns.action")}</th>
                  <th className="py-1 pr-3 font-normal">{t("columns.status")}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id} className="border-t border-line/60 align-top">
                    <td className="whitespace-nowrap py-1 pr-3 text-muted">
                      {new Date(entry.ts).toLocaleString(locale)}
                    </td>
                    <td className="py-1 pr-3">
                      {entry.username}
                      <span className="text-muted">
                        {" "}
                        ({roleText.has(entry.role) ? roleText(entry.role) : entry.role})
                      </span>
                    </td>
                    <td className="py-1 pr-3">
                      {actionLabel(entry)}
                      {entry.command && (
                        // The fingerprint in `title`: a raw command is only
                        // logged as a prefix, but stays identifiable.
                        <div className="text-muted" title={entry.commandHash ?? undefined}>
                          {entry.command}
                        </div>
                      )}
                      {entry.detail && <div className="text-muted">{entry.detail}</div>}
                    </td>
                    <td className={`py-1 pr-3 ${STATUS_STYLE[entry.status] ?? ""}`}>
                      {auditText.has(`status.${entry.status}`)
                        ? auditText(`status.${entry.status}`)
                        : entry.status}
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
