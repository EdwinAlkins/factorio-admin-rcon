// Package factorio runs the game's own binary for the three things the world
// agent needs from it: a terrain preview, a new map, and the prototype data
// (presets, resources, planets) the panel builds its form from.
//
// The binary is only ever started with arguments built here — fixed options,
// numbers, file names of our own and validated prototype names — through
// exec, never a shell. One run at a time: a second caller gets ErrBusy rather
// than a queue. Everything the game writes goes to a work folder (a tmpfs in
// Compose); the mods folder is read-only, seen through links.
//
// Linked by the world agent only: see boundaries_test.go.
package factorio

import (
	"bytes"
	"context"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/worlds"
)

var (
	// ErrBusy: the binary is already running for another request.
	ErrBusy = errors.New("factorio is already running")
	// ErrTimeout: the run exceeded its deadline and was killed.
	ErrTimeout = errors.New("factorio did not finish in time")
)

// Error is a run the game refused; Message is its own first error line
// ("\"nope\" is not a valid autoplace control name.").
type Error struct{ Message string }

func (e *Error) Error() string { return "factorio: " + e.Message }

type Options struct {
	// The game's binary, and its data folder (map-settings.example.json).
	Binary  string
	DataDir string
	// Writable, private: config.ini, the game's write-data, outputs.
	WorkDir string
	// The server's mods, read-only. Empty or missing: the game's own mods only.
	ModsDir string
	Timeout time.Duration
	// Added to the binary's otherwise empty environment (tests).
	Env []string
}

type Runner struct {
	options Options
	config  string
	version string
	// Map settings the game ships, the base a world's own are merged into:
	// the game refuses a map-settings.json with a member missing.
	baseMapSettings map[string]any
	defaults        worlds.MapSettings

	// The single run slot: see acquire.
	mu sync.Mutex
	// The catalogue, cached per mod set; under its own lock, so a cached
	// answer never waits for (or is refused by) a run in progress.
	cacheMu sync.Mutex
	catalog *Catalog
	stamp   string
}

// Sub-folders of the work folder.
const (
	writeData = "factorio"
	outDir    = "out"
	modsLinks = "mods"
)

// Bound on what a run may print; the game's own log for a preview is a few KB.
const maxOutput = 4 << 20

// New prepares the work folder and reads the game's version and default map
// settings. It fails if the binary does not run.
func New(ctx context.Context, options Options) (*Runner, error) {
	for _, dir := range []string{writeData, outDir} {
		if err := os.MkdirAll(filepath.Join(options.WorkDir, dir), 0o700); err != nil {
			return nil, err
		}
	}
	r := &Runner{options: options, config: filepath.Join(options.WorkDir, "config.ini")}
	// read-data relative to the binary, as the game's own default; write-data
	// in the work folder, never the image's read-only tree.
	config := fmt.Sprintf("[path]\nread-data=__PATH__executable__/../../data\nwrite-data=%s\n",
		filepath.Join(options.WorkDir, writeData))
	if err := os.WriteFile(r.config, []byte(config), 0o600); err != nil {
		return nil, err
	}

	output, err := r.exec(ctx, "--version")
	if err != nil {
		return nil, fmt.Errorf("running %s: %w", options.Binary, err)
	}
	match := versionLine.FindStringSubmatch(output)
	if match == nil {
		return nil, fmt.Errorf("%s --version: no version in its output", options.Binary)
	}
	r.version = match[1]

	raw, err := os.ReadFile(filepath.Join(options.DataDir, "map-settings.example.json"))
	if err != nil {
		return nil, fmt.Errorf("default map settings: %w", err)
	}
	if err := json.Unmarshal(raw, &r.baseMapSettings); err != nil {
		return nil, fmt.Errorf("default map settings: %w", err)
	}
	dropComments(r.baseMapSettings)
	if err := json.Unmarshal(raw, &r.defaults); err != nil {
		return nil, fmt.Errorf("default map settings: %w", err)
	}
	return r, nil
}

// Version is the game's, as `2.1.23`.
func (r *Runner) Version() string { return r.version }

var (
	versionLine = regexp.MustCompile(`(?m)^Version: ([0-9]+\.[0-9]+\.[0-9]+)`)
	errorLine   = regexp.MustCompile(`(?m)^\s*[0-9.]+ Error [^:]+:[0-9]+: (.+)$`)
	modLine     = regexp.MustCompile(`(?m)^\s*[0-9.]+ Loading mod (\S+) ([0-9]+\.[0-9]+\.[0-9]+) \(data\.lua\)$`)
	seedLine    = regexp.MustCompile(`(?m)Generating map preview: seed=([0-9]+)`)
	// `iron-ore: totalEntityCount=849, totalRichness=431184, …`
	quantityLine = regexp.MustCompile(`(?m)^\s*[0-9.]+ ([A-Za-z0-9_-]+): totalEntityCount=([0-9]+), totalRichness=([0-9]+)`)
)

