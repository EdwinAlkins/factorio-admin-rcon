"use client";

import { useTranslations } from "next-intl";
import LocaleSwitcher from "@/components/LocaleSwitcher";
import type { SessionInfo } from "@/lib/api-types";
import type { ServerStatus } from "@/lib/types";

type Props = {
  session: SessionInfo;
  status: ServerStatus;
  onRefresh: () => void;
  onLogout: () => void;
  logoutError: string | null;
};

export default function ServerStatusBar({
  session,
  status,
  onRefresh,
  onLogout,
  logoutError,
}: Props) {
  const t = useTranslations();
  const online = status.state === "ok" ? status.count : null;
  const dotLabel =
    status.state === "ok"
      ? t("statusBar.dot.ok", { count: status.count })
      : status.state === "error"
        ? t("statusBar.dot.error")
        : t("statusBar.dot.loading");

  return (
    <header className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3">
      <div>
        <h1 className="text-base font-semibold">
          {t("app.brand")} <span className="text-accent">{t("app.brandSuffix")}</span>
        </h1>
        <p className="text-xs text-muted">
          {session.username} · {t(`roles.${session.role}`)}
          {status.state === "ok" &&
            ` · ${t("statusBar.target", { target: status.target, version: status.version })}`}
          {status.state === "error" && ` · ${status.message}`}
          {status.state === "loading" && ` · ${t("statusBar.connecting")}`}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <p className="text-sm" aria-live="polite">
          <span
            aria-label={dotLabel}
            role="img"
            className={status.state === "ok" && status.count > 0 ? "text-ok" : "text-muted"}
          >
            ●
          </span>{" "}
          {online === null ? (
            t("statusBar.unknown")
          ) : (
            <>
              {t("statusBar.online", { count: online })}
              {status.state === "ok" && online > 0 && (
                <span className="text-muted"> ({status.online.join(", ")})</span>
              )}
            </>
          )}
        </p>
        <LocaleSwitcher />
        <button type="button" className="btn" onClick={onRefresh}>
          {t("statusBar.refresh")}
        </button>
        <button type="button" className="btn" onClick={onLogout}>
          {t("statusBar.logout")}
        </button>
        {logoutError && (
          <span role="alert" className="text-xs text-danger">
            {logoutError}
          </span>
        )}
      </div>
    </header>
  );
}
