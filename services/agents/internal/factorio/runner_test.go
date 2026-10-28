package factorio_test

import (
	"archive/zip"
	"context"
	"encoding/json/v2"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/factorio"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/worlds"
)

// The test binary doubles as a fake Factorio: run with FAKE_FACTORIO=1, it
// answers the handful of options the runner uses, the way the real game
// prints them. The runner's exec, arguments and output parsing are all real.
func TestMain(m *testing.M) {
	if os.Getenv("FAKE_FACTORIO") == "1" {
		os.Exit(fakeFactorio(os.Args[1:]))
	}
	os.Exit(m.Run())
}

func fakeFactorio(args []string) int {
	option := func(name string) (string, bool) {
		i := slices.Index(args, name)
		if i < 0 || i+1 >= len(args) {
			return "", false
		}
		return args[i+1], true
	}
	if log := os.Getenv("FAKE_FACTORIO_LOG"); log != "" {
		f, _ := os.OpenFile(log, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		fmt.Fprintln(f, strings.Join(args, " "))
		f.Close()
	}
	if slices.Contains(args, "--version") {
		fmt.Println("Version: 2.1.23 (build 87750, linux64, headless)")
		return 0
	}
	if delay := os.Getenv("FAKE_FACTORIO_SLEEP"); delay != "" {
		d, _ := time.ParseDuration(delay)
		time.Sleep(d)
	}
	fmt.Println("   0.100 Loading mod core 2.1.23 (data.lua)")
	fmt.Println("   0.120 Loading mod base 2.1.23 (data.lua)")
	if dir, ok := option("--mod-directory"); ok {
		if _, err := os.Lstat(filepath.Join(dir, "mymod_1.2.3.zip")); err == nil {
			fmt.Println("   0.130 Loading mod mymod 1.2.3 (settings.lua)")
			fmt.Println("   0.140 Loading mod mymod 1.2.3 (data.lua)")
		}
	}
	if path, ok := option("--map-gen-settings"); ok {
		raw, _ := os.ReadFile(path)
		if strings.Contains(string(raw), "nope") {
			fmt.Println(`   0.000 Error Util.cpp:81: "nope" is not a valid autoplace control name.`)
			return 1
		}
	}
	if path, ok := option("--map-settings"); ok {
		raw, _ := os.ReadFile(path)
		_ = os.WriteFile(os.Getenv("FAKE_FACTORIO_LOG")+".map-settings", raw, 0o600)
	}
	seed := "4242"
	if s, ok := option("--map-gen-seed"); ok {
		seed = s
	}
	if path, ok := option("--generate-map-preview"); ok {
		size, _ := option("--map-preview-size")
		planet, _ := option("--map-preview-planet")
		fmt.Println("   1.094 Generating map preview: seed=" + seed)
		if report, ok := option("--report-quantities"); ok {
			for i, name := range strings.Split(report, ",") {
				fmt.Printf("   1.236 %s: totalEntityCount=%d, totalRichness=%d, minRichness=3, avgRichness=1.5, maxRichness=9\n", name, 10+i, 1000+i)
			}
		}
		_ = os.WriteFile(path, []byte("PNG "+seed+" "+size+" "+planet), 0o600)
	}
	if path, ok := option("--create"); ok {
		f, _ := os.Create(path)
		w := zip.NewWriter(f)
		entry, _ := w.Create("world/level.dat0")
		_, _ = entry.Write([]byte("seed " + seed))
		_ = w.Close()
		_ = f.Close()
	}
	if slices.Contains(args, "--dump-data") {
		config, _ := option("--config")
		raw, _ := os.ReadFile(config)
		_, writeData, _ := strings.Cut(string(raw), "write-data=")
		out := filepath.Join(strings.TrimSpace(writeData), "script-output")
		_ = os.MkdirAll(out, 0o700)
		dump, _ := os.ReadFile(os.Getenv("FAKE_FACTORIO_DUMP"))
		_ = os.WriteFile(filepath.Join(out, "data-raw-dump.json"), dump, 0o600)
	}
	fmt.Println("   1.353 Goodbye")
	return 0
}

type harness struct {
	runner  *factorio.Runner
	log     string
	modsDir string
}

func newHarness(t *testing.T, env ...string) *harness {
	t.Helper()
	dump, err := filepath.Abs("testdata/data-raw-dump.json")
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{log: filepath.Join(t.TempDir(), "args.log"), modsDir: t.TempDir()}
	write(t, h.modsDir, "mymod_1.2.3.zip", "zip")
	write(t, h.modsDir, "mod-list.json", `{"mods":[{"name":"base","enabled":true},{"name":"mymod","enabled":true}]}`)
	h.runner, err = factorio.New(context.Background(), factorio.Options{
		Binary:  os.Args[0],
		DataDir: "testdata",
		WorkDir: t.TempDir(),
		ModsDir: h.modsDir,
		Timeout: 10 * time.Second,
		Env:     append([]string{"FAKE_FACTORIO=1", "FAKE_FACTORIO_LOG=" + h.log, "FAKE_FACTORIO_DUMP=" + dump}, env...),
	})
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func write(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) calls(t *testing.T) []string {
	t.Helper()
	raw, err := os.ReadFile(h.log)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(raw)), "\n")
}

