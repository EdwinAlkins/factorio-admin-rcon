import type { WorldMapSettings, WorldSettings } from "@/lib/api-types";

/**
 * What the Worlds tab's form needs that is not React: the rules' fields and
 * how each is shown, and the reshaping of the settings sent to the server.
 * Shared by the components and their tests.
 */

/** A seed, drawn here so the operator sees it before the game uses it. */
export function randomSeed(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0]!;
}

/** "iron-ore", "tungsten_ore" → "Iron ore", "Tungsten ore": for a mod's names, which have no translation. */
export function prettyName(name: string): string {
  const words = name.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Drops what holds nothing — an emptied control, a rule group with every
 * field back to its default — so the request carries the operator's changes
 * only, and the game's defaults apply to the rest.
 */
export function compact<T>(value: T): T | undefined {
  if (Array.isArray(value) || value === null || typeof value !== "object") {
    return value === undefined ? undefined : value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const kept = compact(child);
    if (kept !== undefined) out[key] = kept;
  }
  return Object.keys(out).length > 0 ? (out as T) : undefined;
}

/** The settings as sent: the exchange string alone, or the form's changes. */
export function requestSettings(settings: WorldSettings, exchangeString: string): WorldSettings {
  const exchange = exchangeString.trim();
  if (exchange) return { exchangeString: exchange };
  return compact(settings) ?? {};
}

export type RuleGroup = keyof WorldMapSettings;

/**
 * One field of the rules (map-settings.json). Values are kept raw, as the
 * game stores them, and shown the way the game's dialog shows them: evolution
 * factors scaled to readable numbers, cooldowns in minutes, the diffusion
 * ratio in percent.
 */
export type RuleField = {
  group: RuleGroup;
  key: string;
  kind: "bool" | "number";
  /** Shown value = raw × scale. */
  scale?: number;
  /** Bounds and step of the shown value. */
  min?: number;
  max?: number;
  step?: number;
  /** The raw value is a whole number (ticks, group sizes). */
  integer?: boolean;
  /** Space Age only: hidden without it. */
  expansion?: boolean;
};

const TICKS_PER_MINUTE = 3600;

export const RULE_FIELDS: RuleField[] = [
  { group: "pollution", key: "enabled", kind: "bool" },
  { group: "pollution", key: "diffusion_ratio", kind: "number", scale: 100, min: 0, max: 25, step: 0.1 },
  { group: "pollution", key: "min_to_diffuse", kind: "number", min: 0, max: 1e6, step: 1 },
  { group: "pollution", key: "ageing", kind: "number", min: 0.01, max: 100, step: 0.1 },
  { group: "pollution", key: "enemy_attack_pollution_consumption_modifier", kind: "number", min: 0.01, max: 100, step: 0.1 },
  { group: "pollution", key: "min_pollution_to_damage_trees", kind: "number", min: 0, max: 1e6, step: 1 },
  { group: "pollution", key: "pollution_restored_per_tree_damage", kind: "number", min: 0, max: 1e6, step: 1 },
  { group: "enemy_evolution", key: "enabled", kind: "bool" },
  { group: "enemy_evolution", key: "time_factor", kind: "number", scale: 1e7, min: 0, max: 1e5, step: 1 },
  { group: "enemy_evolution", key: "destroy_factor", kind: "number", scale: 1e5, min: 0, max: 1e5, step: 1 },
  { group: "enemy_evolution", key: "pollution_factor", kind: "number", scale: 1e7, min: 0, max: 1e5, step: 1 },
  { group: "enemy_expansion", key: "enabled", kind: "bool" },
  { group: "enemy_expansion", key: "max_expansion_distance", kind: "number", min: 2, max: 20, step: 1, integer: true },
  { group: "enemy_expansion", key: "settler_group_min_size", kind: "number", min: 1, max: 100, step: 1, integer: true },
  { group: "enemy_expansion", key: "settler_group_max_size", kind: "number", min: 1, max: 100, step: 1, integer: true },
  {
    group: "enemy_expansion",
    key: "min_expansion_cooldown",
    kind: "number",
    scale: 1 / TICKS_PER_MINUTE,
    min: 1,
    max: 1440,
    step: 1,
    integer: true,
  },
  {
    group: "enemy_expansion",
    key: "max_expansion_cooldown",
    kind: "number",
    scale: 1 / TICKS_PER_MINUTE,
    min: 1,
    max: 1440,
    step: 1,
    integer: true,
  },
  { group: "difficulty_settings", key: "technology_price_multiplier", kind: "number", min: 0.001, max: 1000, step: 0.1 },
  { group: "difficulty_settings", key: "spoil_time_modifier", kind: "number", min: 0.01, max: 100, step: 0.1, expansion: true },
];

/** A raw value as the form shows it, rounded to what a person reads. */
export function shownValue(field: RuleField, raw: number): number {
  return Number((raw * (field.scale ?? 1)).toPrecision(6));
}

/** A shown value back to raw; NaN when the input is not a number. */
export function rawValue(field: RuleField, shown: number): number {
  const raw = shown / (field.scale ?? 1);
  return field.integer ? Math.round(raw) : Number(raw.toPrecision(12));
}

/** A control's multiplier (1 = 100 %) as the percent the game's dialog shows. */
export function percent(value: number): number {
  return Math.round(value * 100);
}
