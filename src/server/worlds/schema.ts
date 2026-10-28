import { z } from "zod";

/**
 * A world's settings as the panel accepts them: the world agent's own schema
 * (services/agents/internal/worlds/settings.go), checked here too so a
 * malformed request is refused before any call, with the member named. Every
 * object is strict: an unknown member is a typo the operator should see, not
 * a setting silently dropped.
 */

const factor = (max: number, min = 0) => z.number().finite().min(min).max(max);
const count = (min: number, max: number) => z.number().int().min(min).max(max);

const controlName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const expressionKey = /^[A-Za-z0-9_][A-Za-z0-9_:.-]{0,63}$/;
const expressionValue = /^[A-Za-z0-9_.:-]{0,64}$/;

const Control = z
  .object({ frequency: factor(6).optional(), size: factor(6).optional(), richness: factor(6).optional() })
  .strict();

export const MapGen = z
  .object({
    width: count(0, 2_000_000).optional(),
    height: count(0, 2_000_000).optional(),
    starting_area: factor(6).optional(),
    peaceful_mode: z.boolean().optional(),
    no_enemies_mode: z.boolean().optional(),
    autoplace_controls: z
      .record(z.string().regex(controlName), Control)
      .refine((value) => Object.keys(value).length <= 256)
      .optional(),
    cliff_settings: z
      .object({
        cliff_elevation_0: factor(1024).optional(),
        cliff_elevation_interval: factor(1024, 0.1).optional(),
        richness: factor(10).optional(),
        cliff_smoothing: factor(1).optional(),
      })
      .strict()
      .optional(),
    property_expression_names: z
      .record(z.string().regex(expressionKey), z.union([z.string().regex(expressionValue), z.number().finite()]))
      .refine((value) => Object.keys(value).length <= 32)
      .optional(),
  })
  .strict();

export const MapSettings = z
  .object({
    difficulty_settings: z
      .object({
        technology_price_multiplier: factor(1000, 0.001).optional(),
        spoil_time_modifier: factor(100, 0.01).optional(),
      })
      .strict()
      .optional(),
    pollution: z
      .object({
        enabled: z.boolean().optional(),
        diffusion_ratio: factor(0.25).optional(),
        min_to_diffuse: factor(1e6).optional(),
        ageing: factor(100, 0.01).optional(),
        enemy_attack_pollution_consumption_modifier: factor(100, 0.01).optional(),
        min_pollution_to_damage_trees: factor(1e6).optional(),
        pollution_restored_per_tree_damage: factor(1e6).optional(),
      })
      .strict()
      .optional(),
    enemy_evolution: z
      .object({
        enabled: z.boolean().optional(),
        time_factor: factor(0.01).optional(),
        destroy_factor: factor(1).optional(),
        pollution_factor: factor(0.01).optional(),
      })
      .strict()
      .optional(),
    enemy_expansion: z
      .object({
        enabled: z.boolean().optional(),
        max_expansion_distance: count(2, 20).optional(),
        settler_group_min_size: count(1, 100).optional(),
        settler_group_max_size: count(1, 100).optional(),
        min_expansion_cooldown: count(60, 5_184_000).optional(),
        max_expansion_cooldown: count(60, 5_184_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const WorldSettingsInput = z
  .object({
    mapGen: MapGen.optional(),
    mapSettings: MapSettings.optional(),
    exchangeString: z
      .string()
      .max(64 * 1024)
      .regex(/^>>>[A-Za-z0-9+/=\s]{16,}<<<$/)
      .optional(),
  })
  .strict()
  .refine((value) => !value.exchangeString || (!value.mapGen && !value.mapSettings), {
    message: "exchangeString excludes mapGen and mapSettings",
  });

/** A seed, as the game takes it. */
export const Seed = z.number().int().min(0).max(0xffff_ffff);

export const PREVIEW_SIZES = [256, 512, 1024, 2048] as const;
