// Package config reads and validates the world agent's environment, once, at
// startup.
package config

import (
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/agentkit"
)

type Config struct {
	ListenAddr string
	Token      []byte
	// The library of generated worlds: the only folder this agent writes
	// outside its work folder.
	WorldsDir string
	// The server's mods, read-only: previews and maps use the server's set.
	// Optional: missing means the game's own mods only.
	ModsDir string
	// The game, as installed in the image the agent is built on.
	FactorioBinary  string
	FactorioDataDir string
	// Private and writable (a tmpfs in Compose): the game's write-data,
	// settings files, previews and maps until they are published.
	WorkDir string
	// Bound on one run of the game, after which it is killed.
	RunTimeout time.Duration
	// Previews and new maps per minute, all callers together: each keeps a
	// CPU busy for a second or more.
	RunsPerMinute int
	LogLevel      string
}

func Load(lookup func(string) (string, bool)) (Config, error) {
	get := agentkit.Env(lookup)

	cfg := Config{
		ListenAddr:      get("LISTEN_ADDR", ":8080"),
		WorldsDir:       get("WORLDS_DIR", "/worlds"),
		ModsDir:         get("MODS_DIR", "/factorio/mods"),
		FactorioBinary:  get("FACTORIO_BINARY", "/opt/factorio/bin/x64/factorio"),
		FactorioDataDir: get("FACTORIO_DATA_DIR", "/opt/factorio/data"),
		WorkDir:         get("WORK_DIR", "/tmp/world-agent"),
		LogLevel:        get("LOG_LEVEL", "info"),
	}

	var errs []error
	if err := agentkit.CheckLogLevel(cfg.LogLevel); err != nil {
		errs = append(errs, err)
	}

	token, err := agentkit.ReadToken(get, "WORLD_AGENT")
	if err != nil {
		errs = append(errs, err)
	}
	cfg.Token = token

	seconds, err := strconv.Atoi(get("RUN_TIMEOUT_SECONDS", "180"))
	if err != nil || seconds < 10 || seconds > 1800 {
		errs = append(errs, errors.New("RUN_TIMEOUT_SECONDS: must be an integer between 10 and 1800"))
	}
	cfg.RunTimeout = time.Duration(seconds) * time.Second

	cfg.RunsPerMinute, err = strconv.Atoi(get("RUNS_PER_MINUTE", "30"))
	if err != nil || cfg.RunsPerMinute < 1 {
		errs = append(errs, errors.New("RUNS_PER_MINUTE: must be a positive integer"))
	}

	if err := errors.Join(errs...); err != nil {
		return Config{}, fmt.Errorf("invalid configuration: %w", err)
	}
	return cfg, nil
}
