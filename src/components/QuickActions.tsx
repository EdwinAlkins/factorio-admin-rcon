"use client";

import { useId, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useActionText } from "@/hooks/useActionText";
import type { ActionDto, ActionFieldDto } from "@/lib/api-types";

type Props = {
  actions: ActionDto[];
  busy: boolean;
  onRun: (action: ActionDto, values: Record<string, string>) => void;
};

/** The form's starting values: the defaults the action declares. */
function initialValues(action: ActionDto): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of action.fields) {
    if (field.default !== undefined) values[field.name] = field.default;
    else if (field.kind === "bool") values[field.name] = "false";
  }
  return values;
}

export default function QuickActions({ actions, busy, onRun }: Props) {
  const t = useTranslations("quickActions");
  const text = useActionText();
  const [openId, setOpenId] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const fieldId = useId();

  const groups = useMemo(() => {
    const byGroup = new Map<string, ActionDto[]>();
    for (const action of actions) {
      const list = byGroup.get(action.group) ?? [];
      list.push(action);
      byGroup.set(action.group, list);
    }
    return [...byGroup.entries()];
  }, [actions]);

  function select(action: ActionDto) {
    if (action.fields.length === 0) {
      onRun(action, {});
      return;
    }
    setValues(initialValues(action));
    setOpenId((current) => (current === action.id ? null : action.id));
  }

  function submit(action: ActionDto) {
    const missing = action.fields.some(
      (field) => field.required && !(values[field.name] ?? "").trim(),
    );
    if (missing) return;

    onRun(action, values);
    setValues({});
    setOpenId(null);
  }

  function update(name: string, value: string) {
    setValues((current) => ({ ...current, [name]: value }));
  }

  /** The widget follows the declared type: a closed list deserves a menu, not a free field. */
  function control(action: ActionDto, field: ActionFieldDto, id: string) {
    const value = values[field.name] ?? "";

    if (field.kind === "enum") {
      return (
        <select
          id={id}
          className="field mt-1"
          required={field.required}
          value={value}
          onChange={(event) => update(field.name, event.target.value)}
        >
          {!field.required && <option value="" />}
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }

    if (field.kind === "bool") {
      return (
        <input
          id={id}
          type="checkbox"
          className="mt-2 h-4 w-4 accent-accent"
          checked={value === "true"}
          onChange={(event) => update(field.name, event.target.checked ? "true" : "false")}
        />
      );
    }

    if (field.kind === "int" || field.kind === "float") {
      return (
        <input
          id={id}
          type="number"
          inputMode={field.kind === "int" ? "numeric" : "decimal"}
          step={field.kind === "int" ? 1 : "any"}
          min={field.min}
          max={field.max}
          className="field mt-1"
          placeholder={text.placeholder(action, field.name)}
          required={field.required}
          value={value}
          onChange={(event) => update(field.name, event.target.value)}
        />
      );
    }

    return (
      <input
        id={id}
        className="field mt-1"
        placeholder={text.placeholder(action, field.name)}
        required={field.required}
        value={value}
        onChange={(event) => update(field.name, event.target.value)}
      />
    );
  }

  if (actions.length === 0) return null;

  // `lg:min-h-0`: on a wide screen the column has a bounded height, so the
  // action list scrolls on its own instead of pushing the audit log out. On a
  // narrow screen the column is free-standing and the panel keeps its natural
  // height — there, the page scroll is the right one.
  return (
    <section className="flex flex-col rounded-lg border border-line bg-surface lg:min-h-0">
      <header className="shrink-0 border-b border-line px-4 py-2">
        <h2 className="text-sm font-medium">{t("title")}</h2>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {groups.map(([group, groupActions]) => (
          <div key={group}>
            <h3 className="mb-2 text-xs uppercase tracking-wide text-muted">
              {text.group(group, groupActions.find((action) => action.text?.group)?.text?.group)}
            </h3>
            <div className="flex flex-wrap gap-2">
              {groupActions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  title={text.hint(action)}
                  disabled={busy}
                  aria-expanded={action.fields.length > 0 ? openId === action.id : undefined}
                  onClick={() => select(action)}
                  className={`btn ${openId === action.id ? "border-accent text-accent" : ""} ${
                    action.risk === "dangerous" ? "hover:border-danger hover:text-danger" : ""
                  }`}
                >
                  {text.label(action)}
                  {action.fields.length > 0 ? "…" : ""}
                </button>
              ))}
            </div>

            {groupActions
              .filter((action) => action.id === openId)
              .map((action) => (
                <form
                  key={action.id}
                  className="mt-3 space-y-2 rounded border border-line bg-raised p-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submit(action);
                  }}
                >
                  {text.hint(action) && (
                    <p className="font-mono text-xs text-muted">{text.hint(action)}</p>
                  )}
                  {action.fields.map((field) => {
                    const id = `${fieldId}-${action.id}-${field.name}`;
                    const help = text.help(action, field.name);

                    return (
                      <div key={field.name}>
                        <label className="block text-xs text-muted" htmlFor={id}>
                          {text.fieldLabel(action, field.name)}
                          {field.required ? " *" : ""}
                        </label>
                        {control(action, field, id)}
                        {help && <p className="mt-1 text-xs text-muted">{help}</p>}
                      </div>
                    );
                  })}
                  {action.confirm && (
                    <p className="text-xs text-muted">{text.confirmation(action, values)}</p>
                  )}
                  <div className="flex gap-2">
                    <button type="submit" className="btn-primary" disabled={busy}>
                      {t("send")}
                    </button>
                    <button type="button" className="btn" onClick={() => setOpenId(null)}>
                      {t("cancel")}
                    </button>
                  </div>
                </form>
              ))}
          </div>
        ))}
      </div>
    </section>
  );
}
