package mods

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/files"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/portal"
)

// Action is what a change does to one mod.
type Action string

const (
	ActionInstall Action = "install"
	ActionUpdate  Action = "update"
	ActionEnable  Action = "enable"
	ActionDisable Action = "disable"
	ActionRemove  Action = "remove"
)

// Change is one line of the operator's basket.
type Change struct {
	Action Action `json:"action"`
	Name   string `json:"name"`
	// install/update only: a precise release. Empty: the newest one that fits.
	Version string `json:"version,omitzero"`
}

// MaxChanges bounds a basket: each install may cost a portal call.
const MaxChanges = 50

// Download is what Stage fetches for an install or update.
type Download struct {
	FileName string `json:"fileName"`
	URL      string `json:"url"`
	SHA1     string `json:"sha1"`
}

// Step is one change the plan makes on disk.
type Step struct {
	Action Action `json:"action"`
	Name   string `json:"name"`
	From   string `json:"from,omitzero"`
	To     string `json:"to,omitzero"`
	// Empty when the operator asked for it; otherwise the mod that needs it.
	RequiredBy string `json:"requiredBy,omitzero"`
	// install/update: whether the mod ends up enabled.
	Enabled  bool      `json:"enabled,omitzero"`
	Download *Download `json:"download,omitzero"`
	// Archives moved aside: the old version on update, all of them on remove.
	Replaces []string `json:"replaces,omitzero"`
}

// Conflict codes, translated by the panel.
const (
	ConflictNotFound      = "not_found"     // no such mod on the portal
	ConflictNotInstalled  = "not_installed" // enable/disable/update/remove of an absent mod
	ConflictNoRelease     = "no_release"    // no release fits the game and the constraints
	ConflictIncompatible  = "incompatible"  // a `!` dependency is enabled
	ConflictMissing       = "missing"       // a required dependency is disabled or absent
	ConflictVersion       = "version"       // a dependency's version does not fit
	ConflictBuiltin       = "builtin"       // part of the game: cannot be removed or replaced
	ConflictUnpacked      = "unpacked"      // a folder put there by hand: left alone
	ConflictBase          = "base"          // `base` cannot be disabled
	ConflictDLC           = "dlc"           // set by the image's DLC_SPACE_AGE at every start
	ConflictUnresolvable  = "unresolvable"  // the resolution did not settle
	ConflictUnknownAction = "unknown_action"
)

// Conflict blocks a plan: nothing is applied while there is one.
type Conflict struct {
	Mod    string `json:"mod"`
	Code   string `json:"code"`
	Detail string `json:"detail"`
}

// Hint is an optional dependency left as it is.
type Hint struct {
	Mod      string `json:"mod"`
	Optional string `json:"optional"`
}

// Plan is what a basket would do, computed without writing anything.
type Plan struct {
	FactorioVersion string     `json:"factorioVersion"`
	Steps           []Step     `json:"steps"`
	Conflicts       []Conflict `json:"conflicts"`
	Optional        []Hint     `json:"optional"`
	// Mods whose info.json could not be read: their needs are not checked.
	Unchecked []string `json:"unchecked"`
	// Identifies Steps: Stage refuses a plan that changed since the operator
	// confirmed it (a new release published in between, say).
	Hash string `json:"hash"`
}

// Catalog is the part of the portal the planner reads.
type Catalog interface {
	Full(ctx context.Context, name string) (portal.Mod, error)
}

// ErrConflict wraps a plan's conflicts when Stage is asked to apply it.
var ErrConflict = errors.New("the plan has conflicts")

// ConflictError lists them.
type ConflictError struct{ Conflicts []Conflict }

func (e *ConflictError) Error() string {
	parts := make([]string, len(e.Conflicts))
	for i, c := range e.Conflicts {
		parts[i] = c.Mod + ": " + c.Code
	}
	return "conflicts: " + strings.Join(parts, ", ")
}

func (e *ConflictError) Is(target error) bool { return target == ErrConflict }

type target struct {
	name     string
	builtin  bool
	unpacked bool
	dlc      bool
	files    []string

	present bool
	enabled bool
	version string
	// nil: unknown.
	deps []Dependency
	// Set when the plan downloads a release.
	release    *portal.Release
	requiredBy string

	wasPresent bool
	wasEnabled bool
	wasVersion string
}

