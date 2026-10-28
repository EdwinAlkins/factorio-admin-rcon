"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useDynamicTranslations } from "@/hooks/useDynamicTranslations";
import { useErrorMessage } from "@/hooks/useErrorMessage";
import type { PreviewInput, WorldsOutcome } from "@/hooks/useWorlds";
import {
  percent,
  prettyName,
  randomSeed,
  rawValue,
  requestSettings,
  RULE_FIELDS,
  shownValue,
  type RuleField,
  type RuleGroup,
} from "@/lib/worlds";
import type {
  WorldCatalogDto,
  WorldControlDto,
  WorldControlValue,
  WorldDto,
  WorldMapGen,
  WorldMapSettings,
  WorldPreviewDto,
  WorldSettings,
} from "@/lib/api-types";

type Props = {
  catalog: WorldCatalogDto;
  /** A world of the library to start from ("reuse these settings"). */
  initial?: { name: string; seed: number; settings: WorldSettings };
  /** An operation runs, or a call is pending: creating waits. */
  busy: boolean;
  preview: (input: PreviewInput) => Promise<WorldsOutcome<WorldPreviewDto>>;
  create: (input: { name: string; settings: WorldSettings; seed?: number }) => Promise<WorldsOutcome<WorldDto>>;
};

const SIZES = [512, 1024, 2048] as const;
const MAX_SEED = 0xffff_ffff;
/** Seeds shown side by side by "compare". */
const COMPARED = 4;

/** Factorio's climate sliders, as noise expression overrides (Nauvis). */
const CLIMATE = [
  { key: "control:moisture:frequency", kind: "scale" },
  { key: "control:moisture:bias", kind: "bias" },
  { key: "control:aux:frequency", kind: "scale" },
  { key: "control:aux:bias", kind: "bias" },
] as const;

type ControlField = keyof WorldControlValue;

function parseSeed(text: string): number | null | undefined {
  if (text.trim() === "") return undefined;
  if (!/^\d+$/.test(text.trim())) return null;
  const seed = Number(text.trim());
  return seed <= MAX_SEED ? seed : null;
}

function withMapGen<K extends keyof WorldMapGen>(settings: WorldSettings, key: K, value: WorldMapGen[K] | undefined): WorldSettings {
  const mapGen = { ...settings.mapGen };
  if (value === undefined) delete mapGen[key];
  else mapGen[key] = value;
  return { ...settings, mapGen };
}

function withControl(settings: WorldSettings, name: string, field: ControlField, value: number | undefined): WorldSettings {
  const controls = { ...settings.mapGen?.autoplace_controls };
  const control = { ...controls[name] };
  if (value === undefined) delete control[field];
  else control[field] = value;
  controls[name] = control;
  return withMapGen(settings, "autoplace_controls", controls);
}

function withExpression(settings: WorldSettings, key: string, value: string | undefined): WorldSettings {
  const expressions = { ...settings.mapGen?.property_expression_names };
  if (value === undefined) delete expressions[key];
  else expressions[key] = value;
  return withMapGen(settings, "property_expression_names", expressions);
}

/** A rule's value in a set of map settings: the form's own, or the game's defaults. */
function ruleOf(source: WorldMapSettings | undefined, group: RuleGroup, key: string) {
  return (source?.[group] as Record<string, number | boolean | undefined> | undefined)?.[key];
}

function withRule(settings: WorldSettings, group: RuleGroup, key: string, value: number | boolean | undefined): WorldSettings {
  const mapSettings = { ...settings.mapSettings };
  const fields = { ...(mapSettings[group] as Record<string, number | boolean | undefined> | undefined) };
  if (value === undefined) delete fields[key];
  else fields[key] = value;
  return { ...settings, mapSettings: { ...mapSettings, [group]: fields } };
}

