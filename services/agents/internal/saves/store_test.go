package saves

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/fakesave"
)

type fixture struct {
	store                *Store
	savesDir, backupsDir string
	saves, backups, mods *os.Root
	clock                time.Time
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{savesDir: t.TempDir(), backupsDir: t.TempDir(), clock: time.Date(2026, 10, 27, 14, 30, 0, 0, time.UTC)}
	modsDir := t.TempDir()
	write(t, modsDir, "mod-list.json", []byte(`{"mods":[{"name":"base","enabled":true},{"name":"even-distribution","enabled":true},{"name":"space-age","enabled":false}]}`))
	write(t, modsDir, "even-distribution_2.0.3.zip", []byte("zip"))

	var err error
	f.saves, err = os.OpenRoot(f.savesDir)
	must(t, err)
	f.backups, err = os.OpenRoot(f.backupsDir)
	must(t, err)
	f.mods, err = os.OpenRoot(modsDir)
	must(t, err)
	f.store = NewStore(f.saves, f.backups, f.mods)
	f.store.now = func() time.Time { return f.clock }
	f.store.retryDelay = 0
	return f
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func write(t *testing.T, dir, name string, data []byte) {
	t.Helper()
	must(t, os.WriteFile(filepath.Join(dir, name), data, 0o644))
}

func (f *fixture) save(t *testing.T, name, payload string, age time.Duration) {
	t.Helper()
	path := filepath.Join(f.savesDir, name+".zip")
	must(t, os.WriteFile(path, fakesave.Valid(t, name, payload), 0o644))
	when := time.Now().Add(-age)
	must(t, os.Chtimes(path, when, when))
}

func names(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	must(t, err)
	var out []string
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out
}

func TestCreateArchivesTheNewestSave(t *testing.T) {
	f := newFixture(t)
	f.save(t, "_autosave1", "old", time.Hour)
	f.save(t, "_autosave2", "new", time.Minute)

	meta, err := f.store.Create(CreateRequest{Source: SourceManual, Label: "before boss", CreatedBy: "admin", FactorioVersion: "2.0.77"})
	must(t, err)

	if meta.ID != "20261027-143000-manual" || meta.SaveName != "_autosave2.zip" || meta.Size == 0 || len(meta.SHA256) != 64 {
		t.Fatalf("unexpected meta: %+v", meta)
	}
	want := []string{"base", "even-distribution", "space-age"}
	var got []string
	for _, m := range meta.Mods {
		got = append(got, m.Name)
	}
	if !slices.Equal(got, want) || meta.Mods[1].Version != "2.0.3" || !meta.Mods[0].Builtin || meta.Mods[1].Builtin {
		t.Fatalf("mod set: %+v", meta.Mods)
	}

	// A second archive in the same second gets a suffix, not an overwrite.
	second, err := f.store.Create(CreateRequest{Source: SourceManual})
	must(t, err)
	if second.ID != "20261027-143000-manual-2" {
		t.Fatalf("second id %q", second.ID)
	}

	list, err := f.store.ListBackups()
	must(t, err)
	if len(list) != 2 {
		t.Fatalf("listed %d", len(list))
	}
}

func TestCreateRefusesABrokenSaveAndPublishesNothing(t *testing.T) {
	f := newFixture(t)
	write(t, f.savesDir, "_autosave1.zip", []byte("PK\x03\x04 truncated mid-write"))

	_, err := f.store.Create(CreateRequest{Source: SourceScheduled})
	if !errors.Is(err, ErrInvalidArchive) {
		t.Fatalf("got %v", err)
	}
	if left := names(t, f.backupsDir); len(left) != 0 {
		t.Fatalf("left behind: %v", left)
	}
}

func TestCreateWithNoSave(t *testing.T) {
	f := newFixture(t)
	if _, err := f.store.Create(CreateRequest{Source: SourceManual}); !errors.Is(err, ErrNoSave) {
		t.Fatalf("got %v", err)
	}
}

func TestListSavesIgnoresTemporaryAndForeignFiles(t *testing.T) {
	f := newFixture(t)
	f.save(t, "_autosave1", "a", time.Hour)
	write(t, f.savesDir, "_autosave2.tmp.zip", []byte("half written"))
	write(t, f.savesDir, "notes.txt", []byte("x"))
	outside := filepath.Join(t.TempDir(), "secret.zip")
	write(t, filepath.Dir(outside), "secret.zip", fakesave.Valid(t, "secret", "x"))
	must(t, os.Symlink(outside, filepath.Join(f.savesDir, "zzz.zip")))

	list, err := f.store.ListSaves()
	must(t, err)
	if len(list) != 1 || list[0].Name != "_autosave1.zip" || !list[0].Latest {
		t.Fatalf("got %+v", list)
	}
}

func TestRestoreSetsCurrentSavesAsideAndWritesTheArchive(t *testing.T) {
	f := newFixture(t)
	f.save(t, "_autosave1", "archived", time.Hour)
	meta, err := f.store.Create(CreateRequest{Source: SourceManual})
	must(t, err)

	// The world moves on: new autosaves replace the archived state.
	f.save(t, "_autosave1", "later", time.Minute)
	f.save(t, "_autosave2", "later2", 0)
	f.clock = f.clock.Add(time.Hour)

	result, err := f.store.Restore(meta.ID, "")
	must(t, err)

	if result.SaveName != "_autosave1.zip" || len(result.Replaced) != 2 || result.ReplacedDir != "replaced-20261027-153000" {
		t.Fatalf("result %+v", result)
	}
	if got := names(t, f.savesDir); !slices.Equal(got, []string{"_autosave1.zip"}) {
		t.Fatalf("saves folder: %v", got)
	}
	restored, err := os.ReadFile(filepath.Join(f.savesDir, "_autosave1.zip"))
	must(t, err)
	archived, err := os.ReadFile(filepath.Join(f.backupsDir, meta.ID+".zip"))
	must(t, err)
	if !bytes.Equal(restored, archived) {
		t.Fatal("restored file differs from the archive")
	}
	if set := names(t, filepath.Join(f.backupsDir, result.ReplacedDir)); !slices.Equal(set, []string{"_autosave1.zip", "_autosave2.zip"}) {
		t.Fatalf("replaced set: %v", set)
	}
}

func TestRestoreUnderAFixedName(t *testing.T) {
	f := newFixture(t)
	f.save(t, "_autosave1", "a", 0)
	meta, err := f.store.Create(CreateRequest{Source: SourceManual})
	must(t, err)

	result, err := f.store.Restore(meta.ID, "main.zip")
	must(t, err)
	if result.SaveName != "main.zip" || !slices.Equal(names(t, f.savesDir), []string{"main.zip"}) {
		t.Fatalf("result %+v, folder %v", result, names(t, f.savesDir))
	}

	if _, err := f.store.Restore(meta.ID, "../escape.zip"); err == nil {
		t.Fatal("a path was accepted as a save name")
	}
}

func TestRestoreRefusesAnAlteredArchiveWithoutTouchingSaves(t *testing.T) {
	for name, damage := range map[string]func(t *testing.T, path string){
		"rewritten": func(t *testing.T, path string) {
			must(t, os.WriteFile(path, fakesave.Valid(t, "_autosave1", "forged"), 0o640))
		},
		"truncated": func(t *testing.T, path string) { must(t, os.Truncate(path, 40)) },
	} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			f.save(t, "_autosave1", "good", time.Hour)
			meta, err := f.store.Create(CreateRequest{Source: SourceManual})
			must(t, err)
			f.save(t, "_autosave1", "current", 0)
			before, _ := os.ReadFile(filepath.Join(f.savesDir, "_autosave1.zip"))

			must(t, f.store.Verify(meta.ID))
			damage(t, filepath.Join(f.backupsDir, meta.ID+".zip"))

			if err := f.store.Verify(meta.ID); !errors.Is(err, ErrChecksum) {
				t.Fatalf("verify: got %v", err)
			}
			if _, err := f.store.Restore(meta.ID, ""); !errors.Is(err, ErrChecksum) {
				t.Fatalf("got %v", err)
			}
			after, _ := os.ReadFile(filepath.Join(f.savesDir, "_autosave1.zip"))
			if !bytes.Equal(before, after) {
				t.Fatal("the live save was touched by a refused restore")
			}
		})
	}
}

