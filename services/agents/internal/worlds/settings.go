package worlds

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
)

// Settings describes a world to generate: the terrain (map-gen-settings.json)
// and the rules it runs under (map-settings.json), or a map exchange string
// copied from the game's own dialog.
//
// Every member is optional and mirrors Factorio's own name, so the panel's
// advanced editor shows what the game's documentation describes. A member
// left out keeps the game's default. Nothing here is passed to Factorio
// as-is: the agent writes these structures back out after validating them, so
// an unknown member never reaches the game.
type Settings struct {
	MapGen      *MapGen      `json:"mapGen,omitzero"`
	MapSettings *MapSettings `json:"mapSettings,omitzero"`
	// `>>>…<<<`, from the game's "Map exchange string" dialog. Exclusive:
	// it carries its own terrain and rules, which a map-settings.json would
	// replace whole.
	ExchangeString string `json:"exchangeString,omitzero"`
}

// MapGen is the subset of map-gen-settings.json the panel edits.
type MapGen struct {
	// In tiles; 0 is infinite.
	Width  *int64 `json:"width,omitzero"`
	Height *int64 `json:"height,omitzero"`
	// Multiplier of the enemy-free zone around the spawn.
	StartingArea  *float64 `json:"starting_area,omitzero"`
	PeacefulMode  *bool    `json:"peaceful_mode,omitzero"`
	NoEnemiesMode *bool    `json:"no_enemies_mode,omitzero"`
	// Keyed by autoplace control (`iron-ore`, `tungsten_ore`, `water`…), for
	// every planet at once: the names do not collide across planets.
	AutoplaceControls map[string]Control `json:"autoplace_controls,omitzero"`
	CliffSettings     *CliffSettings     `json:"cliff_settings,omitzero"`
	// Noise expression overrides: moisture and terrain type
	// (`control:moisture:bias`…), and the island or lakes elevation of the
	// game's presets. Strings or numbers.
	PropertyExpressionNames map[string]any `json:"property_expression_names,omitzero"`
}

// Control is one line of the game's map generator: how often, how large, how rich.
type Control struct {
	Frequency *float64 `json:"frequency,omitzero"`
	Size      *float64 `json:"size,omitzero"`
	Richness  *float64 `json:"richness,omitzero"`
}

type CliffSettings struct {
	CliffElevation0        *float64 `json:"cliff_elevation_0,omitzero"`
	CliffElevationInterval *float64 `json:"cliff_elevation_interval,omitzero"`
	// "Continuity" in the game's dialog; 0 removes cliffs.
	Richness       *float64 `json:"richness,omitzero"`
	CliffSmoothing *float64 `json:"cliff_smoothing,omitzero"`
}

// MapSettings is the subset of map-settings.json the panel edits: what the
// game's "Advanced settings" tab shows. The rest keeps the game's values.
type MapSettings struct {
	DifficultySettings *DifficultySettings `json:"difficulty_settings,omitzero"`
	Pollution          *Pollution          `json:"pollution,omitzero"`
	EnemyEvolution     *EnemyEvolution     `json:"enemy_evolution,omitzero"`
	EnemyExpansion     *EnemyExpansion     `json:"enemy_expansion,omitzero"`
}

type DifficultySettings struct {
	TechnologyPriceMultiplier *float64 `json:"technology_price_multiplier,omitzero"`
	// Space Age; ignored by a game without spoilage.
	SpoilTimeModifier *float64 `json:"spoil_time_modifier,omitzero"`
}

type Pollution struct {
	Enabled                                 *bool    `json:"enabled,omitzero"`
	DiffusionRatio                          *float64 `json:"diffusion_ratio,omitzero"`
	MinToDiffuse                            *float64 `json:"min_to_diffuse,omitzero"`
	Ageing                                  *float64 `json:"ageing,omitzero"`
	EnemyAttackPollutionConsumptionModifier *float64 `json:"enemy_attack_pollution_consumption_modifier,omitzero"`
	MinPollutionToDamageTrees               *float64 `json:"min_pollution_to_damage_trees,omitzero"`
	PollutionRestoredPerTreeDamage          *float64 `json:"pollution_restored_per_tree_damage,omitzero"`
}

