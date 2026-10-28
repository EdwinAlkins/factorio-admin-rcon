// Command world-agent generates Factorio worlds: terrain previews, new maps,
// and the catalogue of presets and resources the panel's form is built from.
// It runs the game's own binary, from the image it is built on, with
// arguments it builds itself. It holds neither the Docker socket nor the
// server's saves: it writes only its library of worlds and a private work
// folder, and reads the server's mods. Putting a world in play is the data
// agent's job (it archives the world, then restores it like any archive).
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
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/factorio"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/files"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/world/api"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/world/config"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/worlds"
)

func main() {
	healthcheck := flag.Bool("healthcheck", false, "probe the local agent's /healthz and exit")
	flag.Parse()

	if *healthcheck {
		os.Exit(agentkit.Probe())
	}

	if err := run(); err != nil {
		slog.Error("world agent stopped", "error", err)
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

	worldsRoot, err := os.OpenRoot(cfg.WorldsDir)
	if err != nil {
		return fmt.Errorf("worlds directory: %w", err)
	}
	// Checked now rather than at the first world: a host directory created
	// by root is the usual culprit.
	if err := files.CheckWritable(worldsRoot); err != nil {
		return fmt.Errorf("worlds directory %s is not writable by uid %d (chown it to the Factorio uid, 845): %w",
			cfg.WorldsDir, os.Getuid(), err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	game, err := factorio.New(ctx, factorio.Options{
		Binary:  cfg.FactorioBinary,
		DataDir: cfg.FactorioDataDir,
		WorkDir: cfg.WorkDir,
		ModsDir: cfg.ModsDir,
		Timeout: cfg.RunTimeout,
	})
	if err != nil {
		return err
	}

	handler := api.New(api.Options{
		Game:          game,
		Worlds:        worlds.NewStore(worldsRoot),
		Token:         cfg.Token,
		RunsPerMinute: cfg.RunsPerMinute,
		Logger:        logger,
	}).Handler()

	logger.Info("world agent listening",
		"addr", cfg.ListenAddr,
		"factorio", game.Version(),
		"worlds", cfg.WorldsDir,
		"mods", cfg.ModsDir,
	)

	// The longest answer is a new map: one run for its preview, one for the
	// map, each bounded by the run timeout. Downloads of a fresh map are small.
	return agentkit.Serve(ctx, cfg.ListenAddr, handler, 2*cfg.RunTimeout+time.Minute, logger)
}
