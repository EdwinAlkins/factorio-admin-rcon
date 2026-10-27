// Package api is the agent's HTTP surface: a fixed list of Factorio-specific
// operations, and nothing that maps onto the Docker API generically.
package api

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json/v2"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/control-agent/internal/docker"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/control-agent/internal/target"
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
	tokenDigest [sha256.Size]byte
	stopTimeout time.Duration
	limiter     *limiter
	log         *slog.Logger

	// Held for the whole duration of a start, stop or restart. A second
	// mutation is refused (409) rather than queued: queuing "stop" behind
	// "start" would replay an intent the operator may no longer have.
	busy sync.Mutex
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
		tokenDigest: sha256.Sum256(options.Token),
		stopTimeout: options.StopTimeout,
		limiter:     newLimiter(options.MutationsPerMinute, time.Minute),
		log:         options.Logger,
	}
}

// Handler returns the agent's full routing table. Anything not listed — other
// paths, other methods, `/containers/...`, `/exec` — falls through to the
// catch-all and gets a 404 without the daemon ever being contacted.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", s.healthz)
	mux.HandleFunc("GET /v1/server/status", s.status)
	mux.HandleFunc("GET /v1/server/stats", s.stats)
	mux.HandleFunc("GET /v1/server/logs", s.logs)
	mux.HandleFunc("POST /v1/server/start", s.mutation(s.start))
	mux.HandleFunc("POST /v1/server/stop", s.mutation(s.stop))
	mux.HandleFunc("POST /v1/server/restart", s.mutation(s.restart))
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "unknown operation")
	})

	return s.logRequests(s.authenticate(mux))
}

// authenticate guards everything but the liveness probe. It runs before
// routing, so an unauthenticated caller cannot even map which paths exist.
func (s *Server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}

		presented, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		// Comparing digests keeps the comparison constant-time even when the
		// lengths differ, which a direct ConstantTimeCompare would leak.
		digest := sha256.Sum256([]byte(presented))
		if !ok || subtle.ConstantTimeCompare(digest[:], s.tokenDigest[:]) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeError(w, http.StatusUnauthorized, "unauthorized", "missing or invalid token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// mutation wraps start/stop/restart with the checks they share: the rate
// limit, then the exclusive lock.
func (s *Server) mutation(handle func(http.ResponseWriter, *http.Request)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if allowed, retryAfter := s.limiter.allow(); !allowed {
			w.Header().Set("Retry-After", strconv.Itoa(int(retryAfter.Seconds())+1))
			writeError(w, http.StatusTooManyRequests, "rate_limited", "too many operations, retry later")
			return
		}

		if !s.busy.TryLock() {
			writeError(w, http.StatusConflict, "busy", "another operation is in progress")
			return
		}
		defer s.busy.Unlock()

		handle(w, r)
	}
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

// logRequests writes one line per request. Successful reads — the
// healthcheck, and the panel polling status and stats — are logged at debug
// level only: at one every few seconds they would bury the lines that matter,
// mutations and failures.
func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(recorder, r)

		level := slog.LevelInfo
		switch {
		case recorder.status >= 500:
			level = slog.LevelError
		case recorder.status >= 400:
			level = slog.LevelWarn
		case r.Method == http.MethodGet:
			level = slog.LevelDebug
		}
		s.log.LogAttrs(r.Context(), level, "request",
			slog.String("method", r.Method),
			slog.String("path", r.URL.Path),
			slog.Int("status", recorder.status),
			slog.Duration("duration", time.Since(started)),
		)
	})
}

// fail maps an internal error to a response. The daemon's own message goes
// to the agent's log, not to the caller.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, target.ErrMissing), errors.Is(err, docker.ErrNotFound):
		writeError(w, http.StatusServiceUnavailable, "target_missing", "the Factorio container does not exist")
	case errors.Is(err, target.ErrAmbiguous):
		writeError(w, http.StatusServiceUnavailable, "target_ambiguous", "several containers match the Factorio service")
	case errors.Is(err, context.DeadlineExceeded):
		writeError(w, http.StatusGatewayTimeout, "docker_timeout", "the Docker daemon did not answer in time")
	default:
		writeError(w, http.StatusBadGateway, "docker_error", "the Docker daemon refused or failed the operation")
	}
	s.log.LogAttrs(r.Context(), slog.LevelWarn, "operation failed",
		slog.String("path", r.URL.Path),
		slog.String("error", err.Error()),
	)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	header := w.Header()
	header.Set("Content-Type", "application/json")
	header.Set("Cache-Control", "no-store")
	header.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.MarshalWrite(w, body)
}

type errorBody struct {
	OK    bool   `json:"ok"`
	Code  string `json:"code"`
	Error string `json:"error"`
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorBody{OK: false, Code: code, Error: message})
}
