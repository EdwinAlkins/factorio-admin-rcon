package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/agentkit"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/mods"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/saves"
)

type savesResponse struct {
	OK    bool             `json:"ok"`
	Saves []saves.SaveFile `json:"saves"`
	Mods  []mods.Mod       `json:"mods"`
	// Zero: uploads are off.
	MaxUploadBytes int64 `json:"maxUploadBytes"`
}

type backupsResponse struct {
	OK      bool         `json:"ok"`
	Backups []saves.Meta `json:"backups"`
}

type backupResponse struct {
	OK     bool       `json:"ok"`
	Backup saves.Meta `json:"backup"`
}

func (s *Server) listSaves(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.ListSaves()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	modSet, err := s.store.CurrentMods()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	agentkit.WriteJSON(w, http.StatusOK, savesResponse{OK: true, Saves: list, Mods: modSet, MaxUploadBytes: s.store.MaxUpload()})
}

func (s *Server) listBackups(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.ListBackups()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	agentkit.WriteJSON(w, http.StatusOK, backupsResponse{OK: true, Backups: list})
}

// download streams an archive. http.ServeContent handles Range and HEAD, so an
// interrupted download of a large save can resume.
func (s *Server) download(w http.ResponseWriter, r *http.Request) {
	f, meta, err := s.store.Open(r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	defer f.Close()

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("X-Content-SHA256", meta.SHA256)
	http.ServeContent(w, r, meta.ID+".zip", meta.CreatedAt, f)
}

// verify reads a whole archive: read-only, but not cheap on a large map.
func (s *Server) verify(w http.ResponseWriter, r *http.Request) {
	if err := s.store.Verify(r.PathValue("id")); err != nil {
		s.fail(w, r, err)
		return
	}
	agentkit.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type createBody struct {
	Source          string `json:"source"`
	Label           string `json:"label"`
	CreatedBy       string `json:"createdBy"`
	FactorioVersion string `json:"factorioVersion"`
}

func (s *Server) create(w http.ResponseWriter, r *http.Request) {
	var body createBody
	if err := agentkit.ReadBody(w, r, &body, maxBodyBytes); err != nil {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", err.Error())
		return
	}
	// Uploads and worlds are published by their own routes, never archived
	// from the saves folder.
	if !saves.ValidSource(body.Source) || body.Source == saves.SourceUpload || body.Source == saves.SourceWorld {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", "source: unknown")
		return
	}
	if !shortText(body.Label, 100) || !shortText(body.CreatedBy, 100) || !shortText(body.FactorioVersion, 32) {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", "label, createdBy, factorioVersion: too long or not printable")
		return
	}

	meta, err := s.store.Create(saves.CreateRequest{
		Source:          body.Source,
		Label:           body.Label,
		CreatedBy:       body.CreatedBy,
		FactorioVersion: body.FactorioVersion,
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.log.InfoContext(r.Context(), "backup created", "id", meta.ID, "size", meta.Size)
	agentkit.WriteJSON(w, http.StatusCreated, backupResponse{OK: true, Backup: meta})
}

type restoreResponse struct {
	OK      bool                `json:"ok"`
	Restore saves.RestoreResult `json:"restore"`
}

func (s *Server) restore(w http.ResponseWriter, r *http.Request) {
	if err := agentkit.ReadBody(w, r, &struct{}{}, maxBodyBytes); err != nil {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", err.Error())
		return
	}
	id := r.PathValue("id")
	result, err := s.store.Restore(id, s.targetSaveName)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.log.InfoContext(r.Context(), "backup restored", "id", id, "save", result.SaveName, "replaced", result.Replaced)
	agentkit.WriteJSON(w, http.StatusOK, restoreResponse{OK: true, Restore: result})
}

func (s *Server) delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.store.Delete(id); err != nil {
		s.fail(w, r, err)
		return
	}
	s.log.InfoContext(r.Context(), "backup deleted", "id", id)
	agentkit.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type pruneBody struct {
	Sources    []string `json:"sources"`
	KeepLast   int      `json:"keepLast"`
	MaxAgeDays int      `json:"maxAgeDays"`
}

type pruneResponse struct {
	OK      bool     `json:"ok"`
	Removed []string `json:"removed"`
}

func (s *Server) prune(w http.ResponseWriter, r *http.Request) {
	var body pruneBody
	if err := agentkit.ReadBody(w, r, &body, maxBodyBytes); err != nil {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", err.Error())
		return
	}
	if len(body.Sources) == 0 || body.KeepLast < 0 || body.KeepLast > 10_000 || body.MaxAgeDays < 0 || body.MaxAgeDays > 3650 ||
		(body.KeepLast == 0 && body.MaxAgeDays == 0) {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", "sources, and keepLast or maxAgeDays, are required")
		return
	}
	for _, source := range body.Sources {
		if !saves.ValidSource(source) {
			agentkit.WriteError(w, http.StatusBadRequest, "bad_body", "sources: unknown source")
			return
		}
	}

	removed, err := s.store.Prune(saves.PrunePolicy{
		Sources:  body.Sources,
		KeepLast: body.KeepLast,
		MaxAge:   time.Duration(body.MaxAgeDays) * 24 * time.Hour,
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if len(removed) > 0 {
		s.log.InfoContext(r.Context(), "backups pruned", "removed", removed)
	}
	agentkit.WriteJSON(w, http.StatusOK, pruneResponse{OK: true, Removed: removed})
}

// shortText bounds a free-text field and keeps control characters out of
// sidecars and logs.
func shortText(value string, max int) bool {
	return len(value) <= max && !strings.ContainsFunc(value, func(r rune) bool { return r < 0x20 || r == 0x7f })
}
