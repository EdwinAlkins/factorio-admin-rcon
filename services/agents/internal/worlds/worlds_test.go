package worlds_test

import (
	"encoding/json/v2"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/worlds"
)

func ptr[T any](v T) *T { return &v }

func TestValidate(t *testing.T) {
	valid := []worlds.Settings{
		{},
		{MapGen: &worlds.MapGen{
			Width: ptr(int64(0)), StartingArea: ptr(0.7), PeacefulMode: ptr(true),
			AutoplaceControls:       map[string]worlds.Control{"iron-ore": {Frequency: ptr(6.0), Size: ptr(0.0), Richness: ptr(2.0)}, "tungsten_ore": {}},
			CliffSettings:           &worlds.CliffSettings{Richness: ptr(0.0)},
			PropertyExpressionNames: map[string]any{"control:moisture:bias": "0.25", "elevation": "elevation_island", "trees_forest_path_cutout": 1.0},
		}},
		{MapSettings: &worlds.MapSettings{
			Pollution:      &worlds.Pollution{Enabled: ptr(false)},
			EnemyExpansion: &worlds.EnemyExpansion{SettlerGroupMinSize: ptr(int64(5)), SettlerGroupMaxSize: ptr(int64(5))},
		}},
		{ExchangeString: ">>>eNpjZGBk4GRgZWBlYGBm4GZgZmBn<<<"},
	}
	for i, settings := range valid {
		if err := settings.Validate(); err != nil {
			t.Errorf("valid #%d: %v", i, err)
		}
	}

	invalid := map[string]worlds.Settings{
		"richness":      {MapGen: &worlds.MapGen{AutoplaceControls: map[string]worlds.Control{"iron-ore": {Richness: ptr(7.0)}}}},
		"name":          {MapGen: &worlds.MapGen{AutoplaceControls: map[string]worlds.Control{"--preset": {}}}},
		"path name":     {MapGen: &worlds.MapGen{AutoplaceControls: map[string]worlds.Control{"../x": {}}}},
		"width":         {MapGen: &worlds.MapGen{Width: ptr(int64(-1))}},
		"expression":    {MapGen: &worlds.MapGen{PropertyExpressionNames: map[string]any{"elevation": "a b"}}},
		"bool expr":     {MapGen: &worlds.MapGen{PropertyExpressionNames: map[string]any{"elevation": true}}},
		"tech price":    {MapSettings: &worlds.MapSettings{DifficultySettings: &worlds.DifficultySettings{TechnologyPriceMultiplier: ptr(0.0)}}},
		"group size":    {MapSettings: &worlds.MapSettings{EnemyExpansion: &worlds.EnemyExpansion{SettlerGroupMinSize: ptr(int64(9)), SettlerGroupMaxSize: ptr(int64(3))}}},
		"exchange":      {ExchangeString: "not a string"},
		"exclusive":     {ExchangeString: ">>>eNpjZGBk4GRgZWBlYGBm4GZgZmBn<<<", MapGen: &worlds.MapGen{}},
		"exchange size": {ExchangeString: ">>>" + strings.Repeat("A", 70_000) + "<<<"},
	}
	for name, settings := range invalid {
		if err := settings.Validate(); !errors.Is(err, worlds.ErrInvalidSettings) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}

// The structures are written back out for the game: members left alone stay
// out of the file, so the game's own default applies.
func TestUnsetMembersStayOutOfTheFile(t *testing.T) {
	raw, err := json.Marshal(worlds.MapGen{AutoplaceControls: map[string]worlds.Control{"coal": {Size: ptr(0.0)}}})
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != `{"autoplace_controls":{"coal":{"size":0}}}` {
		t.Fatalf("got %s", raw)
	}
}

func TestValidName(t *testing.T) {
	for _, name := range []string{"Riche en fer", "死亡世界", "a"} {
		if !worlds.ValidName(name) {
			t.Errorf("%q refused", name)
		}
	}
	for _, name := range []string{"", " padded", "line\nbreak", strings.Repeat("x", 61)} {
		if worlds.ValidName(name) {
			t.Errorf("%q accepted", name)
		}
	}
}

func TestSaveName(t *testing.T) {
	cases := map[string]string{
		"Riche en fer !": "riche-en-fer.zip",
		"死亡世界":           "world-20261028-091500.zip",
	}
	for name, want := range cases {
		if got := worlds.SaveName(worlds.Meta{ID: "20261028-091500", Name: name}); got != want {
			t.Errorf("%q → %q, want %q", name, got, want)
		}
	}
}

func openRoot(t *testing.T, dir string) *os.Root {
	t.Helper()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { root.Close() })
	return root
}

func TestStorePublishListDelete(t *testing.T) {
	libraryDir, workDir := t.TempDir(), t.TempDir()
	store := worlds.NewStore(openRoot(t, libraryDir))
	if err := os.WriteFile(filepath.Join(workDir, "world.zip"), []byte("save"), 0o600); err != nil {
		t.Fatal(err)
	}

	id, err := store.NewID()
	if err != nil || !worlds.ValidID(id) {
		t.Fatalf("id %q: %v", id, err)
	}
	meta, err := store.Publish(openRoot(t, workDir), "world.zip", []byte("png"), worlds.Meta{ID: id, Name: "Test", Seed: 42})
	if err != nil {
		t.Fatal(err)
	}
	if meta.Size != 4 || len(meta.SHA256) != 64 || !meta.Preview || meta.Mods == nil {
		t.Fatalf("meta = %+v", meta)
	}

	// A second world in the same second gets a suffix.
	next, err := store.NewID()
	if err != nil || next != id+"-2" {
		t.Fatalf("next id %q: %v", next, err)
	}

	list, err := store.List()
	if err != nil || len(list) != 1 || list[0].Name != "Test" {
		t.Fatalf("list = %+v, %v", list, err)
	}
	preview, _, err := store.OpenPreview(id)
	if err != nil {
		t.Fatal(err)
	}
	preview.Close()

	if err := store.Delete(id); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(libraryDir)
	if len(entries) != 0 {
		t.Fatalf("left behind: %v", entries)
	}
	if _, err := store.Get(id); !errors.Is(err, worlds.ErrNotFound) {
		t.Fatalf("get after delete: %v", err)
	}
}

func TestStoreRefusesForeignIDs(t *testing.T) {
	store := worlds.NewStore(openRoot(t, t.TempDir()))
	for _, id := range []string{"../etc", "20261028-091500.zip", "x"} {
		if _, err := store.Get(id); !errors.Is(err, worlds.ErrNotFound) {
			t.Errorf("%q: %v", id, err)
		}
	}
}

func TestAWorldWithoutItsSaveIsNotListed(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "20261028-091500.json"), []byte(`{"id":"20261028-091500"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	list, err := worlds.NewStore(openRoot(t, dir)).List()
	if err != nil || len(list) != 0 {
		t.Fatalf("list = %+v, %v", list, err)
	}
}
