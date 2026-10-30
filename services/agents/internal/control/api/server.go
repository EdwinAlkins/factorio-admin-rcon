// Package api is the agent's HTTP surface: a fixed list of Factorio-specific
// operations, and nothing that maps onto the Docker API generically.
package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/agentkit"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/docker"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/target"
)

// Docker is the part of the client the handlers use. Every method the agent
// can ever call on the daemon is listed here.
type Docker interface {
	Inspect(ctx context.Context, id string) (docker.Inspect, error)
	Stats(ctx context.Context, id string) (docker.Stats, error)
	Logs(ctx context.Context, id string, options docker.LogsOptions) ([]docker.Line, error)
	Start(ctx context.Context, id string) (bool, error)
	Stop(ctx context.Context, id string, timeout time.Duration) (bool, error)
	Restart(ctx context.Context, id string, timeout time.Duration) error
}

type Options struct {
	Docker      Docker
	Target      *target.Resolver
	Token       []byte
	StopTimeout time.Duration
	// Mutations accepted per minute, all callers together.
	MutationsPerMinute int
	Logger             *slog.Logger
}

type Server struct {
	docker      Docker
	target      *target.Resolver
	token       []byte
	stopTimeout time.Duration
	guard       *agentkit.Guard
	log         *slog.Logger
}

// Deadline of a read against the daemon. A stats reading takes ~1 s (the
// daemon samples twice to compute the CPU delta), an inspect a few ms.
const readTimeout = 10 * time.Second

// Bodies are at most `{"timeoutSeconds": 300}`.
const maxBodyBytes = 1024

func New(options Options) *Server {
	return &Server{
		docker:      options.Docker,
		target:      options.Target,
		token:       options.Token,
		stopTimeout: options.StopTimeout,
		guard:       agentkit.NewGuard(options.MutationsPerMinute),
		log:         options.Logger,
	}
}

// Handler returns the agent's full routing table. Anything not listed — other
// paths, other methods, `/containers/...`, `/exec` — falls through to the
// catch-all and gets a 404 without the daemon ever being contacted.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", agentkit.Healthz)
	mux.HandleFunc("GET /v1/server/status", s.status)
	mux.HandleFunc("GET /v1/server/stats", s.stats)
	mux.HandleFunc("GET /v1/server/logs", s.logs)
	mux.HandleFunc("POST /v1/server/start", s.guard.Wrap(s.start))
	mux.HandleFunc("POST /v1/server/stop", s.guard.Wrap(s.stop))
	mux.HandleFunc("POST /v1/server/restart", s.guard.Wrap(s.restart))
	mux.HandleFunc("/", agentkit.NotFound)

	return agentkit.LogRequests(s.log, agentkit.Authenticate(s.token, mux))
}

// fail maps an internal error to a response. The daemon's own message goes
// to the agent's log, not to the caller.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, target.ErrMissing), errors.Is(err, docker.ErrNotFound):
		agentkit.WriteError(w, http.StatusServiceUnavailable, "target_missing", "the Factorio container does not exist")
	case errors.Is(err, target.ErrAmbiguous):
		agentkit.WriteError(w, http.StatusServiceUnavailable, "target_ambiguous", "several containers match the Factorio service")
	case errors.Is(err, context.DeadlineExceeded):
		agentkit.WriteError(w, http.StatusGatewayTimeout, "docker_timeout", "the Docker daemon did not answer in time")
	default:
		agentkit.WriteError(w, http.StatusBadGateway, "docker_error", "the Docker daemon refused or failed the operation")
	}
	s.log.LogAttrs(r.Context(), slog.LevelWarn, "operation failed",
		slog.String("path", r.URL.Path),
		slog.String("error", err.Error()),
	)
}
