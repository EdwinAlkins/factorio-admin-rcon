package api_test

import (
	"context"
	"encoding/json/v2"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/factorio"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/world/api"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/worlds"
)

const token = "0123456789abcdef0123456789abcdef-world"

// fakeGame records what the API asks of the game.
type fakeGame struct {
	mu       sync.Mutex
	out      string
	previews []factorio.PreviewRequest
	creates  []worlds.Settings
	seeds    []*uint32
	err      error
}

func (g *fakeGame) Version() string { return "2.1.23" }

func (g *fakeGame) Catalog(context.Context) (factorio.Catalog, error) {
	return factorio.Catalog{FactorioVersion: "2.1.23", Planets: []factorio.Planet{{Name: "nauvis"}}}, g.err
}

func (g *fakeGame) Preview(_ context.Context, request factorio.PreviewRequest) (factorio.Preview, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.previews = append(g.previews, request)
	if g.err != nil {
		return factorio.Preview{}, g.err
	}
	seed := uint32(999)
	if request.Seed != nil {
		seed = *request.Seed
	}
	return factorio.Preview{PNG: []byte("\x89PNG fake"), Seed: seed, Quantities: []factorio.Quantity{{Name: "iron-ore", Count: 1, Richness: 2}}}, nil
}

func (g *fakeGame) Create(_ context.Context, settings worlds.Settings, seed *uint32, _ int) (factorio.Created, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.creates = append(g.creates, settings)
	g.seeds = append(g.seeds, seed)
	if g.err != nil {
		return factorio.Created{}, g.err
	}
	if err := os.WriteFile(filepath.Join(g.out, "world.zip"), []byte("a new map"), 0o600); err != nil {
		return factorio.Created{}, err
	}
	return factorio.Created{SaveName: "world.zip", Preview: []byte("png"), Seed: *seed, Mods: []worlds.Mod{{Name: "base"}}}, nil
}

func (g *fakeGame) Out() string { return g.out }

type harness struct {
	server    *httptest.Server
	game      *fakeGame
	worldsDir string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{game: &fakeGame{out: t.TempDir()}, worldsDir: t.TempDir()}
	root, err := os.OpenRoot(h.worldsDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { root.Close() })
	agent := api.New(api.Options{
		Game:          h.game,
		Worlds:        worlds.NewStore(root),
		Token:         []byte(token),
		RunsPerMinute: 100,
		Logger:        slog.New(slog.DiscardHandler),
	})
	h.server = httptest.NewServer(agent.Handler())
	t.Cleanup(h.server.Close)
	return h
}

func (h *harness) do(t *testing.T, method, path, body string) (int, []byte) {
	t.Helper()
	request, err := http.NewRequest(method, h.server.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	return response.StatusCode, raw
}

func decode[T any](t *testing.T, raw []byte) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("%s: %v", raw, err)
	}
	return v
}

func TestEveryRouteButHealthzNeedsTheToken(t *testing.T) {
	h := newHarness(t)
	for _, path := range []string{"/v1/catalog", "/v1/worlds", "/v1/previews/x"} {
		response, err := http.Get(h.server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s: %d", path, response.StatusCode)
		}
	}
}

func TestPreviewDrawsASeedAndServesTheImage(t *testing.T) {
	h := newHarness(t)
	status, raw := h.do(t, "POST", "/v1/previews", `{"settings":{"mapGen":{"autoplace_controls":{"iron-ore":{"richness":2}}}},"size":512,"planet":"vulcanus","offset":{"x":10,"y":-5},"report":["iron-ore"]}`)
	if status != http.StatusOK {
		t.Fatalf("%d %s", status, raw)
	}
	answer := decode[struct {
		Preview struct {
			ID         string              `json:"id"`
			Seed       uint32              `json:"seed"`
			Quantities []factorio.Quantity `json:"quantities"`
		} `json:"preview"`
	}](t, raw)
	request := h.game.previews[0]
	if request.Seed == nil || *request.Seed != answer.Preview.Seed {
		t.Fatalf("seed: asked %v, answered %d", request.Seed, answer.Preview.Seed)
	}
	if request.Size != 512 || request.Planet != "vulcanus" || request.OffsetX != 10 || request.OffsetY != -5 {
		t.Fatalf("request = %+v", request)
	}

	status, png := h.do(t, "GET", "/v1/previews/"+answer.Preview.ID, "")
	if status != http.StatusOK || string(png) != "\x89PNG fake" {
		t.Fatalf("image: %d %q", status, png)
	}
	if status, _ := h.do(t, "GET", "/v1/previews/"+strings.Repeat("0", 32), ""); status != http.StatusNotFound {
		t.Fatalf("unknown preview: %d", status)
	}
}

// An exchange string carries its own seed: none is drawn for it.
func TestPreviewKeepsTheExchangeStringsSeed(t *testing.T) {
	h := newHarness(t)
	status, raw := h.do(t, "POST", "/v1/previews", `{"settings":{"exchangeString":">>>eNpjZGBk4GRgZWBlYGBm4GZgZmBn<<<"}}`)
	if status != http.StatusOK || h.game.previews[0].Seed != nil {
		t.Fatalf("%d %s, seed %v", status, raw, h.game.previews[0].Seed)
	}
}

