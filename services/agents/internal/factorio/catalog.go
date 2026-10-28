package factorio

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/worlds"
)

// Catalog is what the panel's world form is built from, read from the game
// itself (`--dump-data`) with the server's mods: a mod adding an ore adds a
// line, a game without Space Age shows Nauvis alone.
type Catalog struct {
	FactorioVersion string    `json:"factorioVersion"`
	Planets         []Planet  `json:"planets"`
	Controls        []Control `json:"controls"`
	Presets         []Preset  `json:"presets"`
	// The game's own map settings: what a field left alone keeps.
	MapSettings worlds.MapSettings `json:"mapSettings"`
}

type Planet struct {
	Name string `json:"name"`
	// Autoplace controls that act on this planet, in the game's order.
	Controls []string `json:"controls"`
	// Resource entities placed on it, for the preview's quantity report.
	Resources []string `json:"resources"`
	// Moisture and terrain-type sliders (Nauvis).
	ClimateControls bool `json:"climateControls"`
}

type Control struct {
	Name string `json:"name"`
	// resource, terrain, cliff or enemy.
	Category string `json:"category"`
	Order    string `json:"order"`
	// Whether the richness slider means anything for it.
	Richness bool `json:"richness"`
	// False for the enemy bases and a few planet features: size 0 is refused.
	CanBeDisabled bool `json:"canBeDisabled"`
}

// Preset is one of the game's map presets, its named values ("very-good")
// already turned into numbers.
type Preset struct {
	Name     string          `json:"name"`
	Order    string          `json:"order"`
	Default  bool            `json:"default"`
	Settings worlds.Settings `json:"settings"`
}

// The game's named slider values, as its map generator dialog maps them.
var namedValues = map[string]float64{
	"none":     0,
	"very-low": 0.5, "very-small": 0.5, "very-poor": 0.5,
	"low": 1 / math.Sqrt2, "small": 1 / math.Sqrt2, "poor": 1 / math.Sqrt2,
	"normal": 1, "medium": 1, "regular": 1,
	"high": math.Sqrt2, "big": math.Sqrt2, "good": math.Sqrt2,
	"very-high": 2, "very-big": 2, "very-good": 2,
}

// The dump is data.raw as the game serialises it: duplicate keys and odd
// bytes are its business, not reasons to refuse it.
var lenient = []json.Options{jsontext.AllowDuplicateNames(true), jsontext.AllowInvalidUTF8(true)}

type dump struct {
	AutoplaceControl jsontext.Value `json:"autoplace-control"`
	Planet           jsontext.Value `json:"planet"`
	Resource         jsontext.Value `json:"resource"`
	MapGenPresets    jsontext.Value `json:"map-gen-presets"`
}

type dumpControl struct {
	Category      string `json:"category"`
	Order         string `json:"order"`
	Richness      bool   `json:"richness"`
	CanBeDisabled *bool  `json:"can_be_disabled"`
}

type dumpPlanet struct {
	Order          string `json:"order"`
	MapGenSettings struct {
		AutoplaceControls      jsontext.Value `json:"autoplace_controls"`
		MoistureClimateControl bool           `json:"moisture_climate_control"`
		AuxClimateControl      bool           `json:"aux_climate_control"`
		AutoplaceSettings      struct {
			Entity struct {
				Settings jsontext.Value `json:"settings"`
			} `json:"entity"`
		} `json:"autoplace_settings"`
	} `json:"map_gen_settings"`
}

type dumpPreset struct {
	Order    string         `json:"order"`
	Default  bool           `json:"default"`
	Basic    jsontext.Value `json:"basic_settings"`
	Advanced jsontext.Value `json:"advanced_settings"`
}