/** A section of the form, folded by default like the game's own tabs. */
function Section({ title, open, children }: { title: string; open?: boolean; children: ReactNode }) {
  return (
    // A named group: the creator itself sits in an open <details>, which a
    // plain `group-open:` would match too.
    <details className="group/section rounded border border-line" open={open}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium select-none [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="text-muted transition-transform group-open/section:rotate-90">
          ▸
        </span>
        {title}
      </summary>
      <div className="flex flex-col gap-2 border-t border-line px-3 py-3 text-xs">{children}</div>
    </details>
  );
}

function Changed({ on }: { on: boolean }) {
  return on ? <span className="text-accent"> •</span> : null;
}

/**
 * The world creation form: the game's map generator — presets, every
 * resource, terrain and enemy control per planet, the rules (pollution,
 * evolution, expansion, difficulty) — with a preview beside it. Or a map
 * exchange string, pasted as it is. Values left alone keep the game's.
 */
export default function WorldCreator({ catalog, initial, busy, preview, create }: Props) {
  const t = useTranslations("worlds");
  const td = useDynamicTranslations("worlds");
  const errorMessage = useErrorMessage();

  const [settings, setSettings] = useState<WorldSettings>(() =>
    initial?.settings.exchangeString ? {} : (initial?.settings ?? {}),
  );
  const [exchange, setExchange] = useState(initial?.settings.exchangeString ?? "");
  const [seedText, setSeedText] = useState(initial ? String(initial.seed) : "");
  const [name, setName] = useState(initial ? `${initial.name} (2)`.slice(0, 60) : "");
  const [preset, setPreset] = useState("");
  const [planet, setPlanet] = useState(catalog.planets[0]?.name ?? "nauvis");
  const [size, setSize] = useState<number>(1024);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [shown, setShown] = useState<WorldPreviewDto | null>(null);
  const [compared, setCompared] = useState<WorldPreviewDto[]>([]);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [json, setJson] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);

  const label = (kind: "controls" | "planets" | "resources", key: string) =>
    td.has(`${kind}.${key}`) ? td(`${kind}.${key}`) : prettyName(key);

  const exchangeMode = exchange.trim() !== "";
  const seed = parseSeed(seedText);
  const current = catalog.planets.find((candidate) => candidate.name === planet) ?? catalog.planets[0];
  const controls = new Map(catalog.controls.map((control) => [control.name, control]));
  const planetControls = (current?.controls ?? [])
    .map((key) => controls.get(key))
    .filter((control): control is WorldControlDto => control !== undefined);
  const byCategory = (...categories: string[]) => planetControls.filter((control) => categories.includes(control.category));
  // Any planet beyond Nauvis means Space Age (or a mod adding planets).
  const expansion = catalog.planets.length > 1;

  const edit = (next: WorldSettings) => {
    setSettings(next);
    setPreset("");
    setNotice(null);
  };

  const applyPreset = (key: string) => {
    setPreset(key);
    const chosen = catalog.presets.find((candidate) => candidate.name === key);
    setSettings(structuredClone(chosen?.settings ?? {}));
    setNotice(null);
  };

  /** Renders a preview of the form as it stands; `input` overrides the seed, size or place. */
  const render = async (input: Partial<PreviewInput>) => {
    setError(null);
    setRendering(true);
    try {
      const outcome = await preview({
        settings: requestSettings(settings, exchange),
        size,
        planet,
        offset,
        ...input,
      });
      if (outcome.kind === "done") return outcome.data;
      if (outcome.kind === "failed" || outcome.kind === "needs_force") setError(errorMessage(outcome.failure));
      return null;
    } finally {
      setRendering(false);
    }
  };

  const showPreview = async (at = offset, newSeed?: number) => {
    if (seed === null) return setError(t("seedInvalid"));
    const result = await render({ seed: newSeed ?? seed, offset: at });
    if (!result) return;
    setShown(result);
    setCompared([]);
    // The seed the game used is kept: the next preview shows the same map.
    setSeedText(String(result.seed));
  };

  const pan = (dx: number, dy: number) => {
    // The image is 1 tile per pixel: half its width moves half a screen.
    const step = size / 2;
    const next = dx === 0 && dy === 0 ? { x: 0, y: 0 } : { x: offset.x + dx * step, y: offset.y + dy * step };
    setOffset(next);
    void showPreview(next);
  };

  const compare = async () => {
    const results: WorldPreviewDto[] = [];
    setCompared([]);
    for (let i = 0; i < COMPARED; i++) {
      const result = await render({ seed: randomSeed(), size: 512, offset: { x: 0, y: 0 } });
      if (!result) return;
      results.push(result);
      setCompared([...results]);
    }
  };

  const pick = (chosen: WorldPreviewDto) => {
    setSeedText(String(chosen.seed));
    setShown(chosen);
    setOffset({ x: 0, y: 0 });
    setCompared([]);
  };

  const submit = async () => {
    if (seed === null) return setError(t("seedInvalid"));
    setError(null);
    setNotice(null);
    const outcome = await create({ name: name.trim(), settings: requestSettings(settings, exchange), seed });
    if (outcome.kind === "done") {
      setNotice(t("created", { name: outcome.data.name, seed: outcome.data.seed }));
      setSeedText(String(outcome.data.seed));
    } else if (outcome.kind === "failed" || outcome.kind === "needs_force") {
      setError(errorMessage(outcome.failure));
    }
  };

  const loadJson = () => {
    setJson(JSON.stringify(requestSettings(settings, ""), null, 2));
    setJsonError(null);
  };

  const applyJson = () => {
    try {
      const parsed = JSON.parse(json) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      const { mapGen, mapSettings, ...rest } = parsed as WorldSettings & Record<string, unknown>;
      if (Object.keys(rest).length > 0) throw new Error();
      edit({ mapGen, mapSettings });
      setJsonError(null);
    } catch {
      setJsonError(t("advanced.invalid"));
    }
  };

  const controlRows = (list: WorldControlDto[]) =>
    list.length === 0 ? (
      <p className="text-muted">{t("none")}</p>
    ) : (
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead className="text-muted">
            <tr>
              <th className="py-1 pr-2 font-normal" />
              <th className="py-1 pr-2 font-normal">{t("frequency")} %</th>
              <th className="py-1 pr-2 font-normal">{t("size")} %</th>
              <th className="py-1 pr-2 font-normal">{t("richness")} %</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((control) => {
              const value = settings.mapGen?.autoplace_controls?.[control.name] ?? {};
              const fields: ControlField[] = control.richness ? ["frequency", "size", "richness"] : ["frequency", "size"];
              const touched = Object.keys(value).length > 0;
              return (
                <tr key={control.name} className="border-t border-line">
                  <td className="py-1 pr-2">
                    {label("controls", control.name)}
                    <Changed on={touched} />
                  </td>
                  {(["frequency", "size", "richness"] as const).map((field) => (
                    <td key={field} className="py-1 pr-2">
                      {fields.includes(field) && (
                        <input
                          type="number"
                          className="field w-20! px-2! py-0.5 text-xs"
                          aria-label={`${label("controls", control.name)} — ${t(field)}`}
                          // Size 0 removes it from the map: some features cannot be.
                          min={field === "size" && control.canBeDisabled ? 0 : 1}
                          max={600}
                          step={1}
                          value={percent(value[field] ?? 1)}
                          onChange={(event) => {
                            const next = event.target.valueAsNumber;
                            edit(withControl(settings, control.name, field, Number.isNaN(next) ? undefined : next / 100));
                          }}
                        />
                      )}
                    </td>
                  ))}
                  <td className="py-1 text-right">
                    {touched && (
                      <button
                        type="button"
                        className="btn px-1.5 py-0.5 text-xs"
                        title={t("reset")}
                        aria-label={`${t("reset")} — ${label("controls", control.name)}`}
                        onClick={() => {
                          const next = { ...settings.mapGen?.autoplace_controls };
                          delete next[control.name];
                          edit(withMapGen(settings, "autoplace_controls", next));
                        }}
                      >
                        ↺
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );

  const ruleInput = (field: RuleField) => {
    const own = ruleOf(settings.mapSettings, field.group, field.key);
    const value = own ?? ruleOf(catalog.mapSettings, field.group, field.key);
    const id = `rule-${field.group}-${field.key}`;
    return (
      <div key={id} className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <label htmlFor={id}>
          {td(`rules.${field.group}.${field.key}`)}
          <Changed on={own !== undefined} />
        </label>
        <span className="flex items-center gap-2">
          {field.kind === "bool" ? (
            <input
              id={id}
              type="checkbox"
              checked={value === true}
              onChange={(event) => edit(withRule(settings, field.group, field.key, event.target.checked))}
            />
          ) : (
            <input
              id={id}
              type="number"
              className="field w-32! py-1 text-xs"
              min={field.min}
              max={field.max}
              step={field.step}
              value={typeof value === "number" ? shownValue(field, value) : ""}
              onChange={(event) => {
                const next = event.target.valueAsNumber;
                edit(withRule(settings, field.group, field.key, Number.isNaN(next) ? undefined : rawValue(field, next)));
              }}
            />
          )}
          {td.has(`rules.units.${field.group}.${field.key}`) && (
            <span className="text-muted">{td(`rules.units.${field.group}.${field.key}`)}</span>
          )}
          {own !== undefined && (
            <button
              type="button"
              className="btn px-1.5 py-0.5 text-xs"
              title={t("reset")}
              onClick={() => edit(withRule(settings, field.group, field.key, undefined))}
            >
              ↺
            </button>
          )}
        </span>
      </div>
    );
  };

  const rules = (group: RuleGroup) =>
    RULE_FIELDS.filter((field) => field.group === group && (!field.expansion || expansion)).map(ruleInput);

  const mapGenNumber = (key: "width" | "height" | "starting_area", scale: number, max: number) => {
    const own = settings.mapGen?.[key];
    const id = `mapgen-${key}`;
    return (
      <div className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <label htmlFor={id}>
          {t(`mapGen.${key}`)}
          <Changed on={own !== undefined} />
        </label>
        <input
          id={id}
          type="number"
          className="field w-32! py-1 text-xs"
          min={0}
          max={max}
          step={1}
          value={Math.round((own ?? (key === "starting_area" ? 1 : 0)) * scale)}
          onChange={(event) => {
            const next = event.target.valueAsNumber;
            edit(withMapGen(settings, key, Number.isNaN(next) ? undefined : next / scale));
          }}
        />
      </div>
    );
  };

  const mapGenFlag = (key: "peaceful_mode" | "no_enemies_mode") => (
    <label className="flex items-center gap-2">
      <input
        type="checkbox"
        checked={settings.mapGen?.[key] === true}
        onChange={(event) => edit(withMapGen(settings, key, event.target.checked || undefined))}
      />
      {t(`mapGen.${key}`)}
    </label>
  );

  const climate = CLIMATE.map(({ key, kind }) => {
    const own = settings.mapGen?.property_expression_names?.[key];
    const raw = Number(own ?? (kind === "scale" ? 1 : 0));
    // The game's dialog shows the inverse of the frequency as a scale, and
    // the bias in percent.
    const shownClimate = kind === "scale" ? Math.round(100 / (raw || 1)) : Math.round(raw * 100);
    const id = `climate-${key}`;
    return (
      <div key={key} className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <label htmlFor={id}>
          {td(`climate.${key.replace(/:/g, "_")}`)}
          <Changed on={own !== undefined} />
        </label>
        <span className="flex items-center gap-1">
          <input
            id={id}
            type="number"
            className="field w-24! px-2! py-1 text-xs"
            min={kind === "scale" ? 17 : -50}
            max={kind === "scale" ? 600 : 50}
            step={1}
            value={shownClimate}
            onChange={(event) => {
              const next = event.target.valueAsNumber;
              if (Number.isNaN(next)) return edit(withExpression(settings, key, undefined));
              const value = kind === "scale" ? 100 / Math.max(next, 1) : next / 100;
              edit(withExpression(settings, key, String(Number(value.toPrecision(6)))));
            }}
          />
          %
        </span>
      </div>
    );
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
      <div className="flex min-w-0 flex-col gap-2">
        <Section title={t("sections.general")} open>
          <div className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <label htmlFor="world-seed">{t("seed")}</label>
            <span className="flex flex-wrap items-center gap-2">
              <input
                id="world-seed"
                inputMode="numeric"
                className="field w-40! py-1 font-mono text-xs"
                placeholder={t("seedRandom")}
                value={seedText}
                onChange={(event) => setSeedText(event.target.value)}
              />
              <button
                type="button"
                className="btn px-2 py-0.5 text-xs"
                disabled={rendering}
                onClick={() => {
                  const next = randomSeed();
                  setSeedText(String(next));
                  setOffset({ x: 0, y: 0 });
                  void showPreview({ x: 0, y: 0 }, next);
                }}
              >
                🎲 {t("newSeed")}
              </button>
            </span>
          </div>
          <fieldset disabled={exchangeMode} className="flex min-w-0 flex-col gap-2 disabled:opacity-50">
            <div className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <label htmlFor="world-preset">{t("preset")}</label>
              <select
                id="world-preset"
                className="field w-56! py-1 text-xs"
                value={preset}
                onChange={(event) => applyPreset(event.target.value)}
              >
                <option value="">{t("presetCustom")}</option>
                {catalog.presets.map((candidate) => (
                  <option key={candidate.name} value={candidate.name}>
                    {td.has(`presets.${candidate.name}`) ? td(`presets.${candidate.name}`) : prettyName(candidate.name)}
                  </option>
                ))}
              </select>
            </div>
            {mapGenNumber("width", 1, 2_000_000)}
            {mapGenNumber("height", 1, 2_000_000)}
            <p className="text-muted">{t("mapGen.sizeHint")}</p>
          </fieldset>
        </Section>

        <fieldset disabled={exchangeMode} className="flex min-w-0 flex-col gap-2 disabled:opacity-50">
          <Section title={t("sections.resources")}>
            {catalog.planets.length > 1 && (
              <div className="flex flex-wrap gap-1" role="group" aria-label={t("planet")}>
                {catalog.planets.map((candidate) => (
                  <button
                    key={candidate.name}
                    type="button"
                    aria-pressed={planet === candidate.name}
                    className={`btn px-2 py-0.5 text-xs ${planet === candidate.name ? "border-accent text-accent" : ""}`}
                    onClick={() => setPlanet(candidate.name)}
                  >
                    {label("planets", candidate.name)}
                  </button>
                ))}
              </div>
            )}
            <p className="text-muted">{t("resourcesHint")}</p>
            {controlRows(byCategory("resource"))}
          </Section>

          <Section title={t("sections.terrain")}>
            {controlRows(byCategory("terrain", "cliff"))}
            {current?.climateControls && climate}
          </Section>

          <Section title={t("sections.enemies")}>
            {controlRows(byCategory("enemy"))}
            {mapGenNumber("starting_area", 100, 600)}
            {mapGenFlag("peaceful_mode")}
            {mapGenFlag("no_enemies_mode")}
          </Section>

          <Section title={t("sections.pollution")}>{rules("pollution")}</Section>
          <Section title={t("sections.evolution")}>{rules("enemy_evolution")}</Section>
          <Section title={t("sections.expansion")}>{rules("enemy_expansion")}</Section>
          <Section title={t("sections.difficulty")}>
            {rules("difficulty_settings")}
            <p className="text-muted">{t("rulesHint")}</p>
          </Section>

          <Section title={t("sections.advanced")}>
            <p className="text-muted">{t("advanced.hint")}</p>
            <textarea
              className="field min-h-48 w-full py-1 font-mono text-xs"
              spellCheck={false}
              aria-label={t("sections.advanced")}
              value={json}
              onChange={(event) => setJson(event.target.value)}
            />
            <span className="flex flex-wrap gap-2">
              <button type="button" className="btn text-xs" onClick={loadJson}>
                {t("advanced.load")}
              </button>
              <button type="button" className="btn text-xs" onClick={applyJson}>
                {t("advanced.apply")}
              </button>
            </span>
            {jsonError && (
              <p role="alert" className="text-danger">
                {jsonError}
              </p>
            )}
          </Section>
        </fieldset>

        <Section title={t("sections.exchange")} open={exchangeMode}>
          <p className="text-muted">{t("exchange.hint")}</p>
          <textarea
            className="field min-h-24 w-full py-1 font-mono text-xs"
            spellCheck={false}
            placeholder=">>>eNp…<<<"
            aria-label={t("sections.exchange")}
            value={exchange}
            onChange={(event) => setExchange(event.target.value)}
          />
          {exchangeMode && <p className="text-accent">{t("exchange.active")}</p>}
        </Section>

        <form
          className="flex flex-wrap items-center gap-2 pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <input
            className="field w-64! py-1 text-xs"
            required
            maxLength={60}
            placeholder={t("namePlaceholder")}
            aria-label={t("name")}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" className="btn-primary text-xs" disabled={busy || rendering || name.trim() === ""}>
            {t("create")}
          </button>
          <span className="text-muted">{t("createHint")}</span>
        </form>
        {notice && (
          <p role="status" className="text-xs text-ok">
            {notice}
          </p>
        )}
      </div>

      <aside className="flex min-w-0 flex-col gap-2 text-xs lg:sticky lg:top-0 lg:self-start">
        <div className="flex flex-wrap items-center gap-2">
          {catalog.planets.length > 1 && (
            <select
              className="field w-32! py-1 text-xs"
              aria-label={t("planet")}
              value={planet}
              onChange={(event) => setPlanet(event.target.value)}
            >
              {catalog.planets.map((candidate) => (
                <option key={candidate.name} value={candidate.name}>
                  {label("planets", candidate.name)}
                </option>
              ))}
            </select>
          )}
          <select
            className="field w-32! py-1 text-xs"
            aria-label={t("area")}
            value={size}
            onChange={(event) => setSize(Number(event.target.value))}
          >
            {SIZES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {t("areaTiles", { size: candidate })}
              </option>
            ))}
          </select>
          <button type="button" className="btn-primary text-xs" disabled={rendering} onClick={() => void showPreview()}>
            {rendering ? t("rendering") : t("previewButton")}
          </button>
          <button type="button" className="btn text-xs" disabled={rendering} onClick={() => void compare()}>
            {t("compare", { count: COMPARED })}
          </button>
        </div>

        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}

        {compared.length > 0 && (
          <div>
            <p className="pb-1 text-muted">{t("compareHint")}</p>
            <div className="grid grid-cols-2 gap-2">
              {compared.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  className="rounded border border-line p-1 text-left hover:border-accent"
                  onClick={() => pick(candidate)}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- streamed from the agent, never optimised */}
                  <img
                    src={`/api/worlds/previews/${candidate.id}`}
                    alt={t("previewAlt", { seed: candidate.seed })}
                    className="aspect-square w-full [image-rendering:pixelated]"
                  />
                  <span className="font-mono">{candidate.seed}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {shown ? (
          <figure className="flex flex-col gap-2">
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element -- streamed from the agent, never optimised */}
              <img
                src={`/api/worlds/previews/${shown.id}`}
                alt={t("previewAlt", { seed: shown.seed })}
                className={`aspect-square w-full rounded border border-line [image-rendering:pixelated] ${rendering ? "opacity-50" : ""}`}
              />
            </div>
            <div className="grid w-28 grid-cols-3 gap-1 self-center" role="group" aria-label={t("pan")}>
              <span />
              <button type="button" className="btn px-1 py-0.5" aria-label={t("panNorth")} disabled={rendering} onClick={() => pan(0, -1)}>
                ↑
              </button>
              <span />
              <button type="button" className="btn px-1 py-0.5" aria-label={t("panWest")} disabled={rendering} onClick={() => pan(-1, 0)}>
                ←
              </button>
              <button type="button" className="btn px-1 py-0.5" aria-label={t("panCentre")} disabled={rendering} onClick={() => pan(0, 0)}>
                ⌂
              </button>
              <button type="button" className="btn px-1 py-0.5" aria-label={t("panEast")} disabled={rendering} onClick={() => pan(1, 0)}>
                →
              </button>
              <span />
              <button type="button" className="btn px-1 py-0.5" aria-label={t("panSouth")} disabled={rendering} onClick={() => pan(0, 1)}>
                ↓
              </button>
              <span />
            </div>
            <figcaption className="text-muted">
              {t("previewCaption", {
                seed: shown.seed,
                planet: label("planets", shown.planet),
                size: shown.size,
                x: offset.x,
                y: offset.y,
              })}
            </figcaption>
            {shown.quantities.length > 0 && (
              <table className="w-full text-left">
                <thead className="text-muted">
                  <tr>
                    <th className="py-1 pr-2 font-normal">{t("quantities.resource")}</th>
                    <th className="py-1 pr-2 text-right font-normal">{t("quantities.tiles")}</th>
                    <th className="py-1 text-right font-normal">{t("quantities.amount")}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.quantities.map((quantity) => (
                    <tr key={quantity.name} className="border-t border-line">
                      <td className="py-1 pr-2">{label("resources", quantity.name)}</td>
                      <td className="py-1 pr-2 text-right font-mono">{quantity.count.toLocaleString()}</td>
                      <td className="py-1 text-right font-mono">
                        {Intl.NumberFormat(undefined, { notation: "compact" }).format(quantity.richness)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="text-muted">{t("previewHint")}</p>
          </figure>
        ) : (
          compared.length === 0 && <p className="text-muted">{t("previewEmpty")}</p>
        )}
      </aside>
    </div>
  );
}
