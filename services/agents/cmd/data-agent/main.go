// Command data-agent is the only component of the stack that writes the
// game's files: it archives saves, restores them and (phase 4) manages mods.
// It never sees the Docker socket — stopping the server around a restore is
// the panel's job, through the control agent.
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
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/saves"
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

	handler := api.New(api.Options{
		Store:              saves.NewStore(savesRoot, backupsRoot, modsRoot),
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
