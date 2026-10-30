// Command data-agent is the only component of the stack that writes the
// game's files: it archives saves, restores them and manages mods. It never
// sees the Docker socket — stopping the server around a restore or a mod
// change is the panel's job, through the control agent. It is also the only
// one that reaches the Internet, and only the official mod portal.
//
// Run with `-healthcheck` to probe a running agent (see agentkit.Probe).
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/agentkit"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/data/api"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/data/config"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/files"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/mods"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/portal"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/saves"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/serversettings"
)

func main() {
	healthcheck := flag.Bool("healthcheck", false, "probe the local agent's /healthz and exit")
	flag.Parse()

	if *healthcheck {
		os.Exit(agentkit.Probe())
	}

	if err := run(); err != nil {
		slog.Error("data agent stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load(os.LookupEnv)
	if err != nil {
		return err
	}

	logger, err := agentkit.NewLogger(cfg.LogLevel)
	if err != nil {
		return err
	}
	slog.SetDefault(logger)

	savesRoot, err := os.OpenRoot(cfg.SavesDir)
	if err != nil {
		return fmt.Errorf("saves directory: %w", err)
	}
	backupsRoot, err := os.OpenRoot(cfg.BackupsDir)
	if err != nil {
		return fmt.Errorf("backups directory: %w", err)
	}
	// Checked now rather than on the first backup, hours later: a host
	// directory created by root is the usual culprit.
	if err := files.CheckWritable(backupsRoot); err != nil {
		return fmt.Errorf("backups directory %s is not writable by uid %d (chown it to the Factorio uid, 845): %w",
			cfg.BackupsDir, os.Getuid(), err)
	}
	if err := files.CheckWritable(savesRoot); err != nil {
		return fmt.Errorf("saves directory %s is not writable by uid %d: %w", cfg.SavesDir, os.Getuid(), err)
	}

	// The mods folder is optional for archiving: without it, archives record
	// no mod set.
	modsRoot, err := os.OpenRoot(cfg.ModsDir)
	if err != nil {
		logger.Warn("mods directory unavailable; archives will not record the mod set", "error", err)
		modsRoot = nil
	}

	// Mod transactions (downloads, files set aside) live next to the
	// archives, out of Factorio's sight.
	if err := backupsRoot.MkdirAll(".mods", 0o750); err != nil {
		return fmt.Errorf("mods work directory: %w", err)
	}
	workRoot, err := backupsRoot.OpenRoot(".mods")
	if err != nil {
		return fmt.Errorf("mods work directory: %w", err)
	}
	credentials, err := portal.ReadCredentials(cfg.PortalCredentialsFile)
	if err != nil {
		return err
	}
	portalClient, err := portal.New(portal.Options{
		BaseURL:      portal.DefaultBaseURL,
		AllowedHosts: portal.DefaultHosts,
		Credentials:  credentials,
	})
	if err != nil {
		return err
	}
	if !portalClient.HasCredentials() {
		logger.Info("no mod portal credentials: searching and installing mods are off")
	}

	store := saves.NewStore(savesRoot, backupsRoot, modsRoot)
	// Also drops the chunks of an upload the previous run left unfinished.
	if err := store.EnableUploads(cfg.SavesMaxUploadBytes); err != nil {
		return fmt.Errorf("uploads work directory: %w", err)
	}

	settings, err := openSettings(cfg.ConfigDir, backupsRoot)
	if err != nil {
		logger.Warn("config folder unavailable; server settings cannot be edited", "error", err)
	}

	handler := api.New(api.Options{
		Store:              store,
		Mods:               mods.NewManager(cfg.ModsDir, workRoot, portalClient, cfg.ModsMaxDownloadBytes),
		Settings:           settings,
		Token:              cfg.Token,
		TargetSaveName:     cfg.TargetSaveName,
		MutationsPerMinute: cfg.MutationsPerMinute,
		Logger:             logger,
	}).Handler()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	logger.Info("data agent listening",
		"addr", cfg.ListenAddr,
		"saves", cfg.SavesDir,
		"backups", cfg.BackupsDir,
	)

	// A download streams a whole archive; large maps weigh hundreds of MB.
	return agentkit.Serve(ctx, cfg.ListenAddr, handler, 30*time.Minute, logger)
}

// openSettings opens Factorio's config folder for server-settings.json, with
// the previous versions kept next to the archives. A stack written before
// this feature does not mount the folder: that turns the feature off, not
// the agent.
func openSettings(configDir string, backupsRoot *os.Root) (*serversettings.Store, error) {
	configRoot, err := os.OpenRoot(configDir)
	if err != nil {
		return nil, err
	}
	if err := files.CheckWritable(configRoot); err != nil {
		return nil, fmt.Errorf("%s is not writable by uid %d: %w", configDir, os.Getuid(), err)
	}
	if err := backupsRoot.MkdirAll(".server-settings", 0o750); err != nil {
		return nil, err
	}
	historyRoot, err := backupsRoot.OpenRoot(".server-settings")
	if err != nil {
		return nil, err
	}
	return serversettings.New(configRoot, historyRoot), nil
}
