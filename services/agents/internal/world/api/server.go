// Package api is the world agent's HTTP surface: the catalogue the panel's
// form is built from, terrain previews, and the library of generated worlds.
// No route takes a path, a URL or a command line: worlds and previews are
// named by ids this agent generated, settings are validated structures the
// agent writes out itself.
package api

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/agentkit"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/factorio"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/worlds"
)

// Game is what the API needs from the game; *factorio.Runner in production.
type Game interface {
	Version() string
	Catalog(ctx context.Context) (factorio.Catalog, error)
	Preview(ctx context.Context, request factorio.PreviewRequest) (factorio.Preview, error)
	Create(ctx context.Context, settings worlds.Settings, seed *uint32, previewSize int) (factorio.Created, error)
	Out() string
}

type Options struct {
	Game   Game
	Worlds *worlds.Store
	Token  []byte
	// Previews and new maps per minute, all callers together.
	RunsPerMinute int
	Logger        *slog.Logger
}

type Server struct {
	game     Game
	worlds   *worlds.Store
	token    []byte
	runs     *agentkit.Limiter
	guard    *agentkit.Guard
	previews *previewCache
	log      *slog.Logger
}

// Bodies carry a world's settings: a few KB, an exchange string at most 64 KB.
const maxBodyBytes = 128 << 10

// Sizes of a preview, in pixels: the game's dialog uses 1024.
var previewSizes = []int{256, 512, 1024, 2048}

// The size of a world's own preview, kept in the library.
const libraryPreviewSize = 1024

// Bounds of the preview cache: a 2048 px image weighs a few MB.
const (
	maxPreviews     = 16
	maxPreviewBytes = 64 << 20
)

var (
	previewID     = regexp.MustCompile(`^[0-9a-f]{32}$`)
	prototypeName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
)

func New(options Options) *Server {
	return &Server{
		game:     options.Game,
		worlds:   options.Worlds,
		token:    options.Token,
		runs:     agentkit.NewLimiter(options.RunsPerMinute, time.Minute),
		guard:    agentkit.NewGuard(options.RunsPerMinute),
		previews: &previewCache{},
		log:      options.Logger,
	}
}

// Handler returns the agent's full routing table; anything else is a 404.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", agentkit.Healthz)
	mux.HandleFunc("GET /v1/catalog", s.catalog)
	mux.HandleFunc("POST /v1/previews", s.limited(s.preview))
	mux.HandleFunc("GET /v1/previews/{id}", s.previewImage)
	mux.HandleFunc("GET /v1/worlds", s.list)
	mux.HandleFunc("POST /v1/worlds", s.guard.Wrap(s.create))
	mux.HandleFunc("GET /v1/worlds/{id}/preview", s.worldPreview)
	mux.HandleFunc("GET /v1/worlds/{id}/download", s.download)
	mux.HandleFunc("DELETE /v1/worlds/{id}", s.guard.Wrap(s.delete))
	mux.HandleFunc("/", agentkit.NotFound)

	return agentkit.LogRequests(s.log, agentkit.Authenticate(s.token, mux))
}

// limited bounds how often previews run. They are not under the mutation
// guard: they write nothing lasting, and the game itself runs one at a time.
func (s *Server) limited(handle http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if allowed, retryAfter := s.runs.Allow(); !allowed {
			w.Header().Set("Retry-After", strconv.Itoa(int(retryAfter.Seconds())+1))
			agentkit.WriteError(w, http.StatusTooManyRequests, "rate_limited", "too many previews, retry later")
			return
		}
		handle(w, r)
	}
}

