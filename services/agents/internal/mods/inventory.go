// Package mods reads and changes the server's mod set: `mod-list.json` plus
// the archives next to it.
package mods

import (
	"archive/zip"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"io/fs"
	"os"
	"sort"
	"strings"
)

// Mod is one entry of the server's mod set.
type Mod struct {
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
	// From the archive name (`{name}_{version}.zip`); empty for mods that
	// ship with the game.
	Version string `json:"version,omitzero"`
	// Listed in mod-list.json with no archive next to it: part of the game
	// or of an expansion (base, space-age, quality, …). Never removable.
	Builtin bool `json:"builtin"`
}

// Installed is what the agent knows of one mod on disk, for planning
// changes: Mod, plus where it lives and what it depends on.
type Installed struct {
	Mod
	// Archives of this mod in the folder: usually one, more when several
	// versions were dropped in by hand.
	Files []string `json:"-"`
	// Installed as a folder rather than an archive: left to whoever put it
	// there — the agent enables or disables it, never replaces or deletes it.
	Unpacked bool `json:"unpacked"`
	// Present in mod-list.json. Factorio enables an archive that is not, on
	// its next start.
	Listed bool `json:"-"`
	// Enabled or disabled by the Factorio image at every start, from its
	// DLC_SPACE_AGE variable: a change made here would be silently undone.
	DLC bool `json:"dlc"`
	// nil when info.json could not be read.
	Dependencies []Dependency `json:"-"`
}

// listEntry keeps whatever else Factorio writes per entry (a pinned
// `version`, fields of later versions), so a rewrite changes only what the
// agent means to change.
type listEntry struct {
	Name    string         `json:"name"`
	Enabled bool           `json:"enabled"`
	Version string         `json:"version,omitzero"`
	Unknown jsontext.Value `json:",embed"`
}

type modList struct {
	Mods    []listEntry    `json:"mods"`
	Unknown jsontext.Value `json:",embed"`
}

// readModList returns the list, and whether the file exists. A missing
// mod-list.json is an empty set, not an error: the server has simply not
// started yet.
func readModList(root *os.Root) (modList, bool, error) {
	var list modList
	raw, err := root.ReadFile(modListName)
	switch {
	case err == nil:
		if err := json.Unmarshal(raw, &list); err != nil {
			return modList{}, true, err
		}
		return list, true, nil
	case os.IsNotExist(err):
		return list, false, nil
	default:
		return modList{}, false, err
	}
}

func encodeModList(list modList) ([]byte, error) {
	if list.Mods == nil {
		list.Mods = []listEntry{}
	}
	return json.Marshal(list, jsontext.WithIndent("  "))
}

const modListName = "mod-list.json"

// The expansion's mods, which the factoriotools entrypoint (docker-dlc.sh)
// enables or disables at every start according to DLC_SPACE_AGE.
var dlcMods = map[string]bool{"elevated-rails": true, "quality": true, "space-age": true}

type file struct {
	name     string
	version  string
	unpacked bool
}

// scan lists the mod archives and folders, by mod name.
func scan(root *os.Root) (map[string][]file, error) {
	entries, err := fs.ReadDir(root.FS(), ".")
	if err != nil {
		return nil, err
	}
	found := map[string][]file{}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		if entry.IsDir() {
			// An unpacked mod: `{name}_{version}` or `{name}`.
			modName, version := splitArchive(name)
			found[modName] = append(found[modName], file{name: name, version: version, unpacked: true})
			continue
		}
		if base, ok := strings.CutSuffix(name, ".zip"); ok && entry.Type().IsRegular() {
			modName, version := splitArchive(base)
			found[modName] = append(found[modName], file{name: name, version: version})
		}
	}
	return found, nil
}

// newest picks the file Factorio loads among several versions of a mod.
func newest(candidates []file) file {
	best := candidates[0]
	for _, candidate := range candidates[1:] {
		a, errA := ParseVersion(candidate.version)
		b, errB := ParseVersion(best.version)
		if errA == nil && (errB != nil || a.Compare(b) > 0) {
			best = candidate
		}
	}
	return best
}

