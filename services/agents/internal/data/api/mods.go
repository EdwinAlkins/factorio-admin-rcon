package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/agentkit"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/mods"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/portal"
)

// A basket of up to mods.MaxChanges short lines.
const maxModsBodyBytes = 16 << 10

// Status of each mods error code; see mods.ErrorCode.
var modsStatus = map[string]int{
	"mods_conflict":              http.StatusConflict,
	"plan_changed":               http.StatusConflict,
	"mods_nothing_to_do":         http.StatusConflict,
	"tx_not_found":               http.StatusNotFound,
	"tx_already_committed":       http.StatusConflict,
	"mods_unavailable":           http.StatusConflict,
	"invalid_mod_archive":        http.StatusUnprocessableEntity,
	"mod_not_found":              http.StatusNotFound,
	"portal_credentials_missing": http.StatusConflict,
	"portal_rejected":            http.StatusBadGateway,
	"download_too_large":         http.StatusUnprocessableEntity,
	"download_checksum":          http.StatusUnprocessableEntity,
	"portal_unreachable":         http.StatusBadGateway,
}

// gameVersion reads the `factorioVersion` the panel passes: the agent cannot
// ask the game itself.
func gameVersion(raw string) (mods.Version, bool) {
	v, err := mods.ParseVersion(raw)
	return v, err == nil && len(raw) <= 32
}

// portalLimited spends one slot of the portal budget: searching and planning
// call mods.factorio.com on the operator's behalf, and must not let a
// compromised panel hammer it.
func (s *Server) portalLimited(w http.ResponseWriter) bool {
	if allowed, retryAfter := s.portalLimiter.Allow(); !allowed {
		w.Header().Set("Retry-After", strconv.Itoa(int(retryAfter.Seconds())+1))
		agentkit.WriteError(w, http.StatusTooManyRequests, "rate_limited", "too many portal requests, retry later")
		return true
	}
	return false
}

type modsResponse struct {
	OK bool `json:"ok"`
	mods.State
}

func (s *Server) listMods(w http.ResponseWriter, r *http.Request) {
	game := r.URL.Query().Get("factorioVersion")
	if _, ok := gameVersion(game); game != "" && !ok {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_query", "factorioVersion: expected a.b.c")
		return
	}
	state, err := s.mods.List(r.Context(), game)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	agentkit.WriteJSON(w, http.StatusOK, modsResponse{OK: true, State: state})
}

type searchResponse struct {
	OK        bool             `json:"ok"`
	Hits      []mods.SearchHit `json:"hits"`
	Page      int              `json:"page"`
	PageCount int              `json:"pageCount"`
}

func (s *Server) searchMods(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	game, ok := gameVersion(query.Get("factorioVersion"))
	text := strings.TrimSpace(query.Get("q"))
	page, err := agentkit.IntParam(query.Get("page"), 1, 1, 500)
	if !ok || err != nil || len(text) > 100 || !shortText(text, 100) {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_query", "q (≤ 100 characters), page and factorioVersion required")
		return
	}
	if s.portalLimited(w) {
		return
	}
	hits, result, err := s.mods.Search(r.Context(), text, game, page)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	agentkit.WriteJSON(w, http.StatusOK, searchResponse{OK: true, Hits: hits, Page: result.Page, PageCount: result.PageCount})
}

type detailsResponse struct {
	OK  bool         `json:"ok"`
	Mod mods.Details `json:"mod"`
}

func (s *Server) modDetails(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	game, ok := gameVersion(r.URL.Query().Get("factorioVersion"))
	if !ok || !portal.ValidName(name) {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_query", "a mod name and factorioVersion are required")
		return
	}
	if s.portalLimited(w) {
		return
	}
	details, err := s.mods.Details(r.Context(), name, game)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	agentkit.WriteJSON(w, http.StatusOK, detailsResponse{OK: true, Mod: details})
}

