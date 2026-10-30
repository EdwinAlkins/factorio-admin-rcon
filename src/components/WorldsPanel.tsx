"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import ConfirmDialog from "@/components/ConfirmDialog";
import WorldCreator from "@/components/WorldCreator";
import { useErrorMessage } from "@/hooks/useErrorMessage";
import { useWorlds, type WorldsOutcome } from "@/hooks/useWorlds";
import { can } from "@/lib/permissions";
import type { SessionInfo, WorldDto, WorldSettings } from "@/lib/api-types";

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
 * Worlds tab: a creator with the game's whole map generator and a terrain
 * preview, and the library of generated worlds — each can be put in play,
 * which archives the current map first. Previews and creation run beside the
 * server, never stopping it. Moderators see the library; acting is for
 * administrators.
 */
export default function WorldsPanel({ session, active, onUnauthorized, className }: Props) {
  const t = useTranslations("worlds");
  const tStep = useTranslations("server.step");
  const errorMessage = useErrorMessage();
  const worlds = useWorlds({ enabled: active, onUnauthorized });
  const { data, failure, catalog, catalogFailure, submitting } = worlds;
  const [pending, setPending] = useState<Pending | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creatorOpen, setCreatorOpen] = useState(false);
  // A world whose settings the creator starts from; the key remounts it.
  const [template, setTemplate] = useState<{ key: number; world: { name: string; seed: number; settings: WorldSettings } } | null>(
    null,
  );

  const allowed = {
    create: can(session.role, "worlds:create"),
    activate: can(session.role, "worlds:activate"),
    remove: can(session.role, "worlds:delete"),
  };
  const busy = submitting || data?.operation != null;
  const mismatch = data?.serverVersion && data.agentVersion && data.serverVersion !== data.agentVersion;

  const report = (outcome: WorldsOutcome<unknown>) => {
    if (outcome.kind === "failed") setActionError(errorMessage(outcome.failure));
  };

  const openCreator = (open: boolean) => {
    setCreatorOpen(open);
    if (open && !catalog) void worlds.loadCatalog();
  };

  const reuse = (world: WorldDto) => {
    setTemplate({ key: Date.now(), world: { name: world.name, seed: world.seed, settings: world.settings } });
    openCreator(true);
  };

  const askActivate = (world: WorldDto) => {
    setActionError(null);
    setPending({
      title: t("confirm.activateTitle"),
      message: t("confirm.activateMessage", { name: world.name }),
      details: t("confirm.activateDetails"),
      confirmLabel: t("activate"),
      run: () =>
        void worlds.activate(world.id).then((outcome) => {
          if (outcome.kind !== "needs_force") return report(outcome);
          // Second, explicit confirmation, carrying the reason for the refusal.
          setPending({
            title: t("confirm.forceTitle"),
            message: errorMessage(outcome.failure),
            confirmLabel: t("confirm.forceLabel"),
            run: () => void worlds.activate(world.id, true).then(report),
          });
        }),
    });
  };

  const askDelete = (world: WorldDto) => {
    setActionError(null);
    setPending({
      title: t("confirm.deleteTitle"),
      message: t("confirm.deleteMessage", { name: world.name }),
      confirmLabel: t("delete"),
      run: () => void worlds.remove(world.id).then(report),
    });
  };

  return (
    <section className={`flex min-h-0 flex-col rounded-lg border border-line bg-surface ${className ?? ""}`}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
        <h2 className="text-sm font-medium">{t("title")}</h2>
        <button type="button" className="btn px-2 py-1 text-xs" onClick={() => void worlds.refresh()}>
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
            {mismatch && (
              <p role="alert" className="rounded border border-accent px-3 py-2 text-xs text-accent">
                {t("versionMismatch", { agent: data.agentVersion, server: data.serverVersion ?? "" })}
              </p>
            )}
            {data.operation && (
              <p className="text-xs text-accent" aria-live="polite">
                {t("operation", { step: tStep(data.operation.step ?? "pending") })}
              </p>
            )}
            {actionError && (
              <p role="alert" className="text-xs text-danger">
                {actionError}
              </p>
            )}

            {allowed.create && (
              <details
                className="group/creator shrink-0 rounded border border-line text-xs"
                open={creatorOpen}
                onToggle={(event) => openCreator(event.currentTarget.open)}
              >
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 font-medium select-none [&::-webkit-details-marker]:hidden">
                  <span aria-hidden="true" className="text-muted transition-transform group-open/creator:rotate-90">
                    ▸
                  </span>
                  <h3>{t("creator")}</h3>
                  <span className="font-normal text-muted">{t("creatorHint")}</span>
                </summary>
                <div className="border-t border-line px-3 py-3">
                  {catalogFailure && (
                    <p role="alert" className="text-danger">
                      {errorMessage(catalogFailure)}{" "}
                      <button type="button" className="btn px-2 py-0.5 text-xs" onClick={() => void worlds.loadCatalog()}>
                        {t("retry")}
                      </button>
                    </p>
                  )}
                  {!catalog && !catalogFailure && <p className="text-muted">{t("catalogLoading")}</p>}
                  {catalog && (
                    <WorldCreator
                      key={template?.key ?? 0}
                      catalog={catalog}
                      initial={template?.world}
                      busy={busy}
                      preview={worlds.preview}
                      create={worlds.create}
                    />
                  )}
                </div>
              </details>
            )}

            <div>
              <h3 className="pb-1 text-xs font-medium">{t("library")}</h3>
              {data.worlds.length === 0 ? (
                <p className="text-xs text-muted">{t("libraryEmpty")}</p>
              ) : (
                <ul className="grid gap-3 lg:grid-cols-2">
                  {data.worlds.map((world) => (
                    <li key={world.id} className="flex gap-3 rounded border border-line p-2 text-xs">
                      {world.preview ? (
                        // eslint-disable-next-line @next/next/no-img-element -- streamed from the agent, never optimised
                        <img
                          src={`/api/worlds/${encodeURIComponent(world.id)}/preview`}
                          alt={t("previewAlt", { seed: world.seed })}
                          loading="lazy"
                          className="size-24 shrink-0 rounded border border-line object-cover [image-rendering:pixelated]"
                        />
                      ) : (
                        <span className="size-24 shrink-0 rounded border border-line" />
                      )}
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <p className="truncate font-medium" title={world.name}>
                          {world.name}
                        </p>
                        <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-muted">
                          <dt>{t("seed")}</dt>
                          <dd className="font-mono text-ink">{world.seed}</dd>
                          <dt>{t("columns.created")}</dt>
                          <dd title={world.createdBy}>{new Date(world.createdAt).toLocaleString()}</dd>
                          <dt>{t("columns.version")}</dt>
                          <dd className="font-mono">
                            {world.factorioVersion} · {formatSize(world.size)}
                          </dd>
                          <dt>{t("columns.mods")}</dt>
                          <dd title={world.mods.map((mod) => (mod.version ? `${mod.name} ${mod.version}` : mod.name)).join(", ")}>
                            {world.mods.length}
                          </dd>
                        </dl>
                        <div className="flex flex-wrap gap-1 pt-1 whitespace-nowrap">
                          {allowed.activate && (
                            <button type="button" className="btn-primary px-2 py-0.5 text-xs" disabled={busy} onClick={() => askActivate(world)}>
                              {t("activate")}
                            </button>
                          )}
                          {allowed.create && (
                            <>
                              <button type="button" className="btn px-2 py-0.5 text-xs" onClick={() => reuse(world)}>
                                {t("reuse")}
                              </button>
                              <a
                                className="btn px-2 py-0.5 text-xs"
                                href={`/api/worlds/${encodeURIComponent(world.id)}/download`}
                                download
                              >
                                {t("download")}
                              </a>
                            </>
                          )}
                          {allowed.remove && (
                            <button type="button" className="btn px-2 py-0.5 text-xs" disabled={busy} onClick={() => askDelete(world)}>
                              {t("delete")}
                            </button>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
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