func (t *target) parsedVersion() (Version, bool) {
	v, err := ParseVersion(t.version)
	return v, err == nil
}

type planner struct {
	ctx     context.Context
	catalog Catalog
	game    Version
	mods    map[string]*target

	conflicts []Conflict
	optional  []Hint
	queue     []string
}

// maxRounds bounds the resolution loop: each round settles one mod, and a
// basket touches a few dozen at most.
const maxRounds = 2000

// BuildPlan works out what `changes` need on top of the inventory: which
// releases to download, which dependencies come along, what conflicts. It
// reads the portal, never the disk, and never writes.
//
// The resolution is greedy and explicit — the newest release that fits, then
// its dependencies, recursively — and refuses rather than guesses: a
// dependency that cannot be satisfied is a conflict for the operator to
// settle, never a silent downgrade of something else.
func BuildPlan(ctx context.Context, catalog Catalog, inventory []Installed, changes []Change, game Version) (Plan, error) {
	p := &planner{ctx: ctx, catalog: catalog, game: game, mods: map[string]*target{}}
	for _, mod := range inventory {
		p.mods[mod.Name] = &target{
			name: mod.Name, builtin: mod.Builtin, unpacked: mod.Unpacked, dlc: mod.DLC, files: mod.Files,
			present: true, enabled: mod.Enabled, version: mod.Version, deps: mod.Dependencies,
			wasPresent: true, wasEnabled: mod.Enabled, wasVersion: mod.Version,
		}
	}

	for _, change := range changes {
		if err := p.apply(change); err != nil {
			return Plan{}, err
		}
	}
	if err := p.resolve(); err != nil {
		return Plan{}, err
	}
	p.check()
	return p.result(), nil
}

func (p *planner) conflict(mod, code, format string, args ...any) {
	// One per mod and kind: two refused changes on the same mod are one
	// thing for the operator to settle.
	if slices.ContainsFunc(p.conflicts, func(c Conflict) bool { return c.Mod == mod && c.Code == code }) {
		return
	}
	p.conflicts = append(p.conflicts, Conflict{Mod: mod, Code: code, Detail: fmt.Sprintf(format, args...)})
}

func (p *planner) enqueue(name string) { p.queue = append(p.queue, name) }

func (p *planner) apply(change Change) error {
	t := p.mods[change.Name]
	installed := t != nil && t.present

	switch change.Action {
	case ActionEnable, ActionDisable:
		switch {
		case !installed:
			p.conflict(change.Name, ConflictNotInstalled, "not installed")
		case t.dlc:
			p.conflict(t.name, ConflictDLC, "set by DLC_SPACE_AGE in docker-compose.yml at every start")
		case change.Action == ActionEnable:
			t.enabled = true
			p.enqueue(t.name)
		case t.name == "base":
			p.conflict(t.name, ConflictBase, "the base game cannot be disabled")
		default:
			t.enabled = false
		}

	case ActionRemove:
		switch {
		case !installed:
			p.conflict(change.Name, ConflictNotInstalled, "not installed")
		case t.builtin:
			p.conflict(t.name, ConflictBuiltin, "part of the game: disable it instead")
		case t.unpacked:
			p.conflict(t.name, ConflictUnpacked, "installed as a folder: remove it by hand")
		default:
			t.present, t.enabled = false, false
		}

	case ActionInstall, ActionUpdate:
		if change.Action == ActionUpdate && !installed {
			p.conflict(change.Name, ConflictNotInstalled, "not installed")
			return nil
		}
		if installed && t.builtin {
			p.conflict(t.name, ConflictBuiltin, "part of the game: updated with it")
			return nil
		}
		if installed && t.unpacked {
			p.conflict(t.name, ConflictUnpacked, "installed as a folder: update it by hand")
			return nil
		}
		return p.fetch(change.Name, change.Version, "")

	default:
		p.conflict(change.Name, ConflictUnknownAction, "unknown action %q", change.Action)
	}
	return nil
}