type planBody struct {
	Changes         []mods.Change `json:"changes"`
	FactorioVersion string        `json:"factorioVersion"`
	PlanHash        string        `json:"planHash"`
}

// readPlanBody decodes and validates a basket; it answers the error itself.
func readPlanBody(w http.ResponseWriter, r *http.Request) (planBody, mods.Version, bool) {
	var body planBody
	if err := agentkit.ReadBody(w, r, &body, maxModsBodyBytes); err != nil {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", err.Error())
		return body, mods.Version{}, false
	}
	game, ok := gameVersion(body.FactorioVersion)
	if !ok || len(body.Changes) == 0 || len(body.Changes) > mods.MaxChanges || len(body.PlanHash) > 64 {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", "changes (1 to 50) and factorioVersion are required")
		return body, game, false
	}
	for _, change := range body.Changes {
		known := change.Action == mods.ActionInstall || change.Action == mods.ActionUpdate ||
			change.Action == mods.ActionEnable || change.Action == mods.ActionDisable || change.Action == mods.ActionRemove
		_, versionErr := mods.ParseVersion(change.Version)
		if !known || !portal.ValidName(change.Name) || (change.Version != "" && versionErr != nil) {
			agentkit.WriteError(w, http.StatusBadRequest, "bad_body", "changes: unknown action, invalid name or version")
			return body, game, false
		}
	}
	return body, game, true
}

type planResponse struct {
	OK   bool      `json:"ok"`
	Plan mods.Plan `json:"plan"`
}

// plan is a simulation: it reads the disk and the portal, writes nothing.
// Conflicts are part of a successful answer: they are the point of asking.
func (s *Server) planMods(w http.ResponseWriter, r *http.Request) {
	body, game, ok := readPlanBody(w, r)
	if !ok || s.portalLimited(w) {
		return
	}
	plan, err := s.mods.Plan(r.Context(), body.Changes, game)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	agentkit.WriteJSON(w, http.StatusOK, planResponse{OK: true, Plan: plan})
}

type stageResponse struct {
	OK   bool      `json:"ok"`
	Tx   string    `json:"tx"`
	Plan mods.Plan `json:"plan"`
}

func (s *Server) stageMods(w http.ResponseWriter, r *http.Request) {
	body, game, ok := readPlanBody(w, r)
	if !ok {
		return
	}
	tx, plan, err := s.mods.Stage(r.Context(), body.Changes, game, body.PlanHash)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.log.InfoContext(r.Context(), "mods staged", "tx", tx, "steps", len(plan.Steps))
	agentkit.WriteJSON(w, http.StatusCreated, stageResponse{OK: true, Tx: tx, Plan: plan})
}

type txBody struct {
	Tx string `json:"tx"`
}

func (s *Server) commitMods(w http.ResponseWriter, r *http.Request) {
	s.onTx(w, r, "mods committed", s.mods.Commit)
}

func (s *Server) rollbackMods(w http.ResponseWriter, r *http.Request) {
	s.onTx(w, r, "mods rolled back", s.mods.Rollback)
}

func (s *Server) onTx(w http.ResponseWriter, r *http.Request, done string, act func(string) error) {
	var body txBody
	if err := agentkit.ReadBody(w, r, &body, maxBodyBytes); err != nil || body.Tx == "" {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", "tx is required")
		return
	}
	if err := act(body.Tx); err != nil {
		s.fail(w, r, err)
		return
	}
	s.log.InfoContext(r.Context(), done, "tx", body.Tx)
	agentkit.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// failMods answers a mods error, when err is one; see fail.
func failMods(w http.ResponseWriter, err error) bool {
	code := mods.ErrorCode(err)
	if code == "" {
		return false
	}
	message := "mods operation refused"
	var conflict *mods.ConflictError
	if errors.As(err, &conflict) {
		message = conflict.Error()
	}
	agentkit.WriteError(w, modsStatus[code], code, message)
	return true
}
