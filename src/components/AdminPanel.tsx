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
import { renderTemplate } from "@/lib/lua-template";
import { can } from "@/lib/permissions";
import type { ActionDto, SessionInfo } from "@/lib/api-types";

type Pending = {
  title: string;
  message: string;
  details?: string;
  confirmLabel: string;
  run: () => void;
};

type Tab = "console" | "metrics";

/**
 * The command as it will be sent, shown before confirming. Purely informative:
 * the server re-renders it from the template it holds, and only its version is
 * authoritative. A rendering that fails (input still incomplete) therefore does
 * not block sending — the server will answer with a validation error.
 */
function preview(action: ActionDto, values: Record<string, string>): string | undefined {
  if (!action.template) return undefined;

  try {
    return renderTemplate(action.template, action.fields, values);
  } catch {
    return undefined;
  }
}

const TABS: Tab[] = ["console", "metrics"];

type Props = {
  session: SessionInfo;
  actions: ActionDto[];
  /** `false`: the feature is off server-side, so the tab does not exist. */
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
          message: t("lua.warning"),
          details: command,
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
          details: preview(action, values),
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
      // The session is still valid server-side: better to say so than to
      // redirect and imply the sign-out actually happened.
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

  // The shell is pinned to the viewport from `lg` up: every panel below
  // already scrolls on its own (`min-h-0 flex-1 overflow-y-auto`), but a
  // `flex-1` under a `min-h-*` parent caps nothing, so the console used to
  // stretch the page instead of scrolling inside it. Below `lg` the panels are
  // stacked and the page scroll is the only sensible one, so no ceiling there.
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-7xl flex-col gap-4 p-4 lg:h-dvh lg:min-h-0 lg:overflow-hidden">
      <ServerStatusBar
        session={session}
        status={status}
        onRefresh={() => void refresh()}
        onLogout={() => void logout()}
        logoutError={logoutError}
      />

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[22rem_1fr]">
        <div className="flex flex-col gap-4 lg:min-h-0">
          <QuickActions actions={actions} busy={busy} onRun={submitAction} />
          {canReadAudit && <AuditPanel onUnauthorized={onUnauthorized} />}
        </div>
        {/* Sans métriques, la console reprend toute la colonne : un onglet
            unique n'est pas un onglet, et l'écran redevient exactement celui
            d'avant la fonctionnalité. */}
        {metricsEnabled ? (
          // Both panels stay mounted: hiding rather than unmounting preserves
          // the console's input and scroll position across tabs. Metric polling
          // is stopped by `active`.
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
          details={pending.details}
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
