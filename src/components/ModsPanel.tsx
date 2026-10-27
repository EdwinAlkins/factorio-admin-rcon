"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useErrorMessage } from "@/hooks/useErrorMessage";
import { useMods, type ModsOutcome } from "@/hooks/useMods";
import { can } from "@/lib/permissions";
import type {
  InstalledModDto,
  ModChangeDto,
  ModDetailsDto,
  ModPlanDto,
  ModSearchHitDto,
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
  /** `false` while the tab is hidden: no polling then. */
  active: boolean;
  onUnauthorized: () => void;
  className?: string;
};

/** The confirmed preview, with the basket it was computed from. */
type Preview = { plan: ModPlanDto; basket: ModChangeDto[] };

/**
 * Mods tab: the server's mods, the portal (search, a mod's page), and a
 * basket of pending changes, previewed then applied as one operation with a
 * single restart. Everyone sees the list; changing it is for administrators.
 */
export default function ModsPanel({ session, active, onUnauthorized, className }: Props) {
  const t = useTranslations("mods");
  const tStep = useTranslations("server.step");
  const errorMessage = useErrorMessage();
  const mods = useMods({ enabled: active, onUnauthorized });
  const { data, failure, basket } = mods;
  const [pending, setPending] = useState<Pending | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const manage = can(session.role, "mods:manage");
  const busy = mods.submitting || data?.operation != null;
  // A preview is only valid for the exact basket it was computed from.
  const currentPreview = preview && JSON.stringify(preview.basket) === JSON.stringify(basket) ? preview.plan : null;

  const add = (change: ModChangeDto) => {
    setActionError(null);
    mods.addChange(change);
  };

  const report = useCallback(
    (outcome: ModsOutcome) => {
      if (outcome.kind === "failed") setActionError(errorMessage(outcome.failure));
      if (outcome.kind === "done") {
        mods.clearBasket();
        setPreview(null);
      }
    },
    [errorMessage, mods],
  );

  const runPreview = async () => {
    setActionError(null);
    const snapshot = basket;
    const outcome = await mods.preview(snapshot);
    if (outcome.kind === "ok") setPreview({ plan: outcome.data.plan, basket: snapshot });
    else if (outcome.kind === "failed") setActionError(errorMessage(outcome.failure));
  };

  const askApply = (plan: ModPlanDto) => {
    setActionError(null);
    const changes = basket;
    setPending({
      title: t("confirm.applyTitle"),
      message: t("confirm.applyMessage"),
      confirmLabel: t("basket.apply"),
      run: () =>
        void mods.apply(changes, plan.hash).then((outcome) => {
          if (outcome.kind !== "needs_force") return report(outcome);
          // Second, explicit confirmation, carrying the reason for the refusal.
          setPending({
            title: t("confirm.forceTitle"),
            message: errorMessage(outcome.failure),
            confirmLabel: t("confirm.forceLabel"),
            run: () => void mods.apply(changes, plan.hash, true).then(report),
          });
        }),
    });
  };

  return (
    <section className={`flex min-h-0 flex-col rounded-lg border border-line bg-surface ${className ?? ""}`}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
        <h2 className="text-sm font-medium">
          {t("title")}
          {data?.factorioVersion && (
            <span className="ml-2 font-mono text-xs text-muted">{t("game", { version: data.factorioVersion })}</span>
          )}
        </h2>
        <button type="button" className="btn px-2 py-1 text-xs" onClick={() => void mods.refresh()}>
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
            {!data.factorioVersion && <p className="text-xs text-muted">{t("versionUnknown")}</p>}
            {actionError && (
              <p role="alert" className="text-xs text-danger">
                {actionError}
              </p>
            )}

            <Installed mods={data.mods} manage={manage} busy={busy} portalDown={data.portalError !== null} onChange={add} />

            {manage && data.factorioVersion && (
              <Search
                credentials={data.credentials}
                search={mods.search}
                onDetails={setSelected}
                onAdd={(name) => add({ action: "install", name })}
              />
            )}

            {manage && selected && (
              <Details
                key={selected}
                name={selected}
                load={mods.details}
                onAdd={(name, version) => add({ action: "install", name, version })}
                onClose={() => setSelected(null)}
              />
            )}

            {manage && (
              <div className="flex flex-col gap-2 text-xs">
                <h3 className="font-medium">{t("basket.title")}</h3>
                {basket.length === 0 ? (
                  <p className="text-muted">{t("basket.empty")}</p>
                ) : (
                  <>
                    <ul className="flex flex-col gap-1">
                      {basket.map((change) => (
                        <li key={change.name} className="flex items-center gap-2">
                          <span>
                            {t(`basket.change.${change.action}`, { name: change.name })}
                            {change.version && (
                              <span className="ml-1 font-mono text-muted">
                                {t("basket.version", { version: change.version })}
                              </span>
                            )}
                          </span>
                          <button
                            type="button"
                            className="btn px-1.5 py-0 text-xs"
                            aria-label={t("basket.remove")}
                            title={t("basket.remove")}
                            onClick={() => mods.removeChange(change.name)}
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className="btn text-xs" disabled={busy} onClick={() => void runPreview()}>
                        {t("basket.preview")}
                      </button>
                      <button
                        type="button"
                        className="btn text-xs"
                        onClick={() => {
                          mods.clearBasket();
                          setPreview(null);
                        }}
                      >
                        {t("basket.clear")}
                      </button>
                    </div>
                  </>
                )}

                {currentPreview && basket.length > 0 && (
                  <PlanView plan={currentPreview} busy={busy} onApply={() => askApply(currentPreview)} />
                )}
              </div>
            )}
          </>
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

type InstalledProps = {
  mods: InstalledModDto[];
  manage: boolean;
  busy: boolean;
  portalDown: boolean;
  onChange: (change: ModChangeDto) => void;
};

function Installed({ mods, manage, busy, portalDown, onChange }: InstalledProps) {
  const t = useTranslations("mods");
  return (
    <div>
      <h3 className="pb-1 text-xs font-medium">{t("installed")}</h3>
      {portalDown && <p className="pb-1 text-xs text-muted">{t("updatesUnavailable")}</p>}
      {mods.length === 0 ? (
        <p className="text-xs text-muted">{t("installedEmpty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted">
              <tr>
                <th className="py-1 pr-3 font-normal">{t("columns.name")}</th>
                <th className="py-1 pr-3 font-normal">{t("columns.version")}</th>
                <th className="py-1 pr-3 font-normal">{t("columns.state")}</th>
                {manage && <th className="py-1" />}
              </tr>
            </thead>
            <tbody>
              {mods.map((mod) => (
                <tr key={mod.name} className="border-t border-line align-top">
                  <td className="py-1 pr-3 font-mono">{mod.name}</td>
                  <td className="py-1 pr-3 font-mono whitespace-nowrap">
                    {mod.version ?? "—"}
                    {mod.update && <span className="ml-2 text-accent">{t("updateAvailable", { version: mod.update })}</span>}
                  </td>
                  <td className="py-1 pr-3">
                    <span className={mod.enabled ? "text-ok" : "text-muted"}>
                      {mod.enabled ? t("enabled") : t("disabled")}
                    </span>
                    {mod.builtin && <span className="ml-2 text-muted">{t("builtin")}</span>}
                    {mod.unpacked && <span className="ml-2 text-muted">{t("unpacked")}</span>}
                    {mod.dlc && <span className="ml-2 text-muted">{t("dlc")}</span>}
                  </td>
                  {manage && (
                    <td className="py-1">
                      <div className="flex flex-wrap justify-end gap-1">
                        {mod.update && !mod.builtin && !mod.unpacked && (
                          <button
                            type="button"
                            className="btn px-2 py-0.5 text-xs"
                            disabled={busy}
                            onClick={() => onChange({ action: "update", name: mod.name })}
                          >
                            {t("update")}
                          </button>
                        )}
                        {mod.name !== "base" && !mod.dlc && (
                          <button
                            type="button"
                            className="btn px-2 py-0.5 text-xs"
                            disabled={busy}
                            onClick={() => onChange({ action: mod.enabled ? "disable" : "enable", name: mod.name })}
                          >
                            {mod.enabled ? t("disable") : t("enable")}
                          </button>
                        )}
                        {!mod.builtin && !mod.unpacked && (
                          <button
                            type="button"
                            className="btn px-2 py-0.5 text-xs hover:border-danger hover:text-danger"
                            disabled={busy}
                            onClick={() => onChange({ action: "remove", name: mod.name })}
                          >
                            {t("remove")}
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const RECREATE = "docker compose up -d --force-recreate data-agent";

type SearchProps = {
  credentials: boolean;
  search: ReturnType<typeof useMods>["search"];
  onDetails: (name: string) => void;
  onAdd: (name: string) => void;
};

function Search({ credentials, search, onDetails, onAdd }: SearchProps) {
  const t = useTranslations("mods.search");
  const errorMessage = useErrorMessage();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ModSearchHitDto[] | null>(null);
  const [page, setPage] = useState({ current: 1, count: 1 });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async (pageNumber: number) => {
    setLoading(true);
    setError(null);
    const outcome = await search(query.trim(), pageNumber);
    setLoading(false);
    if (outcome.kind === "failed") return setError(errorMessage(outcome.failure));
    if (outcome.kind !== "ok") return;
    setHits((current) => (pageNumber === 1 ? outcome.data.hits : [...(current ?? []), ...outcome.data.hits]));
    setPage({ current: outcome.data.page, count: outcome.data.pageCount });
  };

  if (!credentials) {
    return (
      <div className="text-xs">
        <h3 className="pb-1 font-medium">{t("title")}</h3>
        <p className="text-muted">{t("noCredentials")}</p>
        {/* Literal file content and command: not translated, and kept out of
            the messages, where ICU would read the braces as placeholders. */}
        <pre className="mt-1 overflow-x-auto rounded border border-line p-2 font-mono text-muted">
          {`secrets/factorio-portal\n{"username": "your-name", "token": "..."}\n\n${RECREATE}`}
        </pre>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 text-xs">
      <h3 className="font-medium">{t("title")}</h3>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim()) void run(1);
        }}
      >
        <input
          className="field max-w-xs py-1 text-xs"
          value={query}
          maxLength={100}
          placeholder={t("placeholder")}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" className="btn text-xs" disabled={loading || !query.trim()}>
          {t("submit")}
        </button>
      </form>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {hits && hits.length === 0 && <p className="text-muted">{t("empty")}</p>}
      {hits && hits.length > 0 && (
        <ul className="flex flex-col gap-2">
          {hits.map((hit) => (
            <li key={hit.name} className="flex flex-wrap items-start justify-between gap-2 border-t border-line pt-2">
              <div className="min-w-0 flex-1">
                <p>
                  <span className="font-medium">{hit.title || hit.name}</span>{" "}
                  <span className="font-mono text-muted">{hit.name}</span>
                </p>
                <p className="text-muted">
                  {t("by", { owner: hit.owner })} · {t("downloads", { count: hit.downloads_count ?? 0 })}
                </p>
                {hit.summary && <p>{hit.summary}</p>}
              </div>
              <div className="flex gap-1">
                <button type="button" className="btn px-2 py-0.5 text-xs" onClick={() => onDetails(hit.name)}>
                  {t("details")}
                </button>
                {hit.installed ? (
                  <span className="px-2 py-0.5 text-muted">{t("installed")}</span>
                ) : (
                  <button type="button" className="btn px-2 py-0.5 text-xs" onClick={() => onAdd(hit.name)}>
                    {t("add")}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {hits && page.current < page.count && (
        <div>
          <button type="button" className="btn text-xs" disabled={loading} onClick={() => void run(page.current + 1)}>
            {t("more")}
          </button>
        </div>
      )}
    </div>
  );
}

type DetailsProps = {
  name: string;
  load: ReturnType<typeof useMods>["details"];
  onAdd: (name: string, version: string) => void;
  onClose: () => void;
};

function Details({ name, load, onAdd, onClose }: DetailsProps) {
  const t = useTranslations("mods.details");
  const errorMessage = useErrorMessage();
  const [state, setState] = useState<{ mod?: ModDetailsDto; error?: string }>({});

  // Mounted with a `key` per mod, so a new selection starts from scratch and
  // an answer for a previous one can never land here.
  useEffect(() => {
    let alive = true;
    void load(name).then((outcome) => {
      if (!alive) return;
      if (outcome.kind === "ok") setState({ mod: outcome.data.mod });
      else if (outcome.kind === "failed") setState({ error: errorMessage(outcome.failure) });
    });
    return () => {
      alive = false;
    };
  }, [errorMessage, load, name]);

  const mod = state.mod;
  return (
    <div className="flex flex-col gap-2 rounded border border-line p-3 text-xs">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium">
          {mod?.title || name} <span className="font-mono text-muted">{name}</span>
        </h3>
        <button type="button" className="btn px-2 py-0.5 text-xs" onClick={onClose}>
          {t("close")}
        </button>
      </div>
      {state.error && (
        <p role="alert" className="text-danger">
          {state.error}
        </p>
      )}
      {mod && (
        <>
          {mod.summary && <p>{mod.summary}</p>}
          <h4 className="font-medium">{t("releases")}</h4>
          <ul className="flex flex-col gap-1">
            {mod.releases.map((release) => (
              <li key={release.version} className="flex flex-wrap items-center gap-x-3">
                <span className="font-mono">{release.version}</span>
                <span className={release.compatible ? "text-ok" : "text-muted"}>
                  {release.compatible ? t("compatible") : t("otherGame", { version: release.factorioVersion })}
                </span>
                <span className="text-muted">{new Date(release.releasedAt).toLocaleDateString()}</span>
                <span className="text-muted">{t("dependencies", { list: release.dependencies.join(", ") || "—" })}</span>
                {release.compatible && (
                  <button
                    type="button"
                    className="btn px-2 py-0.5 text-xs"
                    onClick={() => onAdd(mod.name, release.version)}
                  >
                    {t("addVersion")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function PlanView({ plan, busy, onApply }: { plan: ModPlanDto; busy: boolean; onApply: () => void }) {
  const t = useTranslations("mods.plan");
  const tBasket = useTranslations("mods.basket");
  const blocked = plan.conflicts.length > 0 || plan.steps.length === 0;

  return (
    <div className="flex flex-col gap-2 rounded border border-line p-3">
      <h4 className="font-medium">{t("title")}</h4>
      {plan.steps.length === 0 ? (
        <p className="text-muted">{t("nothing")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {plan.steps.map((step) => (
            <li key={`${step.action}-${step.name}`}>
              <span className="font-mono">
                {t(`step.${step.action}`, { name: step.name, from: step.from ?? "", to: step.to ?? "" })}
              </span>
              {step.requiredBy && <span className="ml-2 text-muted">{t("requiredBy", { mod: step.requiredBy })}</span>}
            </li>
          ))}
        </ul>
      )}

      {plan.conflicts.length > 0 && (
        <div role="alert">
          <p className="font-medium text-danger">{t("conflicts")}</p>
          <ul className="flex flex-col gap-1">
            {plan.conflicts.map((conflict) => (
              <li key={`${conflict.mod}-${conflict.code}`} className="text-danger">
                <span className="font-mono">{conflict.mod || "—"}</span> : {conflictText(t, conflict.code)}
                <span className="ml-2 text-muted">{conflict.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {plan.optional.map((hint) => (
        <p key={`${hint.mod}-${hint.optional}`} className="text-muted">
          {t("optional", hint)}
        </p>
      ))}
      {plan.unchecked.length > 0 && <p className="text-muted">{t("unchecked", { list: plan.unchecked.join(", ") })}</p>}

      <div>
        <button type="button" className="btn-primary text-xs" disabled={busy || blocked} onClick={onApply}>
          {tBasket("apply")}
        </button>
      </div>
    </div>
  );
}

/** A conflict code the agent may add later falls back to its English detail. */
function conflictText(t: ReturnType<typeof useTranslations<"mods.plan">>, code: string): string {
  const key = `conflict.${code}` as Parameters<typeof t>[0];
  return t.has(key) ? t(key) : code;
}
