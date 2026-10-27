// Package config reads and validates the data agent's environment, once, at
// startup.
package config

import (
	"errors"
	"fmt"
	"strconv"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/agentkit"
)

type Config struct {
	ListenAddr string
	Token      []byte
	// Factorio's folders, as mounted in the agent's container.
	SavesDir string
	ModsDir  string
	// The panel's archives: a host directory distinct from the game's data,
	// so the operator can replicate it elsewhere.
	BackupsDir string
	// Name a restore writes the save under when the server loads a fixed
	// SAVE_NAME rather than the newest save. Empty: the archive's own name.
	TargetSaveName string
	// Mutations accepted per minute, all callers together.
	MutationsPerMinute int
	LogLevel           string
}

func Load(lookup func(string) (string, bool)) (Config, error) {
	get := agentkit.Env(lookup)

	cfg := Config{
		ListenAddr:     get("LISTEN_ADDR", ":8080"),
		SavesDir:       get("SAVES_DIR", "/factorio/saves"),
		ModsDir:        get("MODS_DIR", "/factorio/mods"),
		BackupsDir:     get("BACKUPS_DIR", "/backups"),
		TargetSaveName: get("TARGET_SAVE_NAME", ""),
		LogLevel:       get("LOG_LEVEL", "info"),
	}

	var errs []error
	if err := agentkit.CheckLogLevel(cfg.LogLevel); err != nil {
		errs = append(errs, err)
	}

	token, err := agentkit.ReadToken(get, "DATA_AGENT")
	if err != nil {
		errs = append(errs, err)
	}
	cfg.Token = token

	cfg.MutationsPerMinute, err = strconv.Atoi(get("MUTATIONS_PER_MINUTE", "30"))
	if err != nil || cfg.MutationsPerMinute < 1 {
		errs = append(errs, errors.New("MUTATIONS_PER_MINUTE: must be a positive integer"))
	}

	if err := errors.Join(errs...); err != nil {
		return Config{}, fmt.Errorf("invalid configuration: %w", err)
	}
	return cfg, nil
}