func ptr[T any](v T) *T { return &v }

func TestVersion(t *testing.T) {
	h := newHarness(t)
	if got := h.runner.Version(); got != "2.1.23" {
		t.Fatalf("version = %q", got)
	}
}

func TestPreviewPassesSettingsAndParsesTheReport(t *testing.T) {
	h := newHarness(t)
	settings := worlds.Settings{MapGen: &worlds.MapGen{
		AutoplaceControls: map[string]worlds.Control{"iron-ore": {Richness: ptr(2.0)}},
	}}
	preview, err := h.runner.Preview(context.Background(), factorio.PreviewRequest{
		Settings: settings, Seed: ptr(uint32(123)), Size: 512, Planet: "vulcanus",
		OffsetX: -64, OffsetY: 32, Report: []string{"tungsten-ore", "calcite"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if string(preview.PNG) != "PNG 123 512 vulcanus" || preview.Seed != 123 {
		t.Fatalf("preview = %q seed %d", preview.PNG, preview.Seed)
	}
	want := []factorio.Quantity{{Name: "tungsten-ore", Count: 10, Richness: 1000}, {Name: "calcite", Count: 11, Richness: 1001}}
	if !slices.Equal(preview.Quantities, want) {
		t.Fatalf("quantities = %+v", preview.Quantities)
	}

	call := h.calls(t)[1]
	for _, part := range []string{"--map-preview-offset -64,32", "--map-gen-seed 123", "--map-gen-settings ", "--mod-directory "} {
		if !strings.Contains(call, part) {
			t.Errorf("call %q lacks %q", call, part)
		}
	}
	// Map settings change no terrain: never passed to a preview.
	if strings.Contains(call, "--map-settings") {
		t.Errorf("preview passed map settings: %q", call)
	}
}

func TestPreviewWithoutSeedReportsTheGamesOwn(t *testing.T) {
	h := newHarness(t)
	preview, err := h.runner.Preview(context.Background(), factorio.PreviewRequest{
		Settings: worlds.Settings{ExchangeString: ">>>" + strings.Repeat("eNp", 10) + "<<<"},
		Size:     256, Planet: "nauvis",
	})
	if err != nil {
		t.Fatal(err)
	}
	if preview.Seed != 4242 {
		t.Fatalf("seed = %d", preview.Seed)
	}
	if call := h.calls(t)[1]; !strings.Contains(call, "--exchange-string >>>") || strings.Contains(call, "--map-gen-seed") {
		t.Fatalf("call = %q", call)
	}
}

func TestTheGamesRefusalIsReported(t *testing.T) {
	h := newHarness(t)
	_, err := h.runner.Preview(context.Background(), factorio.PreviewRequest{
		Settings: worlds.Settings{MapGen: &worlds.MapGen{AutoplaceControls: map[string]worlds.Control{"nope": {}}}},
		Size:     256, Planet: "nauvis",
	})
	var refused *factorio.Error
	if !errors.As(err, &refused) || refused.Message != `"nope" is not a valid autoplace control name.` {
		t.Fatalf("err = %v", err)
	}
}

func TestCreateMergesMapSettingsAndRecordsTheModSet(t *testing.T) {
	h := newHarness(t)
	settings := worlds.Settings{MapSettings: &worlds.MapSettings{
		Pollution:      &worlds.Pollution{Enabled: ptr(false)},
		EnemyExpansion: &worlds.EnemyExpansion{MaxExpansionDistance: ptr(int64(9))},
	}}
	created, err := h.runner.Create(context.Background(), settings, ptr(uint32(77)), 256)
	if err != nil {
		t.Fatal(err)
	}
	if created.Seed != 77 || string(created.Preview) != "PNG 77 256 nauvis" {
		t.Fatalf("created = %+v", created)
	}
	if _, err := os.Stat(filepath.Join(h.runner.Out(), created.SaveName)); err != nil {
		t.Fatal(err)
	}
	// The game's own mods carry no version, as in the data agent's mod set.
	want := []worlds.Mod{{Name: "base"}, {Name: "mymod", Version: "1.2.3"}}
	if !slices.Equal(created.Mods, want) {
		t.Fatalf("mods = %+v", created.Mods)
	}

	// The game refuses an incomplete file: every member of its own is kept,
	// the two changed, and the example's comments dropped.
	raw, err := os.ReadFile(h.log + ".map-settings")
	if err != nil {
		t.Fatal(err)
	}
	var written map[string]any
	if err := json.Unmarshal(raw, &written); err != nil {
		t.Fatal(err)
	}
	pollution, _ := written["pollution"].(map[string]any)
	if pollution["enabled"] != false || pollution["diffusion_ratio"] != 0.02 {
		t.Errorf("pollution = %v", pollution)
	}
	expansion, _ := written["enemy_expansion"].(map[string]any)
	if expansion["max_expansion_distance"] != 9.0 || expansion["settler_group_max_size"] != 10.0 {
		t.Errorf("enemy_expansion = %v", expansion)
	}
	if _, ok := written["path_finder"]; !ok {
		t.Error("path_finder dropped")
	}
	if strings.Contains(string(raw), "_comment") {
		t.Error("comments kept")
	}

	// The read-only mods folder is never written: the game gets links and
	// private copies of the files it rewrites.
	calls := h.calls(t)
	if !strings.Contains(calls[len(calls)-1], "--create ") || !strings.Contains(calls[len(calls)-1], "--map-gen-seed 77") {
		t.Fatalf("create call = %q", calls[len(calls)-1])
	}
}

func TestOneRunAtATime(t *testing.T) {
	h := newHarness(t, "FAKE_FACTORIO_SLEEP=500ms")
	if _, err := h.runner.Catalog(context.Background()); err != nil {
		t.Fatal(err)
	}
	done := make(chan error)
	go func() {
		_, err := h.runner.Preview(context.Background(), factorio.PreviewRequest{Size: 256, Planet: "nauvis"})
		done <- err
	}()
	time.Sleep(150 * time.Millisecond)
	if _, err := h.runner.Preview(context.Background(), factorio.PreviewRequest{Size: 256, Planet: "nauvis"}); !errors.Is(err, factorio.ErrBusy) {
		t.Fatalf("second run: %v", err)
	}
	// A cached catalogue does not wait for the run.
	if _, err := h.runner.Catalog(context.Background()); err != nil {
		t.Fatalf("catalog during a run: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestARunPastItsDeadlineIsKilled(t *testing.T) {
	h := newHarness(t, "FAKE_FACTORIO_SLEEP=5s")
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	started := time.Now()
	// The caller's context ends first: the run is killed, not waited for.
	_, err := h.runner.Preview(ctx, factorio.PreviewRequest{Size: 256, Planet: "nauvis"})
	if !errors.Is(err, factorio.ErrTimeout) || time.Since(started) > 4*time.Second {
		t.Fatalf("err = %v after %s", err, time.Since(started))
	}
}

func TestCatalog(t *testing.T) {
	h := newHarness(t)
	catalog, err := h.runner.Catalog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if catalog.FactorioVersion != "2.1.23" {
		t.Errorf("version = %q", catalog.FactorioVersion)
	}
	var names []string
	for _, planet := range catalog.Planets {
		names = append(names, planet.Name)
	}
	if !slices.Equal(names, []string{"nauvis", "vulcanus", "gleba", "fulgora", "aquilo"}) {
		t.Fatalf("planets = %v", names)
	}
	nauvis, vulcanus := catalog.Planets[0], catalog.Planets[1]
	if !nauvis.ClimateControls || vulcanus.ClimateControls {
		t.Error("climate controls belong to Nauvis only")
	}
	if !slices.Contains(nauvis.Controls, "iron-ore") || !slices.Contains(vulcanus.Controls, "tungsten_ore") {
		t.Errorf("controls: nauvis %v vulcanus %v", nauvis.Controls, vulcanus.Controls)
	}
	if !slices.Equal(vulcanus.Resources, []string{"calcite", "coal", "sulfuric-acid-geyser", "tungsten-ore"}) {
		t.Errorf("vulcanus resources = %v", vulcanus.Resources)
	}
	for _, control := range catalog.Controls {
		if control.Name == "enemy-base" && (control.CanBeDisabled || control.Category != "enemy") {
			t.Errorf("enemy-base = %+v", control)
		}
		if control.Name == "iron-ore" && !control.Richness {
			t.Errorf("iron-ore = %+v", control)
		}
	}

	presets := map[string]factorio.Preset{}
	for _, preset := range catalog.Presets {
		presets[preset.Name] = preset
	}
	if len(presets) != 9 || !presets["default"].Default || catalog.Presets[0].Name != "default" {
		t.Fatalf("presets = %v", catalog.Presets)
	}
	// Named values become the numbers the game's dialog uses.
	rich := presets["rich-resources"].Settings.MapGen.AutoplaceControls["iron-ore"]
	if rich.Richness == nil || *rich.Richness != 2 {
		t.Errorf("rich-resources iron = %+v", rich)
	}
	death := presets["death-world"].Settings
	if *death.MapGen.StartingArea < 0.70 || *death.MapGen.StartingArea > 0.71 {
		t.Errorf("death-world starting area = %v", *death.MapGen.StartingArea)
	}
	if death.MapSettings == nil || *death.MapSettings.EnemyEvolution.TimeFactor != 2e-05 {
		t.Errorf("death-world map settings = %+v", death.MapSettings)
	}
	if presets["island"].Settings.MapGen.PropertyExpressionNames["elevation"] != "elevation_island" {
		t.Errorf("island = %+v", presets["island"].Settings.MapGen)
	}
	if catalog.MapSettings.Pollution == nil || *catalog.MapSettings.Pollution.DiffusionRatio != 0.02 {
		t.Errorf("default map settings = %+v", catalog.MapSettings)
	}

	// Cached until the mods change.
	if _, err := h.runner.Catalog(context.Background()); err != nil {
		t.Fatal(err)
	}
	dumps := func() int {
		n := 0
		for _, call := range h.calls(t) {
			if strings.Contains(call, "--dump-data") {
				n++
			}
		}
		return n
	}
	if dumps() != 1 {
		t.Fatalf("dumped %d times", dumps())
	}
	write(t, h.modsDir, "mod-list.json", `{"mods":[{"name":"base","enabled":true}]}`)
	if _, err := h.runner.Catalog(context.Background()); err != nil {
		t.Fatal(err)
	}
	if dumps() != 2 {
		t.Fatalf("mod change: dumped %d times", dumps())
	}
}
