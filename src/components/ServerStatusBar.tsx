"use client";

import { ROLE_LABELS } from "@/lib/permissions";
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
  const online = status.state === "ok" ? status.count : null;
  const dotLabel =
    status.state === "ok"
      ? `Serveur joignable, ${status.count} joueur(s) en ligne`
      : status.state === "error"
        ? "Serveur injoignable"
        : "Statut en cours de chargement";

  return (
    <header className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3">
      <div>
        <h1 className="text-base font-semibold">
          Factorio <span className="text-accent">— panneau d&apos;admin</span>
        </h1>
        <p className="text-xs text-muted">
          {session.username} · {ROLE_LABELS[session.role]}
          {status.state === "ok" && ` · RCON ${status.target} · version ${status.version}`}
          {status.state === "error" && ` · ${status.message}`}
          {status.state === "loading" && " · connexion…"}
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
            "—"
          ) : (
            <>
              {online} en ligne
              {status.state === "ok" && online > 0 && (
                <span className="text-muted"> ({status.online.join(", ")})</span>
              )}
            </>
          )}
        </p>
        <button type="button" className="btn" onClick={onRefresh}>
          Rafraîchir
        </button>
        <button type="button" className="btn" onClick={onLogout}>
          Déconnexion
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
