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
	// Factorio's config folder, for server-settings.json. Optional: a stack
	// that does not mount it has no settings editing.
	ConfigDir string
	// The panel's archives: a host directory distinct from the game's data,
	// so the operator can replicate it elsewhere.
	BackupsDir string
	// Name a restore writes the save under when the server loads a fixed
	// SAVE_NAME rather than the newest save. Empty: the archive's own name.
	TargetSaveName string
	// Mutations accepted per minute, all callers together.
	MutationsPerMinute int
	// JSON {username, token} for the mod portal. Missing or empty: no
	// search, no install; the rest of the mods tab still works.
	PortalCredentialsFile string
	// Bound on one mod download.
	ModsMaxDownloadBytes int64
	// Bound on a save uploaded from the operator's computer.
	SavesMaxUploadBytes int64
	LogLevel            string
}

func Load(lookup func(string) (string, bool)) (Config, error) {
	get := agentkit.Env(lookup)

	cfg := Config{
		ListenAddr:     get("LISTEN_ADDR", ":8080"),
		SavesDir:       get("SAVES_DIR", "/factorio/saves"),
		ModsDir:        get("MODS_DIR", "/factorio/mods"),
		ConfigDir:      get("CONFIG_DIR", "/factorio/config"),
		BackupsDir:     get("BACKUPS_DIR", "/backups"),
		TargetSaveName: get("TARGET_SAVE_NAME", ""),
		LogLevel:       get("LOG_LEVEL", "info"),

		PortalCredentialsFile: get("PORTAL_CREDENTIALS_FILE", ""),
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

	maxMB, err := strconv.Atoi(get("MODS_MAX_DOWNLOAD_MB", "200"))
	if err != nil || maxMB < 1 || maxMB > 4096 {
		errs = append(errs, errors.New("MODS_MAX_DOWNLOAD_MB: must be an integer between 1 and 4096"))
	}
	cfg.ModsMaxDownloadBytes = int64(maxMB) << 20

	uploadMB, err := strconv.Atoi(get("SAVES_MAX_UPLOAD_MB", "2048"))
	if err != nil || uploadMB < 1 || uploadMB > 65536 {
		errs = append(errs, errors.New("SAVES_MAX_UPLOAD_MB: must be an integer between 1 and 65536"))
	}
	cfg.SavesMaxUploadBytes = int64(uploadMB) << 20

	if err := errors.Join(errs...); err != nil {
		return Config{}, fmt.Errorf("invalid configuration: %w", err)
	}
	return cfg, nil
}
