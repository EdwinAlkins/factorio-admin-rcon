package saves

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/fakesave"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/mods"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/worlds"
)

// library publishes one world, as the world agent does, and returns it.
func library(t *testing.T, save []byte) (*worlds.Store, worlds.Meta, string) {
	t.Helper()
	dir, work := t.TempDir(), t.TempDir()
	write(t, work, "world.zip", save)
	root, err := os.OpenRoot(dir)
	must(t, err)
	workRoot, err := os.OpenRoot(work)
	must(t, err)
	store := worlds.NewStore(root)
	id, err := store.NewID()
	must(t, err)
	meta, err := store.Publish(workRoot, "world.zip", nil, worlds.Meta{
		ID: id, Name: "Riche en fer", Seed: 42, FactorioVersion: "2.1.23",
		Mods: []worlds.Mod{{Name: "base"}, {Name: "even-distribution", Version: "2.0.3"}},
	})
	must(t, err)
	return store, meta, dir
}

func TestImportWorldArchivesItForARestore(t *testing.T) {
	f := newFixture(t)
	store, world, _ := library(t, fakesave.Valid(t, "world", "fresh"))

	meta, err := f.store.ImportWorld(store, world.ID, "admin")
	must(t, err)
	if meta.Source != SourceWorld || !ValidID(meta.ID) || meta.Label != "Riche en fer" || meta.SaveName != "riche-en-fer.zip" ||
		meta.SHA256 != world.SHA256 || meta.FactorioVersion != "2.1.23" || meta.CreatedBy != "admin" {
		t.Fatalf("meta = %+v", meta)
	}
	want := []mods.Mod{{Name: "base", Enabled: true, Builtin: true}, {Name: "even-distribution", Version: "2.0.3", Enabled: true}}
	if !slices.Equal(meta.Mods, want) {
		t.Fatalf("mods = %+v", meta.Mods)
	}

	// From there it is an ordinary archive.
	f.save(t, "_autosave1", "old", 0)
	result, err := f.store.Restore(meta.ID, "")
	must(t, err)
	if result.SaveName != "riche-en-fer.zip" || !slices.Equal(names(t, f.savesDir), []string{"riche-en-fer.zip"}) {
		t.Fatalf("restore = %+v, saves %v", result, names(t, f.savesDir))
	}
}

func TestImportWorldRefusesAWorldChangedOnDisk(t *testing.T) {
	f := newFixture(t)
	store, world, dir := library(t, fakesave.Valid(t, "world", "fresh"))
	write(t, dir, world.ID+".zip", fakesave.Valid(t, "world", "tampered"))

	if _, err := f.store.ImportWorld(store, world.ID, "admin"); !errors.Is(err, ErrChecksum) {
		t.Fatalf("err = %v", err)
	}
	if entries := names(t, f.backupsDir); len(entries) != 0 {
		t.Fatalf("left in the archives: %v", entries)
	}
}

func TestImportWorldRefusesWhatIsNotASave(t *testing.T) {
	f := newFixture(t)
	store, world, _ := library(t, []byte("not a zip"))
	if _, err := f.store.ImportWorld(store, world.ID, "admin"); !errors.Is(err, ErrInvalidArchive) {
		t.Fatalf("err = %v", err)
	}
	if _, err := f.store.ImportWorld(store, "../"+world.ID, "admin"); !errors.Is(err, worlds.ErrNotFound) {
		t.Fatalf("foreign id: %v", err)
	}
	if _, err := os.Stat(filepath.Join(f.backupsDir, world.ID+".zip")); !os.IsNotExist(err) {
		t.Fatal("copied under the world's own id")
	}
}

func TestAWorldIsNeverArchivedFromTheSavesFolder(t *testing.T) {
	f := newFixture(t)
	f.save(t, "_autosave1", "x", 0)
	if _, err := f.store.Create(CreateRequest{Source: SourceWorld}); err == nil {
		t.Fatal("created a world archive from the saves folder")
	}
}
