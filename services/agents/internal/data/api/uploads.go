package api

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/agentkit"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/saves"
)

// Chunks per minute. Outside the guard — a 2 GB save is 256 of them — but
// still bounded: each one writes to disk.
const chunksPerMinute = 600

// Time allowed to receive one chunk, past the server's 10 s default: 8 MB
// over a slow uplink.
const chunkReadTimeout = 2 * time.Minute

// Status of each upload error.
func failUpload(w http.ResponseWriter, err error) bool {
	var offset *saves.OffsetError
	switch {
	case errors.As(err, &offset):
		agentkit.WriteError(w, http.StatusConflict, "upload_offset", offset.Error())
	case errors.Is(err, saves.ErrUploadNotFound):
		agentkit.WriteError(w, http.StatusNotFound, "upload_not_found", "no such upload")
	case errors.Is(err, saves.ErrUploadBusy):
		agentkit.WriteError(w, http.StatusConflict, "upload_busy", "another upload is in progress")
	case errors.Is(err, saves.ErrUploadTooLarge):
		agentkit.WriteError(w, http.StatusRequestEntityTooLarge, "upload_too_large", "larger than the upload limit")
	case errors.Is(err, saves.ErrUploadIncomplete):
		agentkit.WriteError(w, http.StatusConflict, "upload_incomplete", "not every chunk has arrived")
	case errors.Is(err, saves.ErrUploadsDisabled):
		agentkit.WriteError(w, http.StatusNotFound, "uploads_disabled", "uploads are disabled")
	default:
		return false
	}
	return true
}

type uploadBody struct {
	Size int64  `json:"size"`
	Name string `json:"name"`
}

type uploadResponse struct {
	OK         bool              `json:"ok"`
	Upload     saves.UploadState `json:"upload"`
	ChunkBytes int               `json:"chunkBytes"`
}

func (s *Server) beginUpload(w http.ResponseWriter, r *http.Request) {
	var body uploadBody
	if err := agentkit.ReadBody(w, r, &body, maxBodyBytes); err != nil {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", err.Error())
		return
	}
	if body.Size <= 0 || !shortText(body.Name, 255) {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", "size (> 0) required, name ≤ 255 characters")
		return
	}
	state, err := s.store.BeginUpload(body.Size, body.Name)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.log.InfoContext(r.Context(), "upload started", "upload", state.ID, "size", state.Size)
	agentkit.WriteJSON(w, http.StatusCreated, uploadResponse{OK: true, Upload: state, ChunkBytes: saves.ChunkBytes})
}

func (s *Server) uploadOffset(w http.ResponseWriter, r *http.Request) {
	state, err := s.store.UploadOffset(r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	agentkit.WriteJSON(w, http.StatusOK, uploadResponse{OK: true, Upload: state, ChunkBytes: saves.ChunkBytes})
}

func (s *Server) uploadChunk(w http.ResponseWriter, r *http.Request) {
	if allowed, retryAfter := s.chunkLimiter.Allow(); !allowed {
		w.Header().Set("Retry-After", strconv.Itoa(int(retryAfter.Seconds())+1))
		agentkit.WriteError(w, http.StatusTooManyRequests, "rate_limited", "too many chunks, retry later")
		return
	}
	offset, err := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
	if err != nil || offset < 0 {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_query", "offset: expected a non-negative integer")
		return
	}
	if r.ContentLength > saves.ChunkBytes {
		agentkit.WriteError(w, http.StatusRequestEntityTooLarge, "chunk_too_large", "chunk larger than chunkBytes")
		return
	}
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(chunkReadTimeout))

	state, err := s.store.AppendUpload(r.PathValue("id"), offset, http.MaxBytesReader(w, r.Body, saves.ChunkBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			agentkit.WriteError(w, http.StatusRequestEntityTooLarge, "chunk_too_large", "chunk larger than chunkBytes")
			return
		}
		s.fail(w, r, err)
		return
	}
	agentkit.WriteJSON(w, http.StatusOK, uploadResponse{OK: true, Upload: state, ChunkBytes: saves.ChunkBytes})
}

type completeBody struct {
	Label     string `json:"label"`
	CreatedBy string `json:"createdBy"`
}

func (s *Server) completeUpload(w http.ResponseWriter, r *http.Request) {
	var body completeBody
	if err := agentkit.ReadBody(w, r, &body, maxBodyBytes); err != nil {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", err.Error())
		return
	}
	if !shortText(body.Label, 100) || !shortText(body.CreatedBy, 100) {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", "label, createdBy: too long or not printable")
		return
	}
	id := r.PathValue("id")
	meta, err := s.store.CompleteUpload(id, body.Label, body.CreatedBy)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.log.InfoContext(r.Context(), "upload published", "upload", id, "id", meta.ID, "size", meta.Size)
	agentkit.WriteJSON(w, http.StatusCreated, backupResponse{OK: true, Backup: meta})
}

func (s *Server) abortUpload(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.store.AbortUpload(id); err != nil {
		s.fail(w, r, err)
		return
	}
	s.log.InfoContext(r.Context(), "upload aborted", "upload", id)
	agentkit.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
