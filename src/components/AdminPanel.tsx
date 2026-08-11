"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import AuditPanel from "@/components/AuditPanel";
import ConfirmDialog from "@/components/ConfirmDialog";
import Console from "@/components/Console";
import QuickActions from "@/components/QuickActions";
import ServerStatusBar from "@/components/ServerStatusBar";
import { useCommandRunner } from "@/hooks/useCommandRunner";
import { useServerStatus } from "@/hooks/useServerStatus";
import { fetchJson } from "@/lib/fetch-json";
import { isLuaCommand } from "@/lib/lua";
import { can } from "@/lib/permissions";
import type { ActionDto, SessionInfo } from "@/lib/api-types";

const LUA_WARNING =
  "Cette commande utilise la console Lua : elle désactive définitivement les succès de cette partie.";

type Pending = { title: string; message: string; confirmLabel: string; run: () => void };

type Props = {
  session: SessionInfo;
  actions: ActionDto[];
};

export default function AdminPanel({ session, actions }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState<Pending | null>(null);
  const [logoutError, setLogoutError] = useState<string | null>(null);

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
          title: "Commande Lua",
          message: `${LUA_WARNING}\n\n${command}`,
          confirmLabel: "Exécuter quand même",
          run: () => void runCommand(command),
        });
        return;
      }
      void runCommand(command);
    },
    [runCommand],
  );

  const submitAction = useCallback(
    (action: ActionDto, values: Record<string, string>) => {
      const label = `${action.label}${values.player ? ` ${values.player}` : ""}`;

      if (action.confirmation) {
        setPending({
          title: action.label,
          message: action.confirmation.replace(
            /\{(\w+)\}/g,
            (_, key: string) => values[key] ?? `<${key}>`,
          ),
          confirmLabel: "Confirmer",
          run: () => void runAction(action.id, label, values),
        });
        return;
      }

      void runAction(action.id, label, values);
    },
    [runAction],
  );

  const logout = useCallback(async () => {
    const outcome = await fetchJson<{ ok: true }>("/api/logout", { method: "POST" });

    if (outcome.kind === "error") {
      // La session reste valide côté serveur : mieux vaut le dire que de
      // rediriger en laissant croire à une déconnexion effective.
      setLogoutError("Déconnexion impossible, réessayez.");
      return;
    }

    onUnauthorized();
  }, [onUnauthorized]);

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
        <Console
          entries={entries}
          busy={busy}
          canRun={canRunRaw}
          onRun={submitCommand}
          onClear={clear}
        />
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