// fail maps an error to a response. The game's own refusal is passed on: it
// names what is wrong ("\"nope\" is not a valid autoplace control name.").
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	var refused *factorio.Error
	switch {
	case errors.Is(err, factorio.ErrBusy):
		agentkit.WriteError(w, http.StatusConflict, "busy", "the game is already generating")
		return
	case errors.Is(err, factorio.ErrTimeout):
		agentkit.WriteError(w, http.StatusGatewayTimeout, "factorio_timeout", "the game did not finish in time")
	case errors.As(err, &refused):
		agentkit.WriteError(w, http.StatusUnprocessableEntity, "factorio_refused", refused.Message)
	case errors.Is(err, worlds.ErrNotFound):
		agentkit.WriteError(w, http.StatusNotFound, "world_not_found", "no such world")
		return
	case errors.Is(err, worlds.ErrInvalidSettings):
		agentkit.WriteError(w, http.StatusBadRequest, "invalid_world_settings", err.Error())
	default:
		agentkit.WriteError(w, http.StatusInternalServerError, "io_error", "the operation failed")
	}
	s.log.LogAttrs(r.Context(), slog.LevelWarn, "operation failed",
		slog.String("path", r.URL.Path),
		slog.String("error", err.Error()),
	)
}

type catalogResponse struct {
	OK      bool             `json:"ok"`
	Catalog factorio.Catalog `json:"catalog"`
}

