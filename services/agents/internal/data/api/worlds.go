package api

import (
	"errors"
	"net/http"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/agentkit"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/worlds"
)

// failWorlds answers a world library error, when err is one; see fail.
func failWorlds(w http.ResponseWriter, err error) bool {
	if errors.Is(err, worlds.ErrNotFound) {
		agentkit.WriteError(w, http.StatusNotFound, "world_not_found", "no such world")
		return true
	}
	return false
}

type archiveWorldBody struct {
	CreatedBy string `json:"createdBy"`
}

// archiveWorld copies a world of the library into the archives, from where
// the panel restores it like any other.
func (s *Server) archiveWorld(w http.ResponseWriter, r *http.Request) {
	if s.worlds == nil {
		agentkit.WriteError(w, http.StatusNotFound, "worlds_unavailable", "the worlds folder is not mounted")
		return
	}
	var body archiveWorldBody
	if err := agentkit.ReadBody(w, r, &body, maxBodyBytes); err != nil {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", err.Error())
		return
	}
	if !shortText(body.CreatedBy, 100) {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", "createdBy: too long or not printable")
		return
	}
	id := r.PathValue("id")
	meta, err := s.store.ImportWorld(s.worlds, id, body.CreatedBy)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.log.InfoContext(r.Context(), "world archived", "world", id, "id", meta.ID, "size", meta.Size)
	agentkit.WriteJSON(w, http.StatusCreated, backupResponse{OK: true, Backup: meta})
}