// Catalog returns the catalogue for the current mod set, dumping the game's
// data again only when the mods changed since the last call.
func (r *Runner) Catalog(ctx context.Context) (Catalog, error) {
	stamp, err := r.modStamp()
	if err != nil {
		return Catalog{}, err
	}
	r.cacheMu.Lock()
	cached, cachedStamp := r.catalog, r.stamp
	r.cacheMu.Unlock()
	if cached != nil && cachedStamp == stamp {
		return *cached, nil
	}

	release, err := r.acquire()
	if err != nil {
		return Catalog{}, err
	}
	defer release()

	args, err := r.modArgs()
	if err != nil {
		return Catalog{}, err
	}
	if _, err := r.exec(ctx, append(args, "--dump-data")...); err != nil {
		return Catalog{}, err
	}
	path := filepath.Join(r.options.WorkDir, writeData, "script-output", "data-raw-dump.json")
	raw, err := os.ReadFile(path) //nolint:gosec // G304: the game's write-data, in the agent's own work folder
	if err != nil {
		return Catalog{}, &Error{Message: "no data dump was written"}
	}
	// Some 30 MB on a tmpfs: not kept once read.
	_ = os.RemoveAll(filepath.Join(r.options.WorkDir, writeData, "script-output"))

	catalog, err := parseCatalog(raw)
	if err != nil {
		return Catalog{}, err
	}
	catalog.FactorioVersion = r.version
	catalog.MapSettings = r.defaults
	r.cacheMu.Lock()
	r.catalog, r.stamp = &catalog, stamp
	r.cacheMu.Unlock()
	return catalog, nil
}