// acquire takes the single run slot, or refuses.
func (r *Runner) acquire() (func(), error) {
	if !r.mu.TryLock() {
		return nil, ErrBusy
	}
	return r.mu.Unlock, nil
}

// exec runs the binary with the agent's config and returns what it printed.
func (r *Runner) exec(ctx context.Context, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, r.options.Timeout)
	defer cancel()

	// The binary is the operator's setting; every argument is built by this
	// package from fixed options, numbers, its own file names and validated
	// prototype names — and exec runs no shell.
	cmd := exec.CommandContext(ctx, r.options.Binary, append([]string{"--config", r.config}, args...)...) //nolint:gosec // G204: see above
	cmd.Dir = r.options.WorkDir
	cmd.Env = append([]string{"HOME=" + r.options.WorkDir}, r.options.Env...)
	var output limitedBuffer
	cmd.Stdout, cmd.Stderr = &output, &output
	cmd.WaitDelay = 5 * time.Second

	err := cmd.Run()
	text := output.String()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return text, ErrTimeout
	}
	if err != nil {
		if match := errorLine.FindStringSubmatch(text); match != nil {
			return text, &Error{Message: strings.TrimSpace(match[1])}
		}
		return text, &Error{Message: err.Error()}
	}
	return text, nil
}

// modArgs rebuilds the work folder's view of the server's mods: a link per
// archive or folder, and private copies of the two files the game rewrites at
// every start (mod-list.json, mod-settings.dat), so the read-only originals
// are never written to. Rebuilt at every run: the server's mods change.
func (r *Runner) modArgs() ([]string, error) {
	links := filepath.Join(r.options.WorkDir, modsLinks)
	if err := os.RemoveAll(links); err != nil {
		return nil, err
	}
	if err := os.Mkdir(links, 0o700); err != nil {
		return nil, err
	}
	args := []string{"--mod-directory", links}
	if r.options.ModsDir == "" {
		return args, nil
	}
	mods, err := os.OpenRoot(r.options.ModsDir)
	if errors.Is(err, fs.ErrNotExist) {
		return args, nil
	}
	if err != nil {
		return nil, err
	}
	defer mods.Close()
	view, err := os.OpenRoot(links)
	if err != nil {
		return nil, err
	}
	defer view.Close()

	entries, err := fs.ReadDir(mods.FS(), ".")
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		name := entry.Name()
		switch {
		case name == "mod-list.json" || name == "mod-settings.dat":
			raw, err := mods.ReadFile(name)
			if err != nil {
				return nil, err
			}
			if err := view.WriteFile(name, raw, 0o600); err != nil {
				return nil, err
			}
		case strings.HasPrefix(name, "."):
		default:
			// The link points into the read-only mount; the game follows it
			// to read the archive, never to write.
			if err := view.Symlink(filepath.Join(r.options.ModsDir, name), name); err != nil {
				return nil, err
			}
		}
	}
	return args, nil
}

// installed reports whether a mod is present in the mods folder as an archive
// or a folder; the others Factorio loaded ship with the game.
func (r *Runner) installed(name string) bool {
	if r.options.ModsDir == "" {
		return false
	}
	entries, err := os.ReadDir(r.options.ModsDir)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if entry.Name() == name || strings.HasPrefix(entry.Name(), name+"_") {
			return true
		}
	}
	return false
}

// loadedMods is the mod set as the game loaded it, from its own log.
func (r *Runner) loadedMods(output string) []worlds.Mod {
	seen := map[string]bool{}
	list := []worlds.Mod{}
	for _, match := range modLine.FindAllStringSubmatch(output, -1) {
		// `core` is the engine's own, never in mod-list.json.
		if seen[match[1]] || match[1] == "core" {
			continue
		}
		seen[match[1]] = true
		mod := worlds.Mod{Name: match[1]}
		if r.installed(match[1]) {
			mod.Version = match[2]
		}
		list = append(list, mod)
	}
	return list
}

// settingArgs writes a world's settings to files of the work folder and
// returns the options naming them. The map settings matter to a new map only:
// a preview shows terrain, which they do not change.
func (r *Runner) settingArgs(settings worlds.Settings, withMapSettings bool) ([]string, error) {
	if settings.ExchangeString != "" {
		return []string{"--exchange-string", settings.ExchangeString}, nil
	}
	var args []string
	if settings.MapGen != nil {
		raw, err := json.Marshal(settings.MapGen)
		if err != nil {
			return nil, err
		}
		path := filepath.Join(r.options.WorkDir, "map-gen-settings.json")
		if err := os.WriteFile(path, raw, 0o600); err != nil {
			return nil, err
		}
		args = append(args, "--map-gen-settings", path)
	}
	if withMapSettings && settings.MapSettings != nil {
		raw, err := mergeMapSettings(r.baseMapSettings, settings.MapSettings)
		if err != nil {
			return nil, err
		}
		path := filepath.Join(r.options.WorkDir, "map-settings.json")
		if err := os.WriteFile(path, raw, 0o600); err != nil {
			return nil, err
		}
		args = append(args, "--map-settings", path)
	}
	return args, nil
}

