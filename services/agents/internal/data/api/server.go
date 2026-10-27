// Package api is the data agent's HTTP surface: a fixed list of operations on
// the server's saves, the panel's archives and the server's mods. No route
// takes a path or a URL: saves are named by the agent's listings, archives,
// uploads and transactions by ids it generated, mods by validated names.
package api

import (
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/agentkit"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/files"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/mods"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/saves"
)

type Options struct {
	Store          *saves.Store
	Mods           *mods.Manager
	Token          []byte
	TargetSaveName string
	// Mutations accepted per minute, all callers together.
	MutationsPerMinute int
	Logger             *slog.Logger
}

type Server struct {
	store          *saves.Store
	mods           *mods.Manager
	token          []byte
	targetSaveName string
	guard          *agentkit.Guard
	portalLimiter  *agentkit.Limiter
	chunkLimiter   *agentkit.Limiter
	log            *slog.Logger
}

// Searches, mod pages and plans per minute: each may call the portal.
const portalPerMinute = 60

// Bodies are a handful of short fields.
const maxBodyBytes = 4096

func New(options Options) *Server {
	return &Server{
		store:          options.Store,
		mods:           options.Mods,
		token:          options.Token,
		targetSaveName: options.TargetSaveName,
		guard:          agentkit.NewGuard(options.MutationsPerMinute),
		portalLimiter:  agentkit.NewLimiter(portalPerMinute, time.Minute),
		chunkLimiter:   agentkit.NewLimiter(chunksPerMinute, time.Minute),
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
	mux.HandleFunc("POST /v1/uploads", s.guard.Wrap(s.beginUpload))
	mux.HandleFunc("GET /v1/uploads/{id}", s.uploadOffset)
	// Chunks write only to the upload's own file, one at a time (see
	// saves.Store.AppendUpload): outside the guard, or a restore would wait
	// on a chunk, and a large save would exhaust the mutation budget.
	mux.HandleFunc("PUT /v1/uploads/{id}", s.uploadChunk)
	mux.HandleFunc("POST /v1/uploads/{id}/complete", s.guard.Wrap(s.completeUpload))
	mux.HandleFunc("DELETE /v1/uploads/{id}", s.abortUpload)
	mux.HandleFunc("GET /v1/mods", s.listMods)
	mux.HandleFunc("GET /v1/mods/search", s.searchMods)
	mux.HandleFunc("GET /v1/mods/portal/{name}", s.modDetails)
	mux.HandleFunc("POST /v1/mods/plan", s.planMods)
	// Staging writes only to the agent's work directory, but downloads for
	// minutes: under the guard, so two baskets never stage at once.
	mux.HandleFunc("POST /v1/mods/stage", s.guard.Wrap(s.stageMods))
	mux.HandleFunc("POST /v1/mods/commit", s.guard.Wrap(s.commitMods))
	mux.HandleFunc("POST /v1/mods/rollback", s.guard.Wrap(s.rollbackMods))
	mux.HandleFunc("/", agentkit.NotFound)

	return agentkit.LogRequests(s.log, agentkit.Authenticate(s.token, mux))
}

// fail maps an internal error to a response. Paths and system messages go to
// the agent's log, not to the caller.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	if failUpload(w, err) {
		s.log.LogAttrs(r.Context(), slog.LevelWarn, "upload refused",
			slog.String("path", r.URL.Path),
			slog.String("error", err.Error()),
		)
		return
	}
	if failMods(w, err) {
		s.log.LogAttrs(r.Context(), slog.LevelWarn, "mods operation refused",
			slog.String("path", r.URL.Path),
			slog.String("error", err.Error()),
		)
		return
	}
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
