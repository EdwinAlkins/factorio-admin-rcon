package api_test

import (
	"encoding/json/v2"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/fakeportal"
)

func TestModsLifecycle(t *testing.T) {
	h := newHarness(t)
	h.portal.Publish(t, "flib", "1.0.0", "2.1", []string{"base >= 2.1.0"}, nil)
	list := `{"mods":[{"name":"base","enabled":true}]}`
	if err := os.WriteFile(filepath.Join(h.modsDir, "mod-list.json"), []byte(list), 0o644); err != nil {
		t.Fatal(err)
	}

	r := h.call(t, "GET", "/v1/mods?factorioVersion=2.1.23", "", true)
	if r.status != http.StatusOK || !strings.Contains(string(r.body), `"credentials":true`) {
		t.Fatalf("list: %d %s", r.status, r.body)
	}

	basket := `{"changes":[{"action":"install","name":"flib"}],"factorioVersion":"2.1.23"}`
	r = h.call(t, "POST", "/v1/mods/plan", basket, true)
	var planned struct {
		Plan struct {
			Hash      string `json:"hash"`
			Conflicts []any  `json:"conflicts"`
		} `json:"plan"`
	}
	if err := json.Unmarshal(r.body, &planned); err != nil || r.status != http.StatusOK || len(planned.Plan.Conflicts) != 0 {
		t.Fatalf("plan: %d %s", r.status, r.body)
	}

	stale := strings.TrimSuffix(basket, "}") + `,"planHash":"stale"}`
	if r := h.call(t, "POST", "/v1/mods/stage", stale, true); code(t, r) != "plan_changed" || r.status != http.StatusConflict {
		t.Fatalf("stale stage: %d %s", r.status, r.body)
	}

	confirmed := strings.TrimSuffix(basket, "}") + `,"planHash":"` + planned.Plan.Hash + `"}`
	r = h.call(t, "POST", "/v1/mods/stage", confirmed, true)
	var staged struct {
		Tx string `json:"tx"`
	}
	if err := json.Unmarshal(r.body, &staged); err != nil || r.status != http.StatusCreated {
		t.Fatalf("stage: %d %s", r.status, r.body)
	}

	if r := h.call(t, "POST", "/v1/mods/commit", `{"tx":"`+staged.Tx+`"}`, true); r.status != http.StatusOK {
		t.Fatalf("commit: %d %s", r.status, r.body)
	}
	if _, err := os.Stat(filepath.Join(h.modsDir, "flib_1.0.0.zip")); err != nil {
		t.Fatal("flib not installed")
	}
	if r := h.call(t, "POST", "/v1/mods/rollback", `{"tx":"`+staged.Tx+`"}`, true); r.status != http.StatusOK {
		t.Fatalf("rollback: %d %s", r.status, r.body)
	}
	if _, err := os.Stat(filepath.Join(h.modsDir, "flib_1.0.0.zip")); !os.IsNotExist(err) {
		t.Fatal("flib still installed after rollback")
	}
}

func TestModsRefusals(t *testing.T) {
	h := newHarness(t)
	h.portal.Publish(t, "flib", "1.0.0", "2.1", nil, nil)

	for _, body := range []string{
		`{"changes":[],"factorioVersion":"2.1.23"}`,
		`{"changes":[{"action":"install","name":"flib"}]}`,
		`{"changes":[{"action":"format","name":"flib"}],"factorioVersion":"2.1.23"}`,
		`{"changes":[{"action":"install","name":"../x"}],"factorioVersion":"2.1.23"}`,
		`{"changes":[{"action":"install","name":"flib","url":"https://evil"}],"factorioVersion":"2.1.23"}`,
	} {
		if r := h.call(t, "POST", "/v1/mods/plan", body, true); r.status != http.StatusBadRequest {
			t.Errorf("%s: %d %s", body, r.status, r.body)
		}
	}

	if r := h.call(t, "GET", "/v1/mods/portal/flib?factorioVersion=2.1.23", "", true); r.status != http.StatusOK ||
		!strings.Contains(string(r.body), `"compatible":true`) {
		t.Errorf("details: %d %s", r.status, r.body)
	}
	if r := h.call(t, "GET", "/v1/mods/portal/ghost?factorioVersion=2.1.23", "", true); code(t, r) != "mod_not_found" {
		t.Errorf("unknown mod: %d %s", r.status, r.body)
	}
	if r := h.call(t, "GET", "/v1/mods/search?q=fl&factorioVersion=2.1.23", "", true); r.status != http.StatusOK ||
		!strings.Contains(string(r.body), `"installed":false`) {
		t.Errorf("search: %d %s", r.status, r.body)
	}
	if r := h.call(t, "POST", "/v1/mods/commit", `{"tx":"../../etc"}`, true); code(t, r) != "tx_not_found" {
		t.Errorf("crafted tx: %d %s", r.status, r.body)
	}
	// The token never shows in an answer, whatever happened.
	for _, path := range []string{"/v1/mods?factorioVersion=2.1.23", "/v1/mods/search?q=x&factorioVersion=2.1.23"} {
		if r := h.call(t, "GET", path, "", true); strings.Contains(string(r.body), fakeportal.Token) {
			t.Errorf("%s leaked the token", path)
		}
	}
}
