// Package api is the data agent's HTTP surface: a fixed list of operations on
// the server's saves and the panel's archives. No route takes a path: saves
// are named by the agent's listings, archives by ids it generated.
package api

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/agentkit"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/files"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/saves"
)

type Options struct {
	Store          *saves.Store
	Token          []byte
	TargetSaveName string
	// Mutations accepted per minute, all callers together.
	MutationsPerMinute int
	Logger             *slog.Logger
}

type Server struct {
	store          *saves.Store
	token          []byte
	targetSaveName string
	guard          *agentkit.Guard
	log            *slog.Logger
}

// Bodies are a handful of short fields.
const maxBodyBytes = 4096

func New(options Options) *Server {
	return &Server{
		store:          options.Store,
		token:          options.Token,
		targetSaveName: options.TargetSaveName,
		guard:          agentkit.NewGuard(options.MutationsPerMinute),
		log:            options.Logger,
	}
}

// Handler returns the agent's full routing table; anything else is a 404.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", agentkit.Healthz)
	mux.HandleFunc("GET /v1/saves", s.listSaves)
	mux.HandleFunc("GET /v1/backups", s.listBackups)
	mux.HandleFunc("GET /v1/backups/{id}/download", s.download)
	mux.HandleFunc("GET /v1/backups/{id}/verify", s.verify)
	mux.HandleFunc("POST /v1/backups", s.guard.Wrap(s.create))
	mux.HandleFunc("POST /v1/backups/{id}/restore", s.guard.Wrap(s.restore))
	mux.HandleFunc("DELETE /v1/backups/{id}", s.guard.Wrap(s.delete))
	mux.HandleFunc("POST /v1/backups/prune", s.guard.Wrap(s.prune))
	mux.HandleFunc("/", agentkit.NotFound)

	return agentkit.LogRequests(s.log, agentkit.Authenticate(s.token, mux))
}

// fail maps an internal error to a response. Paths and system messages go to
// the agent's log, not to the caller.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, saves.ErrNotFound):
		agentkit.WriteError(w, http.StatusNotFound, "backup_not_found", "no such backup")
		return
	case errors.Is(err, saves.ErrNoSave):
		agentkit.WriteError(w, http.StatusConflict, "no_save", "the server has no save yet")
		return
	case errors.Is(err, saves.ErrChecksum):
		agentkit.WriteError(w, http.StatusUnprocessableEntity, "checksum_mismatch", "the archive changed since it was made")
	case errors.Is(err, saves.ErrInvalidArchive):
		agentkit.WriteError(w, http.StatusUnprocessableEntity, "invalid_archive", "not a valid Factorio save")
	case files.IsNotExist(err):
		agentkit.WriteError(w, http.StatusNotFound, "backup_not_found", "no such backup")
	default:
		agentkit.WriteError(w, http.StatusInternalServerError, "io_error", "the operation failed on disk")
	}
	s.log.LogAttrs(r.Context(), slog.LevelWarn, "operation failed",
		slog.String("path", r.URL.Path),
		slog.String("error", err.Error()),
	)
}
