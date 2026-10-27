package mods

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/portal"
)

// catalog is an in-memory portal: `name` → releases as "version:factorio:dep,dep".
type catalog map[string][]string

func (c catalog) Full(_ context.Context, name string) (portal.Mod, error) {
	specs, ok := c[name]
	if !ok {
		return portal.Mod{}, portal.ErrNotFound
	}
	mod := portal.Mod{Name: name}
	for _, spec := range specs {
		parts := strings.SplitN(spec, ":", 3)
		release := portal.Release{
			Version:     parts[0],
			FileName:    name + "_" + parts[0] + ".zip",
			DownloadURL: "/download/" + name + "/" + parts[0],
			SHA1:        "sha-" + name + parts[0],
		}
		release.InfoJSON.FactorioVersion = parts[1]
		if len(parts) == 3 {
			deps := []string{}
			if parts[2] != "" {
				deps = strings.Split(parts[2], ",")
			}
			release.InfoJSON.Dependencies = &deps
		}
		mod.Releases = append(mod.Releases, release)
	}
	return mod, nil
}

type unreachable struct{}

func (unreachable) Full(context.Context, string) (portal.Mod, error) {
	return portal.Mod{}, fmt.Errorf("%w: down", portal.ErrUnreachable)
}

var game = Version{2, 1, 23}

func installed(name, version string, enabled bool, deps ...string) Installed {
	parsed, err := ParseDependencies(deps)
	if err != nil {
		panic(err)
	}
	return Installed{
		Mod:          Mod{Name: name, Version: version, Enabled: enabled},
		Files:        []string{name + "_" + version + ".zip"},
		Listed:       true,
		Dependencies: parsed,
	}
}

func builtin(name string, enabled bool) Installed {
	return Installed{Mod: Mod{Name: name, Version: game.String(), Enabled: enabled, Builtin: true}, Listed: true}
}

// dlc is an expansion mod the image toggles from DLC_SPACE_AGE.
func dlc(name string, enabled bool) Installed {
	mod := builtin(name, enabled)
	mod.DLC = true
	return mod
}

// summary renders steps as "action name from→to [by]" for compact checks.
func summary(plan Plan) []string {
	var out []string
	for _, s := range plan.Steps {
		line := string(s.Action) + " " + s.Name
		if s.From != "" || s.To != "" {
			line += " " + s.From + "→" + s.To
		}
		if s.RequiredBy != "" {
			line += " [" + s.RequiredBy + "]"
		}
		out = append(out, line)
	}
	return out
}

func codes(plan Plan) []string {
	var out []string
	for _, c := range plan.Conflicts {
		out = append(out, c.Mod+":"+c.Code)
	}
	return out
}