func TestPreviewRefusals(t *testing.T) {
	h := newHarness(t)
	cases := map[string]string{
		"unknown member": `{"settings":{"mapGen":{"autoplace_controls":{},"seed":1}}}`,
		"size":           `{"size":300}`,
		"planet":         `{"planet":"../nauvis"}`,
		"offset":         `{"offset":{"x":2000000,"y":0}}`,
		"report":         `{"report":["--create"]}`,
		"range":          `{"settings":{"mapGen":{"autoplace_controls":{"coal":{"size":9}}}}}`,
		"exclusive":      `{"settings":{"exchangeString":">>>eNpjZGBk4GRgZWBlYGBm4GZgZmBn<<<","mapGen":{}}}`,
	}
	for name, body := range cases {
		if status, raw := h.do(t, "POST", "/v1/previews", body); status != http.StatusBadRequest {
			t.Errorf("%s: %d %s", name, status, raw)
		}
	}
	if len(h.game.previews) != 0 {
		t.Fatalf("the game ran for a refused request: %+v", h.game.previews)
	}
}

func TestTheGamesRefusalReachesTheCaller(t *testing.T) {
	h := newHarness(t)
	h.game.err = &factorio.Error{Message: `"nope" is not a valid autoplace control name.`}
	status, raw := h.do(t, "POST", "/v1/previews", `{"settings":{"mapGen":{"autoplace_controls":{"nope":{}}}}}`)
	answer := decode[struct {
		Code  string `json:"code"`
		Error string `json:"error"`
	}](t, raw)
	if status != http.StatusUnprocessableEntity || answer.Code != "factorio_refused" || !strings.Contains(answer.Error, "nope") {
		t.Fatalf("%d %s", status, raw)
	}

	h.game.err = factorio.ErrBusy
	if status, _ := h.do(t, "POST", "/v1/previews", `{}`); status != http.StatusConflict {
		t.Fatalf("busy: %d", status)
	}
}

func TestCreateListDownloadDelete(t *testing.T) {
	h := newHarness(t)
	status, raw := h.do(t, "POST", "/v1/worlds", `{"name":"Riche en fer","seed":42,"createdBy":"admin","settings":{"mapSettings":{"pollution":{"enabled":false}}}}`)
	if status != http.StatusCreated {
		t.Fatalf("%d %s", status, raw)
	}
	world := decode[struct {
		World worlds.Meta `json:"world"`
	}](t, raw).World
	if world.Name != "Riche en fer" || world.Seed != 42 || world.FactorioVersion != "2.1.23" || !world.Preview ||
		world.Settings.MapSettings == nil || len(world.Mods) != 1 {
		t.Fatalf("world = %+v", world)
	}
	// The game's output is moved into the library, not left in the work folder.
	if _, err := os.Stat(filepath.Join(h.game.out, "world.zip")); !os.IsNotExist(err) {
		t.Fatalf("work folder: %v", err)
	}

	status, raw = h.do(t, "GET", "/v1/worlds", "")
	list := decode[struct {
		Worlds          []worlds.Meta `json:"worlds"`
		FactorioVersion string        `json:"factorioVersion"`
	}](t, raw)
	if status != http.StatusOK || len(list.Worlds) != 1 || list.FactorioVersion != "2.1.23" {
		t.Fatalf("%d %s", status, raw)
	}

	if status, body := h.do(t, "GET", "/v1/worlds/"+world.ID+"/download", ""); status != http.StatusOK || string(body) != "a new map" {
		t.Fatalf("download: %d %q", status, body)
	}
	if status, body := h.do(t, "GET", "/v1/worlds/"+world.ID+"/preview", ""); status != http.StatusOK || string(body) != "png" {
		t.Fatalf("preview: %d %q", status, body)
	}
	if status, _ := h.do(t, "DELETE", "/v1/worlds/"+world.ID, ""); status != http.StatusOK {
		t.Fatalf("delete: %d", status)
	}
	if status, _ := h.do(t, "GET", "/v1/worlds/"+world.ID+"/download", ""); status != http.StatusNotFound {
		t.Fatalf("after delete: %d", status)
	}
}

func TestCreateRefusals(t *testing.T) {
	h := newHarness(t)
	for name, body := range map[string]string{
		"no name":    `{"settings":{}}`,
		"long name":  `{"name":"` + strings.Repeat("x", 61) + `"}`,
		"bad values": `{"name":"x","settings":{"mapSettings":{"enemy_expansion":{"max_expansion_distance":99}}}}`,
	} {
		if status, raw := h.do(t, "POST", "/v1/worlds", body); status != http.StatusBadRequest {
			t.Errorf("%s: %d %s", name, status, raw)
		}
	}
	if len(h.game.creates) != 0 {
		t.Fatal("the game ran for a refused request")
	}
}

func TestUnknownRoutesAndIDs(t *testing.T) {
	h := newHarness(t)
	for _, path := range []string{"/v1/worlds/../../etc/download", "/v1/exec", "/v1/worlds/x/download"} {
		if status, _ := h.do(t, "GET", path, ""); status != http.StatusNotFound {
			t.Errorf("%s: %d", path, status)
		}
	}
}