// modStamp fingerprints the mods folder: names, sizes, times, and the
// contents of mod-list.json, which enabling a mod changes alone.
func (r *Runner) modStamp() (string, error) {
	hash := sha256.New()
	if r.options.ModsDir != "" {
		entries, err := os.ReadDir(r.options.ModsDir)
		if err != nil && !os.IsNotExist(err) {
			return "", err
		}
		for _, entry := range entries {
			info, err := entry.Info()
			if err != nil {
				continue
			}
			fmt.Fprintf(hash, "%s %d %d\n", entry.Name(), info.Size(), info.ModTime().UnixNano())
		}
		if list, err := os.ReadFile(filepath.Join(r.options.ModsDir, "mod-list.json")); err == nil {
			hash.Write(list)
		}
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func parseCatalog(raw []byte) (Catalog, error) {
	var data dump
	if err := json.Unmarshal(raw, &data, lenient...); err != nil {
		return Catalog{}, fmt.Errorf("data dump: %w", err)
	}
	catalog := Catalog{Planets: []Planet{}, Controls: []Control{}, Presets: []Preset{}}

	controls, err := object[dumpControl](data.AutoplaceControl)
	if err != nil {
		return Catalog{}, fmt.Errorf("autoplace controls: %w", err)
	}
	for name, control := range controls {
		catalog.Controls = append(catalog.Controls, Control{
			Name:          name,
			Category:      control.Category,
			Order:         control.Order,
			Richness:      control.Richness,
			CanBeDisabled: control.CanBeDisabled == nil || *control.CanBeDisabled,
		})
	}
	sort.Slice(catalog.Controls, func(i, j int) bool {
		a, b := catalog.Controls[i], catalog.Controls[j]
		if a.Order != b.Order {
			return a.Order < b.Order
		}
		return a.Name < b.Name
	})
	order := map[string]int{}
	for i, control := range catalog.Controls {
		order[control.Name] = i
	}

	resources, err := object[jsontext.Value](data.Resource)
	if err != nil {
		return Catalog{}, fmt.Errorf("resources: %w", err)
	}
	planets, err := object[dumpPlanet](data.Planet)
	if err != nil {
		return Catalog{}, fmt.Errorf("planets: %w", err)
	}
	orders := map[string]string{}
	for name, planet := range planets {
		settings := planet.MapGenSettings
		entry := Planet{
			Name:            name,
			Controls:        keys(settings.AutoplaceControls),
			Resources:       []string{},
			ClimateControls: settings.MoistureClimateControl || settings.AuxClimateControl,
		}
		sort.Slice(entry.Controls, func(i, j int) bool { return order[entry.Controls[i]] < order[entry.Controls[j]] })
		for _, entity := range keys(settings.AutoplaceSettings.Entity.Settings) {
			if _, ok := resources[entity]; ok {
				entry.Resources = append(entry.Resources, entity)
			}
		}
		sort.Strings(entry.Resources)
		catalog.Planets = append(catalog.Planets, entry)
		orders[name] = planet.Order
	}
	sort.Slice(catalog.Planets, func(i, j int) bool {
		a, b := catalog.Planets[i].Name, catalog.Planets[j].Name
		if orders[a] != orders[b] {
			return orders[a] < orders[b]
		}
		return a < b
	})

	groups, err := object[jsontext.Value](data.MapGenPresets)
	if err != nil {
		return Catalog{}, fmt.Errorf("presets: %w", err)
	}
	for _, group := range groups {
		presets, err := object[jsontext.Value](group)
		if err != nil {
			continue
		}
		for name, value := range presets {
			if value.Kind() != '{' {
				// `type` and `name`, the prototype's own members.
				continue
			}
			if preset, ok := parsePreset(name, value); ok {
				catalog.Presets = append(catalog.Presets, preset)
			}
		}
	}
	sort.Slice(catalog.Presets, func(i, j int) bool { return catalog.Presets[i].Order < catalog.Presets[j].Order })
	return catalog, nil
}

// parsePreset turns one of the game's presets into Settings. A preset this
// agent cannot express — a mod's, with members out of the form's ranges —
// is left out rather than offered half-applied.
func parsePreset(name string, value jsontext.Value) (Preset, bool) {
	var raw dumpPreset
	if err := json.Unmarshal(value, &raw, lenient...); err != nil {
		return Preset{}, false
	}
	preset := Preset{Name: name, Order: raw.Order, Default: raw.Default}

	if basic := tree(raw.Basic); basic != nil {
		if controls, ok := basic["autoplace_controls"].(map[string]any); ok {
			for _, control := range controls {
				if fields, ok := control.(map[string]any); ok {
					for key, v := range fields {
						fields[key] = named(v)
					}
				}
			}
		}
		if v, ok := basic["starting_area"]; ok {
			basic["starting_area"] = named(v)
		}
		var mapGen worlds.MapGen
		if !retype(basic, &mapGen) {
			return Preset{}, false
		}
		if !emptyMapGen(mapGen) {
			preset.Settings.MapGen = &mapGen
		}
	}
	if advanced := tree(raw.Advanced); advanced != nil {
		var mapSettings worlds.MapSettings
		if !retype(advanced, &mapSettings) {
			return Preset{}, false
		}
		if mapSettings != (worlds.MapSettings{}) {
			preset.Settings.MapSettings = &mapSettings
		}
	}
	if preset.Settings.Validate() != nil {
		return Preset{}, false
	}
	return preset, true
}

func emptyMapGen(g worlds.MapGen) bool {
	return g.Width == nil && g.Height == nil && g.StartingArea == nil && g.PeacefulMode == nil &&
		g.NoEnemiesMode == nil && len(g.AutoplaceControls) == 0 && g.CliffSettings == nil &&
		len(g.PropertyExpressionNames) == 0
}

// named turns "very-good" into 2; numbers and unknown names pass through.
func named(v any) any {
	if s, ok := v.(string); ok {
		if n, ok := namedValues[s]; ok {
			return n
		}
	}
	return v
}

// tree decodes a small table of the dump for reshaping, dropping the empty
// tables Lua serialises as `[]` where an object is expected.
func tree(value jsontext.Value) map[string]any {
	if value.Kind() != '{' {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal(value, &m, lenient...); err != nil {
		return nil
	}
	return prune(m).(map[string]any)
}

func prune(v any) any {
	switch t := v.(type) {
	case map[string]any:
		for key, child := range t {
			if list, ok := child.([]any); ok && len(list) == 0 {
				delete(t, key)
				continue
			}
			t[key] = prune(child)
		}
	}
	return v
}

// retype re-reads a reshaped tree into a typed structure, ignoring the
// members it does not know: a preset's settings the form does not edit.
func retype(m map[string]any, into any) bool {
	raw, err := json.Marshal(m)
	return err == nil && json.Unmarshal(raw, into) == nil
}

// object decodes a table of the dump keyed by name; an empty Lua table comes
// out as `[]`, an empty object here.
func object[T any](value jsontext.Value) (map[string]T, error) {
	m := map[string]T{}
	if value.Kind() != '{' {
		return m, nil
	}
	err := json.Unmarshal(value, &m, lenient...)
	return m, err
}

func keys(value jsontext.Value) []string {
	m, err := object[jsontext.Value](value)
	if err != nil {
		return []string{}
	}
	list := make([]string, 0, len(m))
	for key := range m {
		list = append(list, key)
	}
	return list
}
