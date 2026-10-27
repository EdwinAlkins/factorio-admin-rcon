// Command control-agent is the only component of the stack that holds the
// Docker socket. It exposes a closed list of operations on the Factorio
// container — status, stats, logs, start, stop, restart — to the admin panel,
// over a private network, behind a shared token.
//
// Run with `-healthcheck` to probe a running agent (see agentkit.Probe).
package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/agentkit"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/control/api"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/control/config"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/docker"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/target"
)

func main() {
	healthcheck := flag.Bool("healthcheck", false, "probe the local agent's /healthz and exit")
	flag.Parse()

	if *healthcheck {
		os.Exit(agentkit.Probe())
	}

	if err := run(); err != nil {
		slog.Error("control agent stopped", "error", err)
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

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	client := docker.New(cfg.DockerSocket, cfg.DockerAPIVersion)

	project := cfg.TargetProject
	if project == "" {
		project = discoverProject(ctx, client, logger)
	}
	resolver := target.NewResolver(client, project, cfg.TargetService)

	handler := api.New(api.Options{
		Docker:             client,
		Target:             resolver,
		Token:              cfg.Token,
		StopTimeout:        cfg.StopTimeout,
		MutationsPerMinute: cfg.MutationsPerMinute,
		Logger:             logger,
	}).Handler()

	logger.Info("control agent listening",
		"addr", cfg.ListenAddr,
		"target", resolver.Describe(),
		"dockerApi", cfg.DockerAPIVersion,
	)

	// A stop may legitimately last the full grace period plus the daemon's own
	// margin before the response is written.
	return agentkit.Serve(ctx, cfg.ListenAddr, handler, config.MaxStopTimeout+time.Minute, logger)
}

// discoverProject pins the target to the agent's own Compose project. Without
// it, a second stack on the same host running a "factorio" service would make
// the target ambiguous — refused, never guessed, but still an outage.
func discoverProject(ctx context.Context, client *docker.Client, logger *slog.Logger) string {
	hostname, err := os.Hostname()
	if err == nil {
		lookup, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()

		var project string
		project, err = target.OwnProject(lookup, client, hostname)
		if err == nil {
			return project
		}
	}

	logger.Warn("compose project not found, matching on the service label only; set TARGET_PROJECT to pin it",
		"error", err)
	return ""
}
