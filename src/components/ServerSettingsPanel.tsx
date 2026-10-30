"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useErrorMessage } from "@/hooks/useErrorMessage";
import { fetchJson, type FetchFailure } from "@/lib/fetch-json";
import {
  ALLOW_COMMANDS,
  SECRET_MAX,
  SERVER_SECRETS,
  SERVER_SETTING_FIELDS,
  SERVER_SETTING_GROUPS,
  type ServerSecretKey,
  type ServerSettingKey,
} from "@/lib/server-settings";
import type {
  SecretChangeDto,
  ServerOperationResult,
  ServerSettingsChangeDto,
  ServerSettingsResult,
} from "@/lib/api-types";

type Field = (typeof SERVER_SETTING_FIELDS)[number];
type Visibility = { public: boolean; lan: boolean };
/** What an input holds: text while typing, converted on submit. */
type Draft = string | boolean | Visibility;
type SecretDraft = { value: string; clear: boolean };

/** Refusals the operator can override by confirming a second time. */
const FORCEABLE = new Set(["players_online", "rcon_unavailable_force_required"]);

function toDraft(field: Field, value: unknown): Draft {
  switch (field.kind) {
    case "bool":
      return value === true;
    case "visibility": {
      const v = (value ?? {}) as Partial<Visibility>;
      return { public: v.public === true, lan: v.lan === true };
    }
    case "tags":
      return Array.isArray(value) ? value.join(", ") : "";
    case "int":
      return typeof value === "number" ? String(value) : "";
    default:
      return typeof value === "string" ? value : "";
  }
}

function fromDraft(field: Field, draft: Draft): unknown {
  switch (field.kind) {
    case "bool":
    case "visibility":
      return draft;
    case "tags":
      return (draft as string)
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
    case "int":
      return (draft as string).trim() === "" ? Number.NaN : Number(draft);
    default:
      return draft;
  }
}

function drafts(settings: ServerSettingsResult["settings"]): Record<string, Draft> {
  return Object.fromEntries(SERVER_SETTING_FIELDS.map((field) => [field.key, toDraft(field, settings[field.key])]));
}

const emptySecrets = (): Record<ServerSecretKey, SecretDraft> =>
  Object.fromEntries(SERVER_SECRETS.map((key) => [key, { value: "", clear: false }])) as Record<
    ServerSecretKey,
    SecretDraft
  >;

type Props = {
  /** `false` while the tab is hidden: nothing is loaded then. */
  active: boolean;
  /** An operation runs: saving waits for it. */
  busy: boolean;
  onUnauthorized: () => void;
  /** Called once a restart has been launched, so the tab polls it. */
  onLaunched: () => void;
};

/**
 * server-settings.json, as a form: the game's listing, access, autosaves,
 * pause and network. Secrets are never shown, only replaced or cleared.
 * "Save" writes the file for the next start; "Save and restart" applies it
 * now, with a rollback if the server does not come back.
 */
