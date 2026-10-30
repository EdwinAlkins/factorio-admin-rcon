"use client";

import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useErrorMessage } from "@/hooks/useErrorMessage";
import { useSaves, type SavesOutcome, type UploadProgress } from "@/hooks/useSaves";
import { can } from "@/lib/permissions";
import type { BackupDto, BackupSettingsDto, SessionInfo } from "@/lib/api-types";

type Pending = {
  title: string;
  message: string;
  details?: string;
  confirmLabel: string;
  run: () => void;
};

type Props = {
  session: SessionInfo;
  /** `false` while the tab is hidden: no polling then. */
  active: boolean;
  onUnauthorized: () => void;
  className?: string;
};

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Saves tab: the server's saves folder, the panel's archives (download,
 * restore, delete), a "back up now" button and the backup schedule.
 * Moderators see the lists; every action is for administrators.
 */
export default function SavesPanel({ session, active, onUnauthorized, className }: Props) {
  const t = useTranslations("saves");
  const tStep = useTranslations("server.step");
  const errorMessage = useErrorMessage();
  const { data, failure, submitting, refresh, backup, restore, remove, upload, saveSettings } = useSaves({
    enabled: active,
    onUnauthorized,
  });
  const [pending, setPending] = useState<Pending | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [label, setLabel] = useState("");

  const allowed = {
    create: can(session.role, "saves:create"),
    download: can(session.role, "saves:download"),
    upload: can(session.role, "saves:upload"),
    restore: can(session.role, "saves:restore"),
    remove: can(session.role, "saves:delete"),
    configure: can(session.role, "saves:configure"),
  };
  const busy = submitting || data?.operation != null;

  const report = useCallback(
    (outcome: SavesOutcome) => {
      if (outcome.kind === "failed") setActionError(errorMessage(outcome.failure));
    },
    [errorMessage],
  );

  const askRestore = (archive: BackupDto) => {
    setActionError(null);
    setPending({
      title: t("confirm.restoreTitle"),
      message: t("confirm.restoreMessage", { id: archive.id }),
      // Nothing to compare an imported save with: the operator is told so.
      details: archive.source === "upload" ? t("confirm.restoreUnknown") : undefined,
      confirmLabel: t("restore"),
      run: () =>
        void restore(archive.id).then((outcome) => {
          if (outcome.kind !== "needs_force") return report(outcome);
          // Second, explicit confirmation, carrying the reason for the refusal.
          setPending({
            title: t("confirm.forceTitle"),
            message: errorMessage(outcome.failure),
            confirmLabel: t("confirm.forceLabel"),
            run: () => void restore(archive.id, true).then(report),
          });
        }),
    });
  };

  const askDelete = (archive: BackupDto) => {
    setActionError(null);
    setPending({
      title: t("confirm.deleteTitle"),
      message: t("confirm.deleteMessage", { id: archive.id }),
      confirmLabel: t("delete"),
      run: () => void remove(archive.id).then(report),
    });
  };

  return (
    <section className={`flex min-h-0 flex-col rounded-lg border border-line bg-surface ${className ?? ""}`}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
        <h2 className="text-sm font-medium">{t("title")}</h2>
        <button type="button" className="btn px-2 py-1 text-xs" onClick={() => void refresh()}>
          {t("refresh")}
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-3">
        {failure && (
          <p role="alert" className="text-xs text-danger">
            {errorMessage(failure)}
          </p>
        )}
        {!data && !failure && <p className="text-xs text-muted">{t("loading")}</p>}

        {data && (
          <>
            {data.operation && (
              <p className="text-xs text-accent" aria-live="polite">
                {t("operation", { step: tStep(data.operation.step ?? "pending") })}
              </p>
            )}

            {allowed.create && (
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  setActionError(null);
                  void backup(label.trim()).then((outcome) => {
                    if (outcome.kind === "done") setLabel("");
                    report(outcome);
                  });
                }}
              >
                <input
                  className="field max-w-xs py-1 text-xs"
                  value={label}
                  maxLength={100}
                  placeholder={t("labelPlaceholder")}
                  onChange={(event) => setLabel(event.target.value)}
                />
                <button type="submit" className="btn-primary text-xs" disabled={busy}>
                  {t("backupNow")}
                </button>
              </form>
            )}

            {actionError && (
              <p role="alert" className="text-xs text-danger">
                {actionError}
              </p>
            )}

            {allowed.upload && data.maxUploadBytes > 0 && (
              <ImportSave maxBytes={data.maxUploadBytes} busy={busy} onUpload={upload} />
            )}

            <div>
              <h3 className="pb-1 text-xs font-medium">{t("archives")}</h3>
              {data.backups.length === 0 ? (
                <p className="text-xs text-muted">{t("archivesEmpty")}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-muted">
                      <tr>
                        <th className="py-1 pr-3 font-normal">{t("columns.date")}</th>
                        <th className="py-1 pr-3 font-normal">{t("columns.source")}</th>
                        <th className="py-1 pr-3 font-normal">{t("columns.label")}</th>
                        <th className="py-1 pr-3 font-normal">{t("columns.size")}</th>
                        <th className="py-1 pr-3 font-normal">{t("columns.version")}</th>
                        <th className="py-1 pr-3 font-normal">{t("columns.mods")}</th>
                        <th className="py-1" />
                      </tr>
                    </thead>
                    <tbody>
                      {data.backups.map((archive) => (
                        <tr key={archive.id} className="border-t border-line align-top">
                          <td className="py-1 pr-3 font-mono whitespace-nowrap" title={archive.id}>
                            {new Date(archive.createdAt).toLocaleString()}
                          </td>
                          <td className="py-1 pr-3">{t(`source.${archive.source}`)}</td>
                          <td className="py-1 pr-3">{archive.label ?? "—"}</td>
                          <td className="py-1 pr-3 font-mono whitespace-nowrap">{formatSize(archive.size)}</td>
                          <td className="py-1 pr-3 font-mono">{archive.factorioVersion ?? "—"}</td>
                          <td
                            className="py-1 pr-3"
                            title={archive.mods
                              .filter((mod) => mod.enabled)
                              .map((mod) => (mod.version ? `${mod.name} ${mod.version}` : mod.name))
                              .join(", ")}
                          >
                            {t("modsCount", { count: archive.mods.filter((mod) => mod.enabled).length })}
                          </td>
                          <td className="py-1">
                            <div className="flex flex-wrap justify-end gap-1">
                              {allowed.download && (
                                <a
                                  className="btn px-2 py-0.5 text-xs"
                                  href={`/api/saves/${encodeURIComponent(archive.id)}/download`}
                                  download
                                >
                                  {t("download")}
                                </a>
                              )}
                              {allowed.restore && (
                                <button
                                  type="button"
                                  className="btn px-2 py-0.5 text-xs hover:border-danger hover:text-danger"
                                  disabled={busy}
                                  onClick={() => askRestore(archive)}
                                >
                                  {t("restore")}
                                </button>
                              )}
                              {allowed.remove && (
                                <button
                                  type="button"
                                  className="btn px-2 py-0.5 text-xs hover:border-danger hover:text-danger"
                                  disabled={busy}
                                  onClick={() => askDelete(archive)}
                                >
                                  {t("delete")}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div>
              <h3 className="pb-1 text-xs font-medium">{t("live")}</h3>
              {data.saves.length === 0 ? (
                <p className="text-xs text-muted">{t("liveEmpty")}</p>
              ) : (
                <ul className="flex flex-col gap-1 text-xs">
                  {data.saves.map((save) => (
                    <li key={save.name} className="flex flex-wrap gap-x-3">
                      <span className="font-mono">{save.name}</span>
                      <span className="font-mono text-muted">{formatSize(save.size)}</span>
                      <span className="text-muted">{new Date(save.modified).toLocaleString()}</span>
                      {save.latest && <span className="text-accent">{t("latest")}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <Schedule settings={data.settings} editable={allowed.configure} onSave={saveSettings} />
          </>
        )}
      </div>

      {pending && (
        <ConfirmDialog
          title={pending.title}
          message={pending.message}
          details={pending.details}
          confirmLabel={pending.confirmLabel}
          onConfirm={() => {
            pending.run();
            setPending(null);
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </section>
  );
}

type ImportProps = {
  maxBytes: number;
  busy: boolean;
  onUpload: (
    file: File,
    label: string,
    onProgress: (progress: UploadProgress) => void,
    signal: AbortSignal,
  ) => Promise<SavesOutcome>;
};

/**
 * Sends a save from the operator's computer. It lands as an archive of
 * source `upload`; playing it is an ordinary restore, from the list.
 */
function ImportSave({ maxBytes, busy, onUpload }: ImportProps) {
  const t = useTranslations("saves.import");
  const tSaves = useTranslations("saves");
  const errorMessage = useErrorMessage();
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const start = () => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip")) return setNotice({ error: true, text: t("notZip") });
    if (file.size > maxBytes) return setNotice({ error: true, text: t("tooLarge", { max: formatSize(maxBytes) }) });

    const controller = new AbortController();
    abort.current = controller;
    setNotice(null);
    setProgress({ sent: 0, resuming: false });
    void onUpload(file, label.trim(), setProgress, controller.signal).then((outcome) => {
      abort.current = null;
      setProgress(null);
      if (controller.signal.aborted) return;
      if (outcome.kind === "failed") return setNotice({ error: true, text: errorMessage(outcome.failure) });
      setNotice({ error: false, text: t("done") });
      setFile(null);
      setLabel("");
      if (input.current) input.current.value = "";
    });
  };

  const sending = progress !== null;
  return (
    <form
      className="flex flex-col gap-2 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        start();
      }}
    >
      <h3 className="font-medium">{t("title")}</h3>
      <p className="text-muted">{t("hint", { max: formatSize(maxBytes) })}</p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          type="file"
          accept=".zip,application/zip"
          aria-label={t("file")}
          className="max-w-xs text-xs"
          disabled={sending}
          onChange={(event) => {
            setNotice(null);
            setFile(event.target.files?.[0] ?? null);
          }}
        />
        <input
          className="field max-w-xs py-1 text-xs"
          value={label}
          maxLength={100}
          placeholder={tSaves("labelPlaceholder")}
          disabled={sending}
          onChange={(event) => setLabel(event.target.value)}
        />
        {sending ? (
          <button type="button" className="btn text-xs" onClick={() => abort.current?.abort()}>
            {t("cancel")}
          </button>
        ) : (
          <button type="submit" className="btn-primary text-xs" disabled={!file || busy}>
            {t("start")}
          </button>
        )}
      </div>
      {progress && file && (
        <div className="flex flex-col gap-1" aria-live="polite">
          <progress className="w-full max-w-md" max={file.size} value={progress.sent} />
          <span className="text-muted">
            {progress.resuming
              ? t("resuming")
              : t("progress", {
                  percent: Math.floor((progress.sent / file.size) * 100),
                  sent: formatSize(progress.sent),
                  total: formatSize(file.size),
                })}
          </span>
        </div>
      )}
      {notice && (
        <p role={notice.error ? "alert" : "status"} className={notice.error ? "text-danger" : "text-ok"}>
          {notice.text}
        </p>
      )}
    </form>
  );
}

type ScheduleProps = {
  settings: BackupSettingsDto;
  editable: boolean;
  onSave: (settings: Omit<BackupSettingsDto, "lastRunAt">) => Promise<SavesOutcome>;
};

function Schedule({ settings, editable, onSave }: ScheduleProps) {
  const t = useTranslations("saves.schedule");
  const errorMessage = useErrorMessage();
  const [draft, setDraft] = useState<Omit<BackupSettingsDto, "lastRunAt">>({
    enabled: settings.enabled,
    intervalMinutes: settings.intervalMinutes,
    keepLast: settings.keepLast,
    maxAgeDays: settings.maxAgeDays,
    triggerSave: settings.triggerSave,
  });
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);

  const number = (key: "intervalMinutes" | "keepLast" | "maxAgeDays", min: number, max: number) => (
    <input
      type="number"
      className="field w-24 py-1 text-xs"
      min={min}
      max={max}
      value={draft[key]}
      disabled={!editable}
      onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) })}
    />
  );

  return (
    <form
      className="flex flex-col gap-2 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(draft).then((outcome) =>
          setNotice(
            outcome.kind === "failed"
              ? { error: true, text: errorMessage(outcome.failure) }
              : { error: false, text: t("saved") },
          ),
        );
      }}
    >
      <h3 className="font-medium">{t("title")}</h3>
      <p className="text-muted">
        {settings.lastRunAt ? t("lastRun", { date: new Date(settings.lastRunAt).toLocaleString() }) : t("never")}
      </p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={!editable}
          onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
        />
        {t("enabled")}
      </label>
      <label className="flex items-center gap-2">
        {number("intervalMinutes", 15, 10080)} {t("interval")}
      </label>
      <label className="flex items-center gap-2">
        {number("keepLast", 0, 1000)} {t("keepLast")}
      </label>
      <label className="flex items-center gap-2">
        {number("maxAgeDays", 0, 365)} {t("maxAgeDays")}
      </label>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={draft.triggerSave}
          disabled={!editable}
          onChange={(event) => setDraft({ ...draft, triggerSave: event.target.checked })}
        />
        <span>
          {t("triggerSave")}
          <span className="block text-muted">{t("triggerSaveHint")}</span>
        </span>
      </label>
      {editable && (
        <div>
          <button type="submit" className="btn text-xs">
            {t("save")}
          </button>
        </div>
      )}
      {notice && (
        <p role={notice.error ? "alert" : "status"} className={notice.error ? "text-danger" : "text-ok"}>
          {notice.text}
        </p>
      )}
    </form>
  );
}
