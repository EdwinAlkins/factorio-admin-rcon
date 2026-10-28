"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import ConfirmDialog from "@/components/ConfirmDialog";
import ServerLogs from "@/components/ServerLogs";
import ServerSettingsPanel from "@/components/ServerSettingsPanel";
import { useDynamicTranslations } from "@/hooks/useDynamicTranslations";
import { useErrorMessage } from "@/hooks/useErrorMessage";
import type { OperationOutcome } from "@/hooks/useServerControl";
import type { FetchFailure } from "@/lib/fetch-json";
import { can } from "@/lib/permissions";
import type {
  ServerOperationDto,
  ServerLifecycleType,
  ServerResult,
  ServerState,
  SessionInfo,
} from "@/lib/api-types";

type Pending = {
  title: string;
  message: string;
  confirmLabel: string;
  run: () => void;
};

type Props = {
  session: SessionInfo;
  server: ServerResult | null;
  failure: FetchFailure | null;
  submitting: boolean;
  run: (type: ServerLifecycleType, force?: boolean) => Promise<OperationOutcome>;
  onRefresh: () => void;
  /** `false` while the tab is hidden: the logs stop refreshing. */
  active: boolean;
  onUnauthorized: () => void;
  className?: string;
};

const STATE_TONE: Record<ServerState, string> = {
  running: "text-ok",
  starting: "text-accent",
  stopping: "text-accent",
  stopped: "text-muted",
  error: "text-danger",
  unknown: "text-muted",
};

function uptime(startedAt: string | undefined, now = Date.now()) {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (!Number.isFinite(started)) return null;
  const minutes = Math.max(0, Math.floor((now - started) / 60_000));
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}

/**
 * Server tab: state, start/stop/restart, recent operations and, for
 * administrators, server-settings.json and the container's logs.
 *
 * The buttons follow the container's real state rather than the last click:
 * a server stopped from the command line shows "Start", not "Stop".
 */
