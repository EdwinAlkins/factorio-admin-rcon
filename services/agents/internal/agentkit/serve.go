package agentkit

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"
)

// NewLogger returns the JSON logger every agent writes to stdout.
func NewLogger(level string) (*slog.Logger, error) {
	var parsed slog.Level
	if err := parsed.UnmarshalText([]byte(level)); err != nil {
		return nil, err
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: parsed})), nil
}

// Serve runs `handler` on `addr` until ctx is cancelled, then shuts down
// gracefully. `writeTimeout` must cover the longest legitimate answer: a stop
// waits for Docker's grace period, a download streams a whole archive.
func Serve(ctx context.Context, addr string, handler http.Handler, writeTimeout time.Duration, log *slog.Logger) error {
	server := &http.Server{
		Addr:                addr,
		Handler:             handler,
		ReadHeaderTimeout:   5 * time.Second,
		ReadTimeout:         10 * time.Second,
		WriteTimeout:        writeTimeout,
		IdleTimeout:         60 * time.Second,
		MaxHeaderBytes:      8 << 10,
		MaxHeaderValueCount: 64,
		ErrorLog:            slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}

	serveErr := make(chan error, 1)
	go func() { serveErr <- server.ListenAndServe() }()

	select {
	case err := <-serveErr:
		return err
	case <-ctx.Done():
	}

	log.Info("agent stopping")
	// Long enough for an in-flight operation to report its outcome:
	// abandoning it would leave the panel without an answer while the work
	// carries on.
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

// Probe calls the local agent's /healthz and returns a process exit code.
// The distroless images have no shell and no curl, so each binary doubles as
// its own healthcheck (`-healthcheck`).
func Probe() int {
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