func TestBuildPlan(t *testing.T) {
	base := builtin("base", true)
	portalMods := catalog{
		"a":       {"1.0.0:2.1:base >= 2.1.0,b >= 1.1.0,? opt"},
		"b":       {"1.0.0:2.1:", "1.1.0:2.1:c", "1.2.0:2.0:"},
		"c":       {"0.5.0:2.1:"},
		"new":     {"1.0.0:2.1:base >= 2.1.0", "2.0.0:2.1:base >= 2.1.30"},
		"old":     {"1.0.0:2.0:"},
		"hater":   {"1.0.0:2.1:! b"},
		"pinned":  {"1.0.0:2.1:", "1.1.0:2.1:", "1.2.0:2.1:"},
		"strict":  {"1.0.0:2.1:pinned = 1.1.0"},
		"needsSA": {"1.0.0:2.1:space-age"},
		"bare":    {"1.0.0:2.1"},
	}

	cases := []struct {
		name      string
		inventory []Installed
		changes   []Change
		steps     []string
		conflicts []string
	}{
		{
			name:      "dependencies come along, recursively",
			inventory: []Installed{base},
			changes:   []Change{{Action: ActionInstall, Name: "a"}},
			steps:     []string{"install a →1.0.0", "install b →1.1.0 [a]", "install c →0.5.0 [b]"},
		},
		{
			name:      "a disabled dependency is enabled, not downloaded",
			inventory: []Installed{base, installed("b", "1.1.0", false, "c"), installed("c", "0.5.0", true)},
			changes:   []Change{{Action: ActionInstall, Name: "a"}},
			steps:     []string{"install a →1.0.0", "enable b [a]"},
		},
		{
			name:      "a dependency too old is updated",
			inventory: []Installed{base, installed("b", "1.0.0", true), installed("c", "0.5.0", true)},
			changes:   []Change{{Action: ActionInstall, Name: "a"}},
			steps:     []string{"install a →1.0.0", "update b 1.0.0→1.1.0 [a]"},
		},
		{
			name:      "the newest release the game can run",
			inventory: []Installed{base},
			changes:   []Change{{Action: ActionInstall, Name: "new"}},
			steps:     []string{"install new →1.0.0"},
		},
		{
			name:      "no release for this game version",
			inventory: []Installed{base},
			changes:   []Change{{Action: ActionInstall, Name: "old"}},
			conflicts: []string{"old:no_release"},
		},
		{
			name:      "unknown mod",
			inventory: []Installed{base},
			changes:   []Change{{Action: ActionInstall, Name: "ghost"}},
			conflicts: []string{"ghost:not_found"},
		},
		{
			name:      "incompatible with an enabled mod",
			inventory: []Installed{base, installed("b", "1.0.0", true)},
			changes:   []Change{{Action: ActionInstall, Name: "hater"}},
			steps:     []string{"install hater →1.0.0"},
			conflicts: []string{"hater:incompatible"},
		},
		{
			name:      "disabling a mod another one needs",
			inventory: []Installed{base, installed("a", "1.0.0", true, "b"), installed("b", "1.1.0", true)},
			changes:   []Change{{Action: ActionDisable, Name: "b"}},
			steps:     []string{"disable b"},
			conflicts: []string{"a:missing"},
		},
		{
			name:      "removing it too",
			inventory: []Installed{base, installed("a", "1.0.0", true, "b"), installed("b", "1.1.0", true)},
			changes:   []Change{{Action: ActionRemove, Name: "b"}},
			steps:     []string{"remove b 1.1.0→"},
			conflicts: []string{"a:missing"},
		},
		{
			name:      "the game's own mods",
			inventory: []Installed{base, builtin("quality", true)},
			changes: []Change{
				{Action: ActionRemove, Name: "quality"},
				{Action: ActionDisable, Name: "base"},
				{Action: ActionUpdate, Name: "quality"},
			},
			conflicts: []string{"quality:builtin", "base:base"},
		},
		{
			name:      "an expansion can be disabled",
			inventory: []Installed{base, builtin("quality", true)},
			changes:   []Change{{Action: ActionDisable, Name: "quality"}},
			steps:     []string{"disable quality"},
		},
		{
			name:      "an expansion that is not there cannot be downloaded",
			inventory: []Installed{base},
			changes:   []Change{{Action: ActionInstall, Name: "needsSA"}},
			steps:     []string{"install needsSA →1.0.0"},
			conflicts: []string{"space-age:not_found", "needsSA:missing"},
		},
		{
			name:      "a disabled expansion a mod needs is enabled",
			inventory: []Installed{base, builtin("space-age", false)},
			changes:   []Change{{Action: ActionInstall, Name: "needsSA"}},
			steps:     []string{"install needsSA →1.0.0", "enable space-age [needsSA]"},
		},
		{
			name:      "the image's DLC mods follow DLC_SPACE_AGE, not the panel",
			inventory: []Installed{base, dlc("quality", true), dlc("space-age", false)},
			changes:   []Change{{Action: ActionDisable, Name: "quality"}, {Action: ActionEnable, Name: "space-age"}},
			conflicts: []string{"quality:dlc", "space-age:dlc"},
		},
		{
			name:      "a mod needing a DLC mod the image disables",
			inventory: []Installed{base, dlc("space-age", false)},
			changes:   []Change{{Action: ActionInstall, Name: "needsSA"}},
			steps:     []string{"install needsSA →1.0.0"},
			conflicts: []string{"space-age:dlc", "needsSA:missing"},
		},
		{
			name:      "a precise version",
			inventory: []Installed{base},
			changes:   []Change{{Action: ActionInstall, Name: "pinned", Version: "1.0.0"}},
			steps:     []string{"install pinned →1.0.0"},
		},
		{
			name:      "constraints from installed mods bound the choice",
			inventory: []Installed{base, installed("strict", "1.0.0", true, "pinned = 1.1.0"), installed("pinned", "1.0.0", true)},
			changes:   []Change{{Action: ActionUpdate, Name: "pinned"}},
			steps:     []string{"update pinned 1.0.0→1.1.0"},
		},
		{
			name: "folders are left to whoever put them there",
			inventory: []Installed{base, func() Installed {
				m := installed("b", "1.0.0", true)
				m.Unpacked, m.Files = true, nil
				return m
			}()},
			changes:   []Change{{Action: ActionUpdate, Name: "b"}, {Action: ActionRemove, Name: "b"}},
			conflicts: []string{"b:unpacked"},
		},
		{
			name:      "acting on an absent mod",
			inventory: []Installed{base},
			changes:   []Change{{Action: ActionEnable, Name: "x"}, {Action: ActionUpdate, Name: "y"}},
			conflicts: []string{"x:not_installed", "y:not_installed"},
		},
		{
			name:      "no dependencies field means base",
			inventory: []Installed{base},
			changes:   []Change{{Action: ActionInstall, Name: "bare"}},
			steps:     []string{"install bare →1.0.0"},
		},
		{
			name:      "nothing to do",
			inventory: []Installed{base, installed("b", "1.1.0", true, "c"), installed("c", "0.5.0", true)},
			changes:   []Change{{Action: ActionEnable, Name: "b"}},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			plan, err := BuildPlan(context.Background(), portalMods, c.inventory, c.changes, game)
			if err != nil {
				t.Fatal(err)
			}
			if got := summary(plan); !slices.Equal(got, c.steps) {
				t.Errorf("steps:\n got %q\nwant %q", got, c.steps)
			}
			got, want := codes(plan), slices.Clone(c.conflicts)
			slices.Sort(got)
			slices.Sort(want)
			if !slices.Equal(got, want) {
				t.Errorf("conflicts:\n got %q\nwant %q (%+v)", got, want, plan.Conflicts)
			}
		})
	}
}

