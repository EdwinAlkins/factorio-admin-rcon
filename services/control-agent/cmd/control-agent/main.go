// Command control-agent is the only component of the stack that holds the
// Docker socket. It exposes a closed list of operations on the Factorio
// container — status, stats, logs, start, stop, restart — to the admin panel,
// over a private network, behind a shared token.
//
// Run with `-healthcheck` to probe a running agent: the distroless image has
// no shell and no curl, so the binary doubles as its own healthcheck.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/control-agent/internal/api"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/control-agent/internal/config"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/control-agent/internal/docker"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/control-agent/internal/target"
)

func main() {
	healthcheck := flag.Bool("healthcheck", false, "probe the local agent's /healthz and exit")
	flag.Parse()

	if *healthcheck {
		os.Exit(probe())
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

	var level slog.Level
	if err := level.UnmarshalText([]byte(cfg.LogLevel)); err != nil {
		return err
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(logger)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	client := docker.New(cfg.DockerSocket, cfg.DockerAPIVersion)

	project := cfg.TargetProject
	if project == "" {
		project = discoverProject(ctx, client, logger)
	}
	resolver := target.NewResolver(client, project, cfg.TargetService)

	server := &http.Server{
		Addr: cfg.ListenAddr,
		Handler: api.New(api.Options{
			Docker:             client,
			Target:             resolver,
			Token:              cfg.Token,
			StopTimeout:        cfg.StopTimeout,
			MutationsPerMinute: cfg.MutationsPerMinute,
			Logger:             logger,
		}).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		// A stop may legitimately last the full grace period plus the daemon's
		// own margin before the response is written.
		WriteTimeout:        config.MaxStopTimeout + time.Minute,
		IdleTimeout:         60 * time.Second,
		MaxHeaderBytes:      8 << 10,
		MaxHeaderValueCount: 64,
		ErrorLog:            slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}

	logger.Info("control agent listening",
		"addr", cfg.ListenAddr,
		"target", resolver.Describe(),
		"dockerApi", cfg.DockerAPIVersion,
	)

	serveErr := make(chan error, 1)
	go func() { serveErr <- server.ListenAndServe() }()

	select {
	case err := <-serveErr:
		return err
	case <-ctx.Done():
	}

	logger.Info("control agent stopping")
	// Long enough for an in-flight stop to report its outcome: abandoning it
	// would leave the panel without an answer while the daemon carries on.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	if err := <-serveErr; !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
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

func probe() int {
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = ":8080"
	}

	// Parsed to an integer so the probe can only ever target a loopback port.
	_, rawPort, err := net.SplitHostPort(addr)
	port, convErr := strconv.Atoi(rawPort)
	if err != nil || convErr != nil || port < 1 || port > 65535 {
		fmt.Fprintln(os.Stderr, "LISTEN_ADDR: invalid port in", addr)
		return 1
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("http://127.0.0.1:%d/healthz", port), nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "healthz:", response.Status)
		return 1
	}
	return 0
}
