// Package agentkit holds what both agents share: bearer authentication,
// request logging, the mutation guard, strict JSON bodies and the JSON answer
// format. It must stay free of any Docker or filesystem code — see
// boundaries_test.go at the module root.
package agentkit

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// WriteJSON answers with `body`, never cached, never sniffed.
func WriteJSON(w http.ResponseWriter, status int, body any) {
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

// WriteError is the agents' single error format: `code` is stable and meant
// for the panel, `error` is an English hint for whoever reads the logs.
func WriteError(w http.ResponseWriter, status int, code, message string) {
	WriteJSON(w, status, errorBody{OK: false, Code: code, Error: message})
}

// Healthz is the liveness probe: no token, no I/O.
func Healthz(w http.ResponseWriter, _ *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// NotFound is the catch-all route. Anything not explicitly registered lands
// here, so an unknown operation never reaches the code behind the agent.
func NotFound(w http.ResponseWriter, _ *http.Request) {
	WriteError(w, http.StatusNotFound, "not_found", "unknown operation")
}

// Authenticate guards everything but the liveness probe. It runs before
// routing, so an unauthenticated caller cannot even map which paths exist.
func Authenticate(token []byte, next http.Handler) http.Handler {
	// Comparing digests keeps the comparison constant-time even when the
	// lengths differ, which a direct ConstantTimeCompare would leak.
	expected := sha256.Sum256(token)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}

		presented, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		digest := sha256.Sum256([]byte(presented))
		if !ok || subtle.ConstantTimeCompare(digest[:], expected[:]) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			WriteError(w, http.StatusUnauthorized, "unauthorized", "missing or invalid token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Guard serialises an agent's mutations and bounds their rate. A second
// mutation is refused (409) rather than queued: queuing "stop" behind "start"
// would replay an intent the operator may no longer have.
type Guard struct {
	limiter *Limiter
	busy    sync.Mutex
}

func NewGuard(perMinute int) *Guard {
	return &Guard{limiter: NewLimiter(perMinute, time.Minute)}
}

// Wrap applies the rate limit, then holds the exclusive lock for the whole
// duration of `handle`.
func (g *Guard) Wrap(handle http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if allowed, retryAfter := g.limiter.Allow(); !allowed {
			w.Header().Set("Retry-After", strconv.Itoa(int(retryAfter.Seconds())+1))
			WriteError(w, http.StatusTooManyRequests, "rate_limited", "too many operations, retry later")
			return
		}

		if !g.busy.TryLock() {
			WriteError(w, http.StatusConflict, "busy", "another operation is in progress")
			return
		}
		defer g.busy.Unlock()

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

// Flush keeps streamed answers (downloads) streaming through the recorder.
func (r *statusRecorder) Flush() {
	if flusher, ok := r.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

// LogRequests writes one line per request. Successful reads — the
// healthcheck, and the panel polling — are logged at debug level only: at one
// every few seconds they would bury the lines that matter, mutations and
// failures.
func LogRequests(log *slog.Logger, next http.Handler) http.Handler {
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
		log.LogAttrs(r.Context(), level, "request",
			slog.String("method", r.Method),
			slog.String("path", r.URL.Path),
			slog.Int("status", recorder.status),
			slog.Duration("duration", time.Since(started)),
		)
	})
}

// ReadBody decodes an optional JSON body strictly: unknown members, duplicate
// names and invalid UTF-8 are all refused (encoding/json/v2 rejects the last
// two by default). An empty body means "defaults".
func ReadBody(w http.ResponseWriter, r *http.Request, into any, maxBytes int64) error {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBytes))
	if err != nil {
		return errors.New("body too large")
	}
	if len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, into, json.RejectUnknownMembers(true))
}

// IntParam parses an optional bounded integer query parameter.
func IntParam(raw string, fallback, minimum, maximum int) (int, error) {
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || value > maximum {
		return 0, fmt.Errorf("expected an integer between %d and %d", minimum, maximum)
	}
	return value, nil
}
