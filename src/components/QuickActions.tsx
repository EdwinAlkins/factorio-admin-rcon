"use client";

import { useId, useMemo, useState } from "react";
import type { ActionDto } from "@/lib/api-types";

type Props = {
  actions: ActionDto[];
  busy: boolean;
  onRun: (action: ActionDto, values: Record<string, string>) => void;
};

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? `<${key}>`);
}

export default function QuickActions({ actions, busy, onRun }: Props) {
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
    setValues({});
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

  if (actions.length === 0) return null;

  return (
    <section className="rounded-lg border border-line bg-surface">
      <header className="border-b border-line px-4 py-2">
        <h2 className="text-sm font-medium">Actions rapides</h2>
      </header>

      <div className="space-y-4 p-4">
        {groups.map(([group, groupActions]) => (
          <div key={group}>
            <h3 className="mb-2 text-xs uppercase tracking-wide text-muted">{group}</h3>
            <div className="flex flex-wrap gap-2">
              {groupActions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  title={action.hint}
                  disabled={busy}
                  aria-expanded={action.fields.length > 0 ? openId === action.id : undefined}
                  onClick={() => select(action)}
                  className={`btn ${openId === action.id ? "border-accent text-accent" : ""} ${
                    action.risk === "dangerous" ? "hover:border-danger hover:text-danger" : ""
                  }`}
                >
                  {action.label}
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
                  <p className="font-mono text-xs text-muted">{action.hint}</p>
                  {action.fields.map((field) => (
                    <div key={field.name}>
                      <label
                        className="block text-xs text-muted"
                        htmlFor={`${fieldId}-${action.id}-${field.name}`}
                      >
                        {field.label}
                        {field.required ? " *" : ""}
                      </label>
                      <input
                        id={`${fieldId}-${action.id}-${field.name}`}
                        className="field mt-1"
                        placeholder={field.placeholder}
                        required={field.required}
                        value={values[field.name] ?? ""}
                        onChange={(event) =>
                          setValues((current) => ({
                            ...current,
                            [field.name]: event.target.value,
                          }))
                        }
                      />
                    </div>
                  ))}
                  {action.confirmation && (
                    <p className="text-xs text-muted">{fillTemplate(action.confirmation, values)}</p>
                  )}
                  <div className="flex gap-2">
                    <button type="submit" className="btn-primary" disabled={busy}>
                      Envoyer
                    </button>
                    <button type="button" className="btn" onClick={() => setOpenId(null)}>
                      Annuler
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