type EnemyEvolution struct {
	Enabled         *bool    `json:"enabled,omitzero"`
	TimeFactor      *float64 `json:"time_factor,omitzero"`
	DestroyFactor   *float64 `json:"destroy_factor,omitzero"`
	PollutionFactor *float64 `json:"pollution_factor,omitzero"`
}

type EnemyExpansion struct {
	Enabled              *bool  `json:"enabled,omitzero"`
	MaxExpansionDistance *int64 `json:"max_expansion_distance,omitzero"`
	SettlerGroupMinSize  *int64 `json:"settler_group_min_size,omitzero"`
	SettlerGroupMaxSize  *int64 `json:"settler_group_max_size,omitzero"`
	// In ticks (60 per second).
	MinExpansionCooldown *int64 `json:"min_expansion_cooldown,omitzero"`
	MaxExpansionCooldown *int64 `json:"max_expansion_cooldown,omitzero"`
}

// ErrInvalidSettings wraps every refusal of Validate; the message names the member.
var ErrInvalidSettings = errors.New("invalid world settings")

var (
	// Prototype names: what Factorio itself accepts, minus anything that
	// could read as a path or an option.
	controlName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	// Noise expression names and the `control:moisture:bias` family.
	expressionKey   = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_:.-]{0,63}$`)
	expressionValue = regexp.MustCompile(`^[A-Za-z0-9_.:-]{0,64}$`)
	exchangeString  = regexp.MustCompile(`^>>>[A-Za-z0-9+/=\s]{16,}<<<$`)
)

const (
	maxControls    = 256
	maxExpressions = 32
	// The game's strings are a few KB; this bounds what reaches its command line.
	maxExchangeString = 64 << 10
	// The game's own bound on a map's side.
	maxMapSide = 2_000_000
)

// Validate checks every member against the ranges the game's dialog allows,
// or wider where the dialog is narrower than what the file accepts.
func (s Settings) Validate() error {
	var errs []error
	fail := func(format string, args ...any) { errs = append(errs, fmt.Errorf(format, args...)) }

	if s.ExchangeString != "" {
		if len(s.ExchangeString) > maxExchangeString || !exchangeString.MatchString(s.ExchangeString) {
			fail("exchangeString: not a map exchange string (>>>…<<<)")
		}
		if s.MapGen != nil || s.MapSettings != nil {
			fail("exchangeString: excludes mapGen and mapSettings")
		}
	}
	if g := s.MapGen; g != nil {
		intRange(fail, "width", g.Width, 0, maxMapSide)
		intRange(fail, "height", g.Height, 0, maxMapSide)
		floatRange(fail, "starting_area", g.StartingArea, 0, 6)
		if len(g.AutoplaceControls) > maxControls {
			fail("autoplace_controls: at most %d", maxControls)
		}
		for name, control := range g.AutoplaceControls {
			if !controlName.MatchString(name) {
				fail("autoplace_controls: invalid name %q", name)
				continue
			}
			floatRange(fail, name+".frequency", control.Frequency, 0, 6)
			floatRange(fail, name+".size", control.Size, 0, 6)
			floatRange(fail, name+".richness", control.Richness, 0, 6)
		}
		if c := g.CliffSettings; c != nil {
			floatRange(fail, "cliff_elevation_0", c.CliffElevation0, 0, 1024)
			floatRange(fail, "cliff_elevation_interval", c.CliffElevationInterval, 0.1, 1024)
			floatRange(fail, "cliff_settings.richness", c.Richness, 0, 10)
			floatRange(fail, "cliff_smoothing", c.CliffSmoothing, 0, 1)
		}
		if len(g.PropertyExpressionNames) > maxExpressions {
			fail("property_expression_names: at most %d", maxExpressions)
		}
		for key, value := range g.PropertyExpressionNames {
			if !expressionKey.MatchString(key) {
				fail("property_expression_names: invalid name %q", key)
				continue
			}
			switch v := value.(type) {
			case string:
				if !expressionValue.MatchString(v) {
					fail("property_expression_names.%s: invalid value", key)
				}
			case float64:
				if math.IsNaN(v) || math.IsInf(v, 0) || math.Abs(v) > 1e6 {
					fail("property_expression_names.%s: out of range", key)
				}
			default:
				fail("property_expression_names.%s: must be a string or a number", key)
			}
		}
	}
	if m := s.MapSettings; m != nil {
		if d := m.DifficultySettings; d != nil {
			floatRange(fail, "technology_price_multiplier", d.TechnologyPriceMultiplier, 0.001, 1000)
			floatRange(fail, "spoil_time_modifier", d.SpoilTimeModifier, 0.01, 100)
		}
		if p := m.Pollution; p != nil {
			floatRange(fail, "diffusion_ratio", p.DiffusionRatio, 0, 0.25)
			floatRange(fail, "min_to_diffuse", p.MinToDiffuse, 0, 1e6)
			floatRange(fail, "ageing", p.Ageing, 0.01, 100)
			floatRange(fail, "enemy_attack_pollution_consumption_modifier", p.EnemyAttackPollutionConsumptionModifier, 0.01, 100)
			floatRange(fail, "min_pollution_to_damage_trees", p.MinPollutionToDamageTrees, 0, 1e6)
			floatRange(fail, "pollution_restored_per_tree_damage", p.PollutionRestoredPerTreeDamage, 0, 1e6)
		}
		if e := m.EnemyEvolution; e != nil {
			floatRange(fail, "time_factor", e.TimeFactor, 0, 0.01)
			floatRange(fail, "destroy_factor", e.DestroyFactor, 0, 1)
			floatRange(fail, "pollution_factor", e.PollutionFactor, 0, 0.01)
		}
		if e := m.EnemyExpansion; e != nil {
			intRange(fail, "max_expansion_distance", e.MaxExpansionDistance, 2, 20)
			intRange(fail, "settler_group_min_size", e.SettlerGroupMinSize, 1, 100)
			intRange(fail, "settler_group_max_size", e.SettlerGroupMaxSize, 1, 100)
			// One second to a day of game time.
			intRange(fail, "min_expansion_cooldown", e.MinExpansionCooldown, 60, 5_184_000)
			intRange(fail, "max_expansion_cooldown", e.MaxExpansionCooldown, 60, 5_184_000)
			if e.SettlerGroupMinSize != nil && e.SettlerGroupMaxSize != nil && *e.SettlerGroupMinSize > *e.SettlerGroupMaxSize {
				fail("settler_group_min_size: above settler_group_max_size")
			}
			if e.MinExpansionCooldown != nil && e.MaxExpansionCooldown != nil && *e.MinExpansionCooldown > *e.MaxExpansionCooldown {
				fail("min_expansion_cooldown: above max_expansion_cooldown")
			}
		}
	}
	if err := errors.Join(errs...); err != nil {
		return fmt.Errorf("%w: %w", ErrInvalidSettings, err)
	}
	return nil
}

func floatRange(fail func(string, ...any), name string, value *float64, low, high float64) {
	if value == nil {
		return
	}
	if math.IsNaN(*value) || *value < low || *value > high {
		fail("%s: must be between %g and %g", name, low, high)
	}
}

func intRange(fail func(string, ...any), name string, value *int64, low, high int64) {
	if value != nil && (*value < low || *value > high) {
		fail("%s: must be between %d and %d", name, low, high)
	}
}

// ValidName accepts a world's display name: printable, 1 to 60 characters.
func ValidName(name string) bool {
	if name == "" || len([]rune(name)) > 60 || strings.TrimSpace(name) != name {
		return false
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}
