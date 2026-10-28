package api

import (
	"errors"
	"net/http"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/agentkit"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/serversettings"
)

// A few dozen short settings and three secrets.
const maxSettingsBodyBytes = 32 << 10

// failSettings answers a server settings error, when err is one; see fail.
func failSettings(w http.ResponseWriter, err error) bool {
	var invalid *serversettings.InvalidError
	switch {
	case errors.As(err, &invalid):
		agentkit.WriteError(w, http.StatusBadRequest, "invalid_setting", invalid.Error())
	case errors.Is(err, serversettings.ErrMissing):
		agentkit.WriteError(w, http.StatusNotFound, "server_settings_missing", "the server has not created its settings yet")
	case errors.Is(err, serversettings.ErrUnreadable):
		agentkit.WriteError(w, http.StatusUnprocessableEntity, "server_settings_unreadable", "server-settings.json is not a JSON object")
	case errors.Is(err, serversettings.ErrChanged):
		agentkit.WriteError(w, http.StatusConflict, "settings_changed", "the file changed since it was read")
	case errors.Is(err, serversettings.ErrTxNotFound):
		agentkit.WriteError(w, http.StatusNotFound, "settings_tx_not_found", "no such settings change")
	case errors.Is(err, serversettings.ErrPublicCredentials):
		agentkit.WriteError(w, http.StatusUnprocessableEntity, "public_needs_credentials", err.Error())
	case errors.Is(err, serversettings.ErrNothingToDo):
		agentkit.WriteError(w, http.StatusBadRequest, "invalid_setting", err.Error())
	default:
		return false
	}
	return true
}

// settingsOff answers when the config folder is not mounted.
func (s *Server) settingsOff(w http.ResponseWriter) bool {
	if s.settings != nil {
		return false
	}
	agentkit.WriteError(w, http.StatusNotFound, "server_settings_unavailable", "the config folder is not mounted")
	return true
}

type settingsResponse struct {
	OK bool `json:"ok"`
	serversettings.View
}

func (s *Server) readSettings(w http.ResponseWriter, r *http.Request) {
	if s.settingsOff(w) {
		return
	}
	view, err := s.settings.Read()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	agentkit.WriteJSON(w, http.StatusOK, settingsResponse{OK: true, View: view})
}

type updateSettingsBody struct {
	serversettings.Patch
	Hash string `json:"hash"`
}

type updateSettingsResponse struct {
	OK bool   `json:"ok"`
	Tx string `json:"tx"`
	serversettings.View
}

func (s *Server) updateSettings(w http.ResponseWriter, r *http.Request) {
	if s.settingsOff(w) {
		return
	}
	var body updateSettingsBody
	if err := agentkit.ReadBody(w, r, &body, maxSettingsBodyBytes); err != nil || len(body.Hash) != 64 {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", "settings, secrets and the hash read are required")
		return
	}
	tx, view, err := s.settings.Update(body.Patch, body.Hash)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.log.InfoContext(r.Context(), "server settings changed", "tx", tx, "keys", len(body.Settings), "secrets", len(body.Secrets))
	agentkit.WriteJSON(w, http.StatusOK, updateSettingsResponse{OK: true, Tx: tx, View: view})
}

func (s *Server) rollbackSettings(w http.ResponseWriter, r *http.Request) {
	if s.settingsOff(w) {
		return
	}
	s.onTx(w, r, "server settings rolled back", s.settings.Rollback)
}
