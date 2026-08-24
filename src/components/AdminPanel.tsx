"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import AuditPanel from "@/components/AuditPanel";
import ConfirmDialog from "@/components/ConfirmDialog";
import Console from "@/components/Console";
import MetricsPanel from "@/components/MetricsPanel";
import QuickActions from "@/components/QuickActions";
import ServerStatusBar from "@/components/ServerStatusBar";
import { useActionText } from "@/hooks/useActionText";
import { useCommandRunner } from "@/hooks/useCommandRunner";
import { useServerStatus } from "@/hooks/useServerStatus";
import { fetchJson } from "@/lib/fetch-json";
import { isLuaCommand } from "@/lib/lua";
import { can } from "@/lib/permissions";
import type { ActionDto, SessionInfo } from "@/lib/api-types";

type Pending = { title: string; message: string; confirmLabel: string; run: () => void };

type Tab = "console" | "metrics";

const TABS: Tab[] = ["console", "metrics"];

type Props = {
  session: SessionInfo;
  actions: ActionDto[];
  /** `false` : fonctionnalité coupée côté serveur, l'onglet n'existe pas. */
  metricsEnabled: boolean;
};

export default function AdminPanel({ session, actions, metricsEnabled }: Props) {
  const t = useTranslations();
  const text = useActionText();
  const router = useRouter();
  const [pending, setPending] = useState<Pending | null>(null);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("console");

  const canRunRaw = can(session.role, "rcon:raw");
  const canReadAudit = can(session.role, "audit:read");

  const onUnauthorized = useCallback(() => {
    router.replace("/login");
    router.refresh();
  }, [router]);

  const { status, refresh } = useServerStatus({
    enabled: can(session.role, "status:read"),
    onUnauthorized,
  });

  const { entries, busy, runCommand, runAction, clear } = useCommandRunner({
    onUnauthorized,
    onSuccess: () => void refresh(),
  });

  const submitCommand = useCallback(
    (command: string) => {
      if (isLuaCommand(command)) {
        setPending({
          title: t("lua.title"),
          message: `${t("lua.warning")}\n\n${command}`,
          confirmLabel: t("lua.runAnyway"),
          run: () => void runCommand(command),
        });
        return;
      }
      void runCommand(command);
    },
    [runCommand, t],
  );

  const submitAction = useCallback(
    (action: ActionDto, values: Record<string, string>) => {
      const label = `${text.label(action)}${values.player ? ` ${values.player}` : ""}`;

      if (action.confirm) {
        setPending({
          title: text.label(action),
          message: text.confirmation(action, values),
          confirmLabel: t("confirm.confirm"),
          run: () => void runAction(action.id, label, values),
        });
        return;
      }

      void runAction(action.id, label, values);
    },
    [runAction, t, text],
  );

  const logout = useCallback(async () => {
    const outcome = await fetchJson<{ ok: true }>("/api/logout", { method: "POST" });

    if (outcome.kind === "error") {
      // La session reste valide côté serveur : mieux vaut le dire que de
      // rediriger en laissant croire à une déconnexion effective.
      setLogoutError(t("errors.logout_failed"));
      return;
    }

    onUnauthorized();
  }, [onUnauthorized, t]);

  const consolePane = (
    <Console
      entries={entries}
      busy={busy}
      canRun={canRunRaw}
      onRun={submitCommand}
      onClear={clear}
      className={metricsEnabled && tab !== "console" ? "hidden" : ""}
    />
  );

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-4 p-4">
      <ServerStatusBar
        session={session}
        status={status}
        onRefresh={() => void refresh()}
        onLogout={() => void logout()}
        logoutError={logoutError}
      />

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[22rem_1fr]">
        <div className="flex flex-col gap-4">
          <QuickActions actions={actions} busy={busy} onRun={submitAction} />
          {canReadAudit && <AuditPanel onUnauthorized={onUnauthorized} />}
        </div>
        {/* Sans métriques, la console reprend toute la colonne : un onglet
            unique n'est pas un onglet, et l'écran redevient exactement celui
            d'avant la fonctionnalité. */}
        {metricsEnabled ? (
          // Les deux panneaux restent montés : masquer plutôt que démonter
          // préserve la saisie et le défilement de la console d'un onglet à
          // l'autre. Le sondage des métriques est coupé par `active`.
          <div className="flex min-h-0 flex-col gap-3">
            <nav className="flex gap-2">
              {TABS.map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={tab === key}
                  className={`btn text-xs ${tab === key ? "border-accent text-accent" : ""}`}
                  onClick={() => setTab(key)}
                >
                  {t(`tabs.${key}`)}
                </button>
              ))}
            </nav>

            {consolePane}

            <MetricsPanel
              active={tab === "metrics"}
              onUnauthorized={onUnauthorized}
              className={tab === "metrics" ? "flex-1" : "hidden"}
            />
          </div>
        ) : (
          consolePane
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
    </div>
  );
}
