// Package mods reads (and, in phase 4, changes) the server's mod set:
// `mod-list.json` plus the archives next to it.
package mods

import (
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

type modList struct {
	Mods []struct {
		Name    string `json:"name"`
		Enabled bool   `json:"enabled"`
	} `json:"mods"`
}

// Snapshot lists the mod set as it is on disk. A missing mod-list.json is an
// empty set, not an error: the server has simply not started yet.
func Snapshot(root *os.Root) ([]Mod, error) {
	versions := map[string]string{}
	installed := map[string]bool{}

	entries, err := fs.ReadDir(root.FS(), ".")
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		if entry.IsDir() {
			// An unpacked mod: `{name}_{version}` or `{name}`.
			modName, version := splitArchive(name)
			installed[modName] = true
			versions[modName] = version
			continue
		}
		if base, ok := strings.CutSuffix(name, ".zip"); ok {
			modName, version := splitArchive(base)
			installed[modName] = true
			versions[modName] = version
		}
	}

	var list modList
	raw, err := root.ReadFile("mod-list.json")
	switch {
	case err == nil:
		if err := json.Unmarshal(raw, &list); err != nil {
			return nil, err
		}
	case !os.IsNotExist(err):
		return nil, err
	}

	result := make([]Mod, 0, len(list.Mods))
	for _, entry := range list.Mods {
		result = append(result, Mod{
			Name:    entry.Name,
			Enabled: entry.Enabled,
			Version: versions[entry.Name],
			Builtin: !installed[entry.Name],
		})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
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