func TestIdsAreValidatedBeforeAnyFileAccess(t *testing.T) {
	f := newFixture(t)
	for _, id := range []string{"../../etc/passwd", "20261027-143000-manual/../../x", "x.json", "", "20261027-143000-other"} {
		if _, err := f.store.Get(id); !errors.Is(err, ErrNotFound) {
			t.Errorf("Get(%q): %v", id, err)
		}
		if err := f.store.Delete(id); !errors.Is(err, ErrNotFound) {
			t.Errorf("Delete(%q): %v", id, err)
		}
	}
}

func TestPrune(t *testing.T) {
	f := newFixture(t)
	f.save(t, "_autosave1", "x", 0)
	base := f.clock

	create := func(source string, daysAgo int) string {
		f.clock = base.Add(-time.Duration(daysAgo) * 24 * time.Hour)
		meta, err := f.store.Create(CreateRequest{Source: source})
		must(t, err)
		return meta.ID
	}
	s1 := create(SourceScheduled, 1)
	s2 := create(SourceScheduled, 2)
	s3 := create(SourceScheduled, 3)
	manual := create(SourceManual, 40)
	recentPre := create(SourcePreRestore, 2)
	oldPre := create(SourcePreRestore, 20)
	f.clock = base

	removed, err := f.store.Prune(PrunePolicy{Sources: []string{SourceScheduled}, KeepLast: 2})
	must(t, err)
	if !slices.Equal(removed, []string{s3}) {
		t.Fatalf("keepLast removed %v", removed)
	}

	removed, err = f.store.Prune(PrunePolicy{Sources: []string{SourcePreRestore}, KeepLast: 0, MaxAge: 24 * time.Hour})
	must(t, err)
	if !slices.Equal(removed, []string{oldPre}) {
		t.Fatalf("a safety copy younger than a week was pruned, or the old one kept: %v", removed)
	}

	list, err := f.store.ListBackups()
	must(t, err)
	var left []string
	for _, m := range list {
		left = append(left, m.ID)
	}
	for _, id := range []string{s1, s2, manual, recentPre} {
		if !slices.Contains(left, id) {
			t.Errorf("%s was pruned", id)
		}
	}
}

func TestDeleteRemovesBothFiles(t *testing.T) {
	f := newFixture(t)
	f.save(t, "_autosave1", "x", 0)
	meta, err := f.store.Create(CreateRequest{Source: SourceManual})
	must(t, err)
	must(t, f.store.Delete(meta.ID))
	if left := names(t, f.backupsDir); len(left) != 0 {
		t.Fatalf("left %v", left)
	}
	if _, err := f.store.Get(meta.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v", err)
	}
}

func TestReplacedSetsAreBounded(t *testing.T) {
	f := newFixture(t)
	f.save(t, "_autosave1", "x", 0)
	meta, err := f.store.Create(CreateRequest{Source: SourceManual})
	must(t, err)
	for i := range 5 {
		f.clock = f.clock.Add(time.Minute)
		_, err := f.store.Restore(meta.ID, "")
		must(t, err)
		_ = i
	}
	var dirs int
	_ = fs.WalkDir(os.DirFS(f.backupsDir), ".", func(path string, d fs.DirEntry, _ error) error {
		if d.IsDir() && path != "." {
			dirs++
			return fs.SkipDir
		}
		return nil
	})
	if dirs != keepReplaced {
		t.Fatalf("%d replaced sets kept, want %d", dirs, keepReplaced)
	}
}