func TestPlanDetails(t *testing.T) {
	portalMods := catalog{"a": {"1.0.0:2.1:? opt,b"}, "b": {"1.0.0:2.1:"}}
	inventory := []Installed{builtin("base", true), installed("old", "1.0.0", true, "b"), installed("b", "0.9.0", true)}
	plan, err := BuildPlan(context.Background(), portalMods, inventory, []Change{{Action: ActionInstall, Name: "a"}}, game)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Optional) != 1 || plan.Optional[0].Optional != "opt" {
		t.Errorf("optional: %+v", plan.Optional)
	}
	for _, step := range plan.Steps {
		if step.Name == "a" && (step.Download == nil || step.Download.FileName != "a_1.0.0.zip" || !step.Enabled) {
			t.Errorf("install step: %+v", step)
		}
	}

	again, _ := BuildPlan(context.Background(), portalMods, inventory, []Change{{Action: ActionInstall, Name: "a"}}, game)
	if again.Hash != plan.Hash || plan.Hash == "" {
		t.Error("the same basket gave two hashes")
	}
	portalMods["a"] = append(portalMods["a"], "1.0.1:2.1:")
	newer, _ := BuildPlan(context.Background(), portalMods, inventory, []Change{{Action: ActionInstall, Name: "a"}}, game)
	if newer.Hash == plan.Hash {
		t.Error("a new release did not change the hash")
	}
}

func TestPlanUnreachablePortal(t *testing.T) {
	inventory := []Installed{builtin("base", true), installed("b", "1.0.0", true)}
	if _, err := BuildPlan(context.Background(), unreachable{}, inventory, []Change{{Action: ActionInstall, Name: "a"}}, game); !errors.Is(err, portal.ErrUnreachable) {
		t.Fatalf("got %v", err)
	}
	// Enabling and disabling never needs the portal.
	plan, err := BuildPlan(context.Background(), unreachable{}, inventory, []Change{{Action: ActionDisable, Name: "b"}}, game)
	if err != nil || len(plan.Steps) != 1 {
		t.Fatalf("got %+v %v", plan, err)
	}
}