// fetch makes `name` present and enabled at the newest release that fits
// (or `wanted`), and queues its dependencies. Portal failures abort the
// whole plan: an unreachable portal is not a conflict the operator can fix.
func (p *planner) fetch(name, wanted, requiredBy string) error {
	release, err := p.pick(name, wanted)
	if err != nil {
		return err
	}
	if release == nil {
		return nil
	}

	t := p.mods[name]
	if t == nil {
		t = &target{name: name}
		p.mods[name] = t
	}
	declared := []string{"base"}
	if release.InfoJSON.Dependencies != nil {
		declared = *release.InfoJSON.Dependencies
	}
	deps, err := ParseDependencies(declared)
	if err != nil {
		p.conflict(name, ConflictNoRelease, "release %s: %v", release.Version, err)
		return nil
	}

	t.present, t.enabled = true, true
	t.deps = deps
	if t.wasPresent && t.version == release.Version {
		// Already the right version on disk: nothing to download.
		t.release = nil
	} else {
		t.version = release.Version
		t.release = release
	}
	if t.requiredBy == "" {
		t.requiredBy = requiredBy
	}
	p.enqueue(name)
	return nil
}

// pick returns the release to install, or nil after recording a conflict.
func (p *planner) pick(name, wanted string) (*portal.Release, error) {
	if !portal.ValidName(name) {
		p.conflict(name, ConflictNotFound, "not a mod name")
		return nil, nil
	}
	mod, err := p.catalog.Full(p.ctx, name)
	if errors.Is(err, portal.ErrNotFound) {
		p.conflict(name, ConflictNotFound, "no such mod on the portal")
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	constraints := p.constraintsOn(name)
	var best *portal.Release
	var bestVersion Version
	for i := range mod.Releases {
		release := &mod.Releases[i]
		v, err := ParseVersion(release.Version)
		if err != nil || release.InfoJSON.FactorioVersion != p.game.MajorMinor() {
			continue
		}
		// The name the archive is written under: it must be the one Factorio
		// expects, and a plain file name.
		if release.FileName != name+"_"+release.Version+".zip" || !files.ValidZipName(release.FileName) {
			continue
		}
		if wanted != "" && release.Version != wanted {
			continue
		}
		if !acceptsAll(constraints, v) || !p.fitsGame(release) {
			continue
		}
		if best == nil || v.Compare(bestVersion) > 0 {
			best, bestVersion = release, v
		}
	}
	if best == nil {
		detail := "no release for Factorio " + p.game.MajorMinor()
		if wanted != "" {
			detail += " at version " + wanted
		}
		for _, c := range constraints {
			detail += ", " + c.String()
		}
		p.conflict(name, ConflictNoRelease, "%s", detail)
		return nil, nil
	}
	return best, nil
}

// fitsGame checks a release's own `base` constraint against the game.
func (p *planner) fitsGame(release *portal.Release) bool {
	if release.InfoJSON.Dependencies == nil {
		return true
	}
	for _, raw := range *release.InfoJSON.Dependencies {
		d, err := ParseDependency(raw)
		if err == nil && d.Name == "base" && d.Requires() && !d.Accepts(p.game) {
			return false
		}
	}
	return true
}

// constraintsOn gathers what enabled mods ask of `name`'s version.
func (p *planner) constraintsOn(name string) []Dependency {
	var list []Dependency
	for _, t := range p.mods {
		if !t.enabled {
			continue
		}
		for _, d := range t.deps {
			if d.Name == name && d.Op != "" && d.Kind != Incompatible {
				list = append(list, d)
			}
		}
	}
	return list
}

func acceptsAll(constraints []Dependency, v Version) bool {
	for _, c := range constraints {
		if !c.Accepts(v) {
			return false
		}
	}
	return true
}

// resolve settles the queue: every enabled mod whose state changed gets its
// required dependencies enabled, installed or updated.
func (p *planner) resolve() error {
	for round := 0; len(p.queue) > 0; round++ {
		if round > maxRounds {
			p.conflict("", ConflictUnresolvable, "the dependencies did not settle")
			return nil
		}
		name := p.queue[0]
		p.queue = p.queue[1:]
		t := p.mods[name]
		if t == nil || !t.enabled {
			continue
		}
		for _, d := range t.deps {
			if err := p.satisfy(t, d); err != nil {
				return err
			}
		}
	}
	return nil
}

func (p *planner) satisfy(owner *target, d Dependency) error {
	if d.Name == "base" {
		return nil // checked against the game in check()
	}
	dep := p.mods[d.Name]
	present := dep != nil && dep.present

	switch d.Kind {
	case Incompatible, Optional, Hidden:
		return nil // checked in check(): never acted upon

	default: // Required, Unordered
		if !present {
			return p.fetch(d.Name, "", owner.name)
		}
		if !dep.enabled && dep.dlc {
			// The image would disable it again at the next start.
			p.conflict(dep.name, ConflictDLC, "needed by %s, but disabled by DLC_SPACE_AGE", owner.name)
			return nil
		}
		if !dep.enabled {
			dep.enabled = true
			if dep.requiredBy == "" {
				dep.requiredBy = owner.name
			}
			p.enqueue(dep.name)
		}
		v, ok := dep.parsedVersion()
		if d.Op == "" || (ok && d.Accepts(v)) || dep.builtin || dep.unpacked {
			return nil // a builtin or unpacked mismatch is reported by check()
		}
		// Too old (or too new) for owner: move to a release that fits
		// everyone, if there is one.
		return p.fetch(d.Name, "", owner.name)
	}
}

// check verifies the end state as a whole, whatever was asked: every enabled
// mod has its required dependencies at a fitting version, and none of its
// incompatibilities. This is what catches disabling or removing a mod that
// another one still needs.
func (p *planner) check() {
	names := make([]string, 0, len(p.mods))
	for name := range p.mods {
		names = append(names, name)
	}
	sort.Strings(names)

	for _, name := range names {
		t := p.mods[name]
		if !t.enabled {
			continue
		}
		for _, d := range t.deps {
			if d.Name == "base" {
				if d.Requires() && !d.Accepts(p.game) {
					p.conflict(name, ConflictVersion, "needs base %s, the game is %s", d.Constraint(), p.game)
				}
				continue
			}
			dep := p.mods[d.Name]
			enabled := dep != nil && dep.enabled
			switch {
			case d.Kind == Incompatible:
				if enabled {
					p.conflict(name, ConflictIncompatible, "incompatible with %s", d.Name)
				}
			case d.Requires() && !enabled:
				p.conflict(name, ConflictMissing, "needs %s", d)
			case enabled && d.Op != "":
				if v, ok := dep.parsedVersion(); ok && !d.Accepts(v) {
					p.conflict(name, ConflictVersion, "needs %s, %s is %s", d, d.Name, dep.version)
				}
			case d.Kind == Optional && !enabled:
				p.optional = append(p.optional, Hint{Mod: name, Optional: d.String()})
			}
		}
	}
}

func (p *planner) result() Plan {
	plan := Plan{
		FactorioVersion: p.game.String(),
		Steps:           []Step{},
		Conflicts:       p.conflicts,
		Optional:        p.optional,
		Unchecked:       []string{},
	}
	if plan.Conflicts == nil {
		plan.Conflicts = []Conflict{}
	}
	if plan.Optional == nil {
		plan.Optional = []Hint{}
	}

	names := make([]string, 0, len(p.mods))
	for name := range p.mods {
		names = append(names, name)
	}
	sort.Strings(names)

	for _, name := range names {
		t := p.mods[name]
		if t.enabled && t.deps == nil && !t.builtin {
			plan.Unchecked = append(plan.Unchecked, name)
		}
		step := Step{Name: name, RequiredBy: t.requiredBy}
		switch {
		case t.wasPresent && !t.present:
			step.Action, step.From, step.Replaces = ActionRemove, t.wasVersion, t.files
		case !t.wasPresent && t.present:
			step.Action, step.To, step.Enabled = ActionInstall, t.version, t.enabled
		case t.release != nil:
			step.Action, step.From, step.To, step.Enabled, step.Replaces = ActionUpdate, t.wasVersion, t.version, t.enabled, t.files
		case t.enabled && !t.wasEnabled:
			step.Action = ActionEnable
		case !t.enabled && t.wasEnabled:
			step.Action = ActionDisable
		default:
			continue
		}
		if t.release != nil && step.Action != ActionRemove {
			step.Download = &Download{FileName: t.release.FileName, URL: t.release.DownloadURL, SHA1: t.release.SHA1}
		}
		plan.Steps = append(plan.Steps, step)
	}
	plan.Hash = hashSteps(plan.FactorioVersion, plan.Steps)
	return plan
}

func hashSteps(game string, steps []Step) string {
	raw, _ := json.Marshal(struct {
		Game  string `json:"game"`
		Steps []Step `json:"steps"`
	}{game, steps})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