// PreviewRequest describes one preview image.
type PreviewRequest struct {
	Settings worlds.Settings
	// Nil: the exchange string's own seed, or a random one.
	Seed   *uint32
	Size   int
	Planet string
	// Centre of the image, in tiles from the spawn.
	OffsetX, OffsetY int
	// Resource entities to count in the area shown.
	Report []string
}

// Quantity is the game's estimate of one resource in the previewed area.
type Quantity struct {
	Name     string `json:"name"`
	Count    int64  `json:"count"`
	Richness int64  `json:"richness"`
}

type Preview struct {
	PNG        []byte
	Seed       uint32
	Quantities []Quantity
}

// Preview renders the terrain a seed and settings give, without creating a map.
func (r *Runner) Preview(ctx context.Context, request PreviewRequest) (Preview, error) {
	release, err := r.acquire()
	if err != nil {
		return Preview{}, err
	}
	defer release()
	return r.preview(ctx, request)
}

func (r *Runner) preview(ctx context.Context, request PreviewRequest) (Preview, error) {
	args, err := r.modArgs()
	if err != nil {
		return Preview{}, err
	}
	settingArgs, err := r.settingArgs(request.Settings, false)
	if err != nil {
		return Preview{}, err
	}
	image := filepath.Join(r.options.WorkDir, outDir, "preview.png")
	_ = os.Remove(image)
	args = append(args, settingArgs...)
	args = append(args,
		"--generate-map-preview", image,
		"--map-preview-size", strconv.Itoa(request.Size),
		"--map-preview-planet", request.Planet,
		"--map-preview-offset", fmt.Sprintf("%d,%d", request.OffsetX, request.OffsetY),
	)
	if request.Seed != nil {
		args = append(args, "--map-gen-seed", strconv.FormatUint(uint64(*request.Seed), 10))
	}
	if len(request.Report) > 0 {
		args = append(args, "--report-quantities", strings.Join(request.Report, ","))
	}

	output, err := r.exec(ctx, args...)
	if err != nil {
		return Preview{}, err
	}
	png, err := os.ReadFile(image) //nolint:gosec // G304: the agent's own work folder
	if err != nil {
		return Preview{}, &Error{Message: "no preview image was written"}
	}
	_ = os.Remove(image)

	result := Preview{PNG: png, Quantities: []Quantity{}}
	match := seedLine.FindStringSubmatch(output)
	if match == nil {
		return Preview{}, &Error{Message: "the preview did not report its seed"}
	}
	seed, err := strconv.ParseUint(match[1], 10, 32)
	if err != nil {
		return Preview{}, &Error{Message: "the preview reported an invalid seed"}
	}
	result.Seed = uint32(seed)
	for _, match := range quantityLine.FindAllStringSubmatch(output, -1) {
		count, _ := strconv.ParseInt(match[2], 10, 64)
		richness, _ := strconv.ParseInt(match[3], 10, 64)
		result.Quantities = append(result.Quantities, Quantity{Name: match[1], Count: count, Richness: richness})
	}
	return result, nil
}

// Created is a new map, in the work folder until the caller publishes it.
type Created struct {
	// Inside Out(): the save, and its preview.
	SaveName string
	Preview  []byte
	Seed     uint32
	Mods     []worlds.Mod
}

// Out is the folder Create writes to.
func (r *Runner) Out() string { return filepath.Join(r.options.WorkDir, outDir) }

// Create generates a new map with its preview. The preview comes first: it
// also tells the seed an exchange string carries, which the map is then
// created with explicitly, so the sidecar always records it.
func (r *Runner) Create(ctx context.Context, settings worlds.Settings, seed *uint32, previewSize int) (Created, error) {
	release, err := r.acquire()
	if err != nil {
		return Created{}, err
	}
	defer release()

	preview, err := r.preview(ctx, PreviewRequest{Settings: settings, Seed: seed, Size: previewSize, Planet: "nauvis"})
	if err != nil {
		return Created{}, err
	}

	args, err := r.modArgs()
	if err != nil {
		return Created{}, err
	}
	settingArgs, err := r.settingArgs(settings, true)
	if err != nil {
		return Created{}, err
	}
	const saveName = "world.zip"
	save := filepath.Join(r.Out(), saveName)
	_ = os.Remove(save)
	args = append(args, "--create", save)
	args = append(args, settingArgs...)
	args = append(args, "--map-gen-seed", strconv.FormatUint(uint64(preview.Seed), 10))

	output, err := r.exec(ctx, args...)
	if err != nil {
		return Created{}, err
	}
	if _, err := os.Stat(save); err != nil {
		return Created{}, &Error{Message: "no save was written"}
	}
	return Created{SaveName: saveName, Preview: preview.PNG, Seed: preview.Seed, Mods: r.loadedMods(output)}, nil
}

// limitedBuffer keeps the first maxOutput bytes a run prints and drops the
// rest, without failing the run.
type limitedBuffer struct{ bytes.Buffer }

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if room := maxOutput - b.Len(); room > 0 {
		b.Buffer.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}