export default function ServerSettingsPanel({ active, busy, onUnauthorized, onLaunched }: Props) {
  const t = useTranslations("serverSettings");
  const errorMessage = useErrorMessage();
  const [data, setData] = useState<ServerSettingsResult | null>(null);
  const [failure, setFailure] = useState<FetchFailure | null>(null);
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [secrets, setSecrets] = useState(emptySecrets);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [pending, setPending] = useState<{
    title: string;
    message: string;
    label: string;
    run: () => void;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const unauthorized = useRef(onUnauthorized);
  useEffect(() => {
    unauthorized.current = onUnauthorized;
  });

  const load = useCallback(async () => {
    const outcome = await fetchJson<ServerSettingsResult>("/api/server-settings");
    if (outcome.kind === "unauthorized") return unauthorized.current();
    if (outcome.kind === "error") return setFailure(outcome);
    setFailure(null);
    setData(outcome.data);
    setDraft(drafts(outcome.data.settings));
    setTouched(new Set());
    setSecrets(emptySecrets());
  }, []);

  useEffect(() => {
    if (active && !data && !failure) void load();
  }, [active, data, failure, load]);

  const edit = (key: string, value: Draft) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setTouched((current) => new Set(current).add(key));
    setNotice(null);
  };

  /** The change to send, or null when nothing differs from the file. */
  const change = (restart: boolean): ServerSettingsChangeDto | null => {
    if (!data) return null;
    const settings: ServerSettingsChangeDto["settings"] = {};
    for (const field of SERVER_SETTING_FIELDS) {
      if (!touched.has(field.key)) continue;
      const value = fromDraft(field, draft[field.key]!);
      if (JSON.stringify(value) !== JSON.stringify(data.settings[field.key as ServerSettingKey])) {
        settings[field.key as ServerSettingKey] = value;
      }
    }
    const secretChanges: ServerSettingsChangeDto["secrets"] = {};
    for (const key of SERVER_SECRETS) {
      const secret = secrets[key];
      if (secret.clear) secretChanges[key] = { clear: true } satisfies SecretChangeDto;
      else if (secret.value) secretChanges[key] = { set: secret.value };
    }
    if (Object.keys(settings).length + Object.keys(secretChanges).length === 0) return null;
    return { settings, secrets: secretChanges, hash: data.hash, restart };
  };

  const submit = async (body: ServerSettingsChangeDto) => {
    setSubmitting(true);
    try {
      const outcome = await fetchJson<ServerSettingsResult | ServerOperationResult>("/api/server-settings", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      if (outcome.kind === "unauthorized") return unauthorized.current();
      if (outcome.kind === "error") {
        if (body.restart && !body.force && FORCEABLE.has(outcome.code)) {
          // Second, explicit confirmation, carrying the reason for the refusal.
          setPending({
            title: t("confirm.forceTitle"),
            message: errorMessage(outcome),
            label: t("confirm.forceLabel"),
            run: () => void submit({ ...body, force: true }),
          });
          return;
        }
        return setNotice({ error: true, text: errorMessage(outcome) });
      }
      setNotice({
        error: false,
        text: body.restart ? t("launched") : t("saved"),
      });
      if (body.restart) onLaunched();
      await load();
    } finally {
      setSubmitting(false);
    }
  };

  const save = (restart: boolean) => {
    const body = change(restart);
    if (!body) return setNotice({ error: false, text: t("nothingChanged") });
    if (!restart) return void submit(body);
    setPending({
      title: t("confirm.restartTitle"),
      message: t("confirm.restartMessage"),
      label: t("saveRestart"),
      run: () => void submit(body),
    });
  };

  const input = (field: Field) => {
    const value = draft[field.key];
    switch (field.kind) {
      case "bool":
        return (
          <input type="checkbox" checked={value === true} onChange={(event) => edit(field.key, event.target.checked)} />
        );
      case "visibility": {
        const v = value as Visibility;
        return (
          <span className="flex gap-3">
            {(["public", "lan"] as const).map((which) => (
              <label key={which} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={v[which]}
                  onChange={(event) => edit(field.key, { ...v, [which]: event.target.checked })}
                />
                {t(`visibility.${which}`)}
              </label>
            ))}
          </span>
        );
      }
      case "allowCommands":
        return (
          <select
            className="field w-40 py-1 text-xs"
            value={value as string}
            onChange={(event) => edit(field.key, event.target.value)}>
            {ALLOW_COMMANDS.map((mode) => (
              <option key={mode} value={mode}>
                {t(`allowCommands.${mode}`)}
              </option>
            ))}
          </select>
        );
      case "int":
        return (
          <input
            type="number"
            className="field w-28 py-1 text-xs"
            min={field.min}
            max={field.max}
            value={value as string}
            onChange={(event) => edit(field.key, event.target.value)}
          />
        );
      case "longText":
        return (
          <textarea
            className="field w-full max-w-md py-1 text-xs"
            rows={3}
            maxLength={field.max}
            value={value as string}
            onChange={(event) => edit(field.key, event.target.value)}
          />
        );
      default:
        return (
          <input
            className="field w-full max-w-md py-1 text-xs"
            maxLength={"max" in field ? field.max : undefined}
            placeholder={field.kind === "tags" ? t("tagsHint") : undefined}
            value={value as string}
            onChange={(event) => edit(field.key, event.target.value)}
          />
        );
    }
  };

  return (
    // Collapsed by default: a long form most visits never touch.
    <details className="group shrink-0 rounded border border-line text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 font-medium select-none [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="text-muted transition-transform group-open:rotate-90">
          ▸
        </span>
        <h3>{t("title")}</h3>
      </summary>
      <div className="flex flex-col gap-3 border-t border-line px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-muted">{t("hint")}</p>
          <button type="button" className="btn shrink-0 px-2 py-0.5 text-xs" onClick={() => void load()}>
            {t("refresh")}
          </button>
        </div>
        {failure && (
          <p role="alert" className="text-danger">
            {errorMessage(failure)}
          </p>
        )}
        {!data && !failure && <p className="text-muted">{t("loading")}</p>}

        {data && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save(false);
            }}>
            {SERVER_SETTING_GROUPS.map((group) => (
              <fieldset key={group} className="flex flex-col gap-2">
                <legend className="pb-1 font-medium">{t(`groups.${group}`)}</legend>
                {SERVER_SETTING_FIELDS.filter((field) => field.group === group).map((field) => (
                  <label key={field.key} className="grid gap-1 sm:grid-cols-[16rem_1fr] sm:items-center">
                    <span>
                      {t(`fields.${field.key}`)}
                      {touched.has(field.key) && <span className="text-accent"> •</span>}
                    </span>
                    {input(field)}
                  </label>
                ))}
              </fieldset>
            ))}

            <fieldset className="flex flex-col gap-2">
              <legend className="pb-1 font-medium">{t("secrets.title")}</legend>
              {SERVER_SECRETS.map((key) => (
                <div key={key} className="grid gap-1 sm:grid-cols-[16rem_1fr] sm:items-center">
                  <span>
                    {t(`secrets.${key}`)}{" "}
                    <span className="text-muted">({data.secrets[key] ? t("secrets.isSet") : t("secrets.notSet")})</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <input
                      type="password"
                      autoComplete="new-password"
                      className="field w-56 py-1 text-xs"
                      maxLength={SECRET_MAX}
                      placeholder={t("secrets.newValue")}
                      aria-label={`${t(`secrets.${key}`)} — ${t("secrets.newValue")}`}
                      value={secrets[key].value}
                      disabled={secrets[key].clear}
                      onChange={(event) =>
                        setSecrets({
                          ...secrets,
                          [key]: { value: event.target.value, clear: false },
                        })
                      }
                    />
                    {data.secrets[key] && (
                      <label className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={secrets[key].clear}
                          onChange={(event) =>
                            setSecrets({
                              ...secrets,
                              [key]: { value: "", clear: event.target.checked },
                            })
                          }
                        />
                        {t("secrets.clear")}
                      </label>
                    )}
                  </span>
                </div>
              ))}
            </fieldset>

            <div className="flex flex-wrap gap-2">
              <button type="submit" className="btn text-xs" disabled={submitting || busy}>
                {t("save")}
              </button>
              <button
                type="button"
                className="btn-primary text-xs"
                disabled={submitting || busy}
                onClick={() => save(true)}>
                {t("saveRestart")}
              </button>
            </div>
            {notice && (
              <p role={notice.error ? "alert" : "status"} className={notice.error ? "text-danger" : "text-ok"}>
                {notice.text}
              </p>
            )}
          </form>
        )}
      </div>

      {pending && (
        <ConfirmDialog
          title={pending.title}
          message={pending.message}
          confirmLabel={pending.label}
          onConfirm={() => {
            pending.run();
            setPending(null);
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </details>
  );
}