export default function ServerPanel({
  session,
  server,
  failure,
  submitting,
  run,
  onRefresh,
  active,
  onUnauthorized,
  className,
}: Props) {
  const t = useTranslations("server");
  const tErrors = useDynamicTranslations("errors");
  const errorMessage = useErrorMessage();
  const [pending, setPending] = useState<Pending | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const container = server?.container ?? null;
  const busy = submitting || server?.operation != null;
  const containerUp = container?.state === "running" || container?.state === "restarting";

  const allowed = {
    start: can(session.role, "server:start"),
    stop: can(session.role, "server:stop"),
    restart: can(session.role, "server:restart"),
  };

  const report = useCallback(
    (outcome: OperationOutcome) => {
      if (outcome.kind === "failed") setRunError(errorMessage(outcome.failure));
    },
    [errorMessage],
  );

  const launch = useCallback(
    async (type: ServerLifecycleType) => {
      setRunError(null);
      const outcome = await run(type);

      if (outcome.kind === "needs_force") {
        // Second, explicit confirmation: the first one did not know there
        // were players, or that the server could not be saved first.
        setPending({
          title: t("confirm.forceTitle"),
          message: errorMessage(outcome.failure),
          confirmLabel: t("confirm.forceLabel"),
          run: () => void run(type, true).then(report),
        });
      } else {
        report(outcome);
      }
    },
    [errorMessage, report, run, t],
  );

  const ask = (type: ServerLifecycleType) => {
    setPending({
      title: t(`confirm.${type}Title`),
      message: t(`confirm.${type}Message`),
      confirmLabel: t(type),
      run: () => void launch(type),
    });
  };

  const state = server?.state;
  const running = server?.operation ?? null;
  const elapsed = container?.state === "running" ? uptime(container.startedAt) : null;

  return (
    <section className={`flex min-h-0 flex-col rounded-lg border border-line bg-surface ${className ?? ""}`}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
        <h2 className="text-sm font-medium">{t("title")}</h2>
        <button type="button" className="btn px-2 py-1 text-xs" onClick={onRefresh}>
          {t("refresh")}
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-3">
        {failure && (
          <p role="alert" className="text-xs text-danger">
            {errorMessage(failure)}
          </p>
        )}
        {!server && !failure && <p className="text-xs text-muted">{t("loading")}</p>}

        {server && state && (
          <>
            <div className="flex flex-col gap-3">
              <p className="text-sm" aria-live="polite">
                <span aria-hidden="true" className={STATE_TONE[state]}>
                  ●
                </span>{" "}
                <span className="font-medium">{t(`state.${state}`)}</span>
                {server.controlError && (
                  <span className="text-muted"> · {tErrors(server.controlError)}</span>
                )}
                {state === "error" && container?.state === "running" && !server.rcon.ok && (
                  <span className="text-muted"> · {t("rconDown")}</span>
                )}
              </p>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                <div>
                  <dt className="text-muted">{t("players")}</dt>
                  <dd className="font-mono">{server.rcon.count ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-muted">{t("version")}</dt>
                  <dd className="font-mono">{server.rcon.version ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-muted">{t("uptime")}</dt>
                  <dd className="font-mono">{elapsed ? t("uptimeValue", elapsed) : "—"}</dd>
                </div>
                <div>
                  <dt className="text-muted">{t("image")}</dt>
                  <dd className="truncate font-mono" title={container?.image}>
                    {container?.image ?? "—"}
                  </dd>
                </div>
              </dl>

              {running && (
                <p className="text-xs text-accent" aria-live="polite">
                  {t(`step.${running.step ?? "pending"}`)} ·{" "}
                  <span className="text-muted">{t("operationBy", { username: running.username })}</span>
                </p>
              )}

              {(allowed.start || allowed.stop || allowed.restart) && (
                <div className="flex flex-wrap gap-2">
                  {allowed.start && (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy || !container || containerUp}
                      onClick={() => ask("start")}
                    >
                      {t("start")}
                    </button>
                  )}
                  {allowed.stop && (
                    <button
                      type="button"
                      className="btn hover:border-danger hover:text-danger"
                      disabled={busy || container?.state !== "running"}
                      onClick={() => ask("stop")}
                    >
                      {t("stop")}
                    </button>
                  )}
                  {allowed.restart && (
                    <button
                      type="button"
                      className="btn hover:border-danger hover:text-danger"
                      disabled={busy || container?.state !== "running"}
                      onClick={() => ask("restart")}
                    >
                      {t("restart")}
                    </button>
                  )}
                </div>
              )}

              {runError && (
                <p role="alert" className="text-xs text-danger">
                  {runError}
                </p>
              )}
            </div>

            <OperationHistory operations={server.recent} />
          </>
        )}

        {can(session.role, "server:configure") && (
          <ServerSettingsPanel
            active={active}
            busy={submitting || server?.operation != null}
            onUnauthorized={onUnauthorized}
            onLaunched={onRefresh}
          />
        )}

        {can(session.role, "server:logs") && (
          <ServerLogs active={active} onUnauthorized={onUnauthorized} />
        )}
      </div>

      {pending && (
        <ConfirmDialog
          title={pending.title}
          message={pending.message}
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

const STATUS_TONE: Record<ServerOperationDto["status"], string> = {
  running: "text-accent",
  success: "text-ok",
  error: "text-danger",
  interrupted: "text-danger",
};

function OperationHistory({ operations }: { operations: ServerOperationDto[] }) {
  const t = useTranslations("server");
  const tErrors = useDynamicTranslations("errors");

  return (
    <div>
      <h3 className="pb-1 text-xs font-medium">{t("history")}</h3>
      {operations.length === 0 ? (
        <p className="text-xs text-muted">{t("historyEmpty")}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-xs">
          {operations.map((operation) => (
            <li key={operation.id} className="flex flex-wrap gap-x-2">
              <time className="font-mono text-muted" dateTime={new Date(operation.startedAt).toISOString()}>
                {new Date(operation.startedAt).toLocaleString()}
              </time>
              <span>{t(`type.${operation.type}`)}</span>
              <span className={STATUS_TONE[operation.status]}>{t(`status.${operation.status}`)}</span>
              {operation.forced && <span className="text-accent">{t("forced")}</span>}
              <span className="text-muted">{operation.username}</span>
              {operation.errorCode && (
                <span className="text-muted">
                  · {tErrors.has(operation.errorCode) ? tErrors(operation.errorCode) : operation.errorCode}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