// Snapshot lists the mod set as mod-list.json declares it, with the version
// of each archive. Cheap: no archive is opened. Archives record it.
func Snapshot(root *os.Root) ([]Mod, error) {
	found, err := scan(root)
	if err != nil {
		return nil, err
	}
	list, _, err := readModList(root)
	if err != nil {
		return nil, err
	}

	result := make([]Mod, 0, len(list.Mods))
	for _, entry := range list.Mods {
		mod := Mod{Name: entry.Name, Enabled: entry.Enabled, Builtin: len(found[entry.Name]) == 0}
		if !mod.Builtin {
			mod.Version = newest(found[entry.Name]).version
		}
		result = append(result, mod)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}

// Inventory is the full picture the planner works from: every listed mod and
// every archive or folder present, with its dependencies read from its
// info.json. Mods that ship with the game take the game's version, `game`
// (empty when unknown).
func Inventory(root *os.Root, game string) ([]Installed, error) {
	found, err := scan(root)
	if err != nil {
		return nil, err
	}
	list, _, err := readModList(root)
	if err != nil {
		return nil, err
	}

	byName := map[string]*Installed{}
	var order []string
	for _, entry := range list.Mods {
		if _, seen := byName[entry.Name]; seen {
			continue
		}
		byName[entry.Name] = &Installed{Mod: Mod{Name: entry.Name, Enabled: entry.Enabled}, Listed: true}
		order = append(order, entry.Name)
	}
	for name := range found {
		if _, listed := byName[name]; !listed {
			// Dropped in by hand: Factorio enables it on its next start.
			byName[name] = &Installed{Mod: Mod{Name: name, Enabled: true}}
			order = append(order, name)
		}
	}

	result := make([]Installed, 0, len(order))
	for _, name := range order {
		mod := byName[name]
		candidates := found[name]
		if len(candidates) == 0 {
			mod.Builtin = true
			mod.DLC = dlcMods[name]
			mod.Version = game
		} else {
			loaded := newest(candidates)
			mod.Version = loaded.version
			mod.Unpacked = loaded.unpacked
			for _, candidate := range candidates {
				if !candidate.unpacked {
					mod.Files = append(mod.Files, candidate.name)
				}
			}
			// Unreadable metadata leaves Dependencies nil: the planner then
			// cannot vouch for this mod's needs, and says so.
			if info, err := readInfo(root, loaded); err == nil {
				mod.Dependencies = info.dependencies
			}
		}
		result = append(result, *mod)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}

// readInfo reads the info.json of an archive or a folder. Mods that ship with
// the game have neither; the game resolves their needs itself.
func readInfo(root *os.Root, f file) (info, error) {
	if f.unpacked {
		raw, err := root.ReadFile(f.name + "/info.json")
		if err != nil {
			return info{}, err
		}
		return parseInfo(raw)
	}
	handle, err := root.Open(f.name)
	if err != nil {
		return info{}, err
	}
	defer handle.Close()
	stat, err := handle.Stat()
	if err != nil {
		return info{}, err
	}
	reader, err := zip.NewReader(handle, stat.Size())
	if err != nil {
		return info{}, err
	}
	for _, entry := range reader.File {
		if strings.Count(entry.Name, "/") == 1 && strings.HasSuffix(entry.Name, "/info.json") {
			return readInfoEntry(entry)
		}
	}
	return info{}, errNoInfo
}

// splitArchive cuts `{name}_{version}` at its last underscore, when what
// follows looks like a version. Mod names may themselves contain underscores.
func splitArchive(base string) (name, version string) {
	i := strings.LastIndexByte(base, '_')
	if i <= 0 {
		return base, ""
	}
	candidate := base[i+1:]
	if candidate == "" || strings.Trim(candidate, "0123456789.") != "" {
		return base, ""
	}
	return base[:i], candidate
}