func (s *Server) catalog(w http.ResponseWriter, r *http.Request) {
	catalog, err := s.game.Catalog(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	agentkit.WriteJSON(w, http.StatusOK, catalogResponse{OK: true, Catalog: catalog})
}

type offset struct {
	X int `json:"x"`
	Y int `json:"y"`
}

type previewBody struct {
	Settings worlds.Settings `json:"settings"`
	// Absent: random, or the exchange string's.
	Seed   *uint32  `json:"seed"`
	Size   int      `json:"size"`
	Planet string   `json:"planet"`
	Offset offset   `json:"offset"`
	Report []string `json:"report"`
}

type previewDto struct {
	ID         string              `json:"id"`
	Seed       uint32              `json:"seed"`
	Size       int                 `json:"size"`
	Planet     string              `json:"planet"`
	Quantities []factorio.Quantity `json:"quantities"`
}

type previewResponse struct {
	OK      bool       `json:"ok"`
	Preview previewDto `json:"preview"`
}

func (s *Server) preview(w http.ResponseWriter, r *http.Request) {
	var body previewBody
	if err := agentkit.ReadBody(w, r, &body, maxBodyBytes); err != nil {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", err.Error())
		return
	}
	if body.Size == 0 {
		body.Size = libraryPreviewSize
	}
	if body.Planet == "" {
		body.Planet = "nauvis"
	}
	switch {
	case !slices.Contains(previewSizes, body.Size):
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", "size: one of 256, 512, 1024, 2048")
		return
	case !prototypeName.MatchString(body.Planet):
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", "planet: invalid name")
		return
	case abs(body.Offset.X) > 1_000_000 || abs(body.Offset.Y) > 1_000_000:
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", "offset: within a million tiles of the spawn")
		return
	case len(body.Report) > 16 || slices.ContainsFunc(body.Report, func(name string) bool { return !prototypeName.MatchString(name) }):
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", "report: at most 16 prototype names")
		return
	}
	if err := body.Settings.Validate(); err != nil {
		s.fail(w, r, err)
		return
	}
	// A random seed is drawn here rather than by the game, so that it does
	// not depend on how the game seeds itself.
	if body.Seed == nil && body.Settings.ExchangeString == "" {
		seed := randomSeed()
		body.Seed = &seed
	}

	preview, err := s.game.Preview(r.Context(), factorio.PreviewRequest{
		Settings: body.Settings,
		Seed:     body.Seed,
		Size:     body.Size,
		Planet:   body.Planet,
		OffsetX:  body.Offset.X,
		OffsetY:  body.Offset.Y,
		Report:   body.Report,
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	id := s.previews.add(preview.PNG)
	agentkit.WriteJSON(w, http.StatusOK, previewResponse{OK: true, Preview: previewDto{
		ID: id, Seed: preview.Seed, Size: body.Size, Planet: body.Planet, Quantities: preview.Quantities,
	}})
}

func (s *Server) previewImage(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	png, ok := s.previews.get(id)
	if !previewID.MatchString(id) || !ok {
		agentkit.WriteError(w, http.StatusNotFound, "preview_not_found", "no such preview (they are kept briefly)")
		return
	}
	writePNG(w, png)
}

type worldsResponse struct {
	OK              bool          `json:"ok"`
	Worlds          []worlds.Meta `json:"worlds"`
	FactorioVersion string        `json:"factorioVersion"`
}

func (s *Server) list(w http.ResponseWriter, r *http.Request) {
	list, err := s.worlds.List()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	agentkit.WriteJSON(w, http.StatusOK, worldsResponse{OK: true, Worlds: list, FactorioVersion: s.game.Version()})
}

type createBody struct {
	Name      string          `json:"name"`
	Settings  worlds.Settings `json:"settings"`
	Seed      *uint32         `json:"seed"`
	CreatedBy string          `json:"createdBy"`
}

type worldResponse struct {
	OK    bool        `json:"ok"`
	World worlds.Meta `json:"world"`
}

func (s *Server) create(w http.ResponseWriter, r *http.Request) {
	var body createBody
	if err := agentkit.ReadBody(w, r, &body, maxBodyBytes); err != nil {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", err.Error())
		return
	}
	if !worlds.ValidName(body.Name) {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", "name: 1 to 60 printable characters")
		return
	}
	if len(body.CreatedBy) > 100 {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", "createdBy: too long")
		return
	}
	if err := body.Settings.Validate(); err != nil {
		s.fail(w, r, err)
		return
	}
	if body.Seed == nil && body.Settings.ExchangeString == "" {
		seed := randomSeed()
		body.Seed = &seed
	}

	created, err := s.game.Create(r.Context(), body.Settings, body.Seed, libraryPreviewSize)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	id, err := s.worlds.NewID()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	out, err := os.OpenRoot(s.game.Out())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	defer out.Close()
	meta, err := s.worlds.Publish(out, created.SaveName, created.Preview, worlds.Meta{
		ID:              id,
		Name:            body.Name,
		Seed:            created.Seed,
		CreatedBy:       body.CreatedBy,
		Settings:        body.Settings,
		FactorioVersion: s.game.Version(),
		Mods:            created.Mods,
	})
	_ = out.Remove(created.SaveName)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.log.InfoContext(r.Context(), "world created", "id", meta.ID, "seed", meta.Seed, "size", meta.Size)
	agentkit.WriteJSON(w, http.StatusCreated, worldResponse{OK: true, World: meta})
}

func (s *Server) worldPreview(w http.ResponseWriter, r *http.Request) {
	f, _, err := s.worlds.OpenPreview(r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, "", time.Time{}, f)
}

// download streams a world's save, with Range support, for the operator to
// keep or load elsewhere.
func (s *Server) download(w http.ResponseWriter, r *http.Request) {
	f, meta, err := s.worlds.Open(r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("X-Content-SHA256", meta.SHA256)
	http.ServeContent(w, r, meta.ID+".zip", meta.CreatedAt, f)
}

func (s *Server) delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.worlds.Delete(id); err != nil {
		s.fail(w, r, err)
		return
	}
	s.log.InfoContext(r.Context(), "world deleted", "id", id)
	agentkit.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func writePNG(w http.ResponseWriter, png []byte) {
	header := w.Header()
	header.Set("Content-Type", "image/png")
	header.Set("Cache-Control", "no-store")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Content-Length", strconv.Itoa(len(png)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(png)
}

func randomSeed() uint32 {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return binary.LittleEndian.Uint32(b[:])
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// previewCache keeps the latest previews in memory for the panel to fetch:
// the image is asked for by an <img>, after the JSON answer.
type previewCache struct {
	mu      sync.Mutex
	entries []previewEntry
}

type previewEntry struct {
	id  string
	png []byte
}

func (c *previewCache) add(png []byte) string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	id := hex.EncodeToString(b[:])

	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = append(c.entries, previewEntry{id: id, png: png})
	total := 0
	for i := len(c.entries) - 1; i >= 0; i-- {
		total += len(c.entries[i].png)
		if len(c.entries)-i > maxPreviews || total > maxPreviewBytes {
			c.entries = c.entries[i+1:]
			break
		}
	}
	return id
}

func (c *previewCache) get(id string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, entry := range c.entries {
		if entry.id == id {
			return entry.png, true
		}
	}
	return nil, false
}
