package mods

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSplitArchive(t *testing.T) {
	for base, want := range map[string][2]string{
		"even-distribution_2.0.3": {"even-distribution", "2.0.3"},
		"my_mod_name_1.2.10":      {"my_mod_name", "1.2.10"},
		"no_version_here":         {"no_version_here", ""},
		"plain":                   {"plain", ""},
	} {
		name, version := splitArchive(base)
		if name != want[0] || version != want[1] {
			t.Errorf("%s: got %s %s", base, name, version)
		}
	}
}

func TestSnapshotWithoutModList(t *testing.T) {
	dir := t.TempDir()
	root, _ := os.OpenRoot(dir)
	if list, err := Snapshot(root); err != nil || len(list) != 0 {
		t.Fatalf("got %v %v", list, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "mod-list.json"), []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Snapshot(root); err == nil {
		t.Fatal("a broken mod-list.json was accepted")
	}
}
