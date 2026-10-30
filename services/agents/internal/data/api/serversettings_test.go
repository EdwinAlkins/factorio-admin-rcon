package api_test

import (
	"encoding/json/v2"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestServerSettingsLifecycle(t *testing.T) {
	h := newHarness(t)

	r := h.call(t, "GET", "/v1/server-settings", "", true)
	if r.status != http.StatusOK || strings.Contains(string(r.body), "hunter2") ||
		!strings.Contains(string(r.body), `"game_password":true`) {
		t.Fatalf("read: %d %s", r.status, r.body)
	}
	var read struct {
		Hash string `json:"hash"`
	}
	if err := json.Unmarshal(r.body, &read); err != nil {
		t.Fatal(err)
	}

	r = h.call(t, "PUT", "/v1/server-settings", `{"settings":{"max_players":8},"secrets":{"game_password":{"clear":true}},"hash":"`+read.Hash+`"}`, true)
	if r.status != http.StatusOK || !strings.Contains(string(r.body), `"tx":"`) || !strings.Contains(string(r.body), `"game_password":false`) {
		t.Fatalf("update: %d %s", r.status, r.body)
	}
	var updated struct {
		Tx string `json:"tx"`
	}
	_ = json.Unmarshal(r.body, &updated)

	// The same hash again: the file has changed since.
	if r := h.call(t, "PUT", "/v1/server-settings", `{"settings":{"max_players":9},"hash":"`+read.Hash+`"}`, true); r.status != http.StatusConflict || code(t, r) != "settings_changed" {
		t.Fatalf("stale: %d %s", r.status, r.body)
	}

	if r := h.call(t, "POST", "/v1/server-settings/rollback", `{"tx":"`+updated.Tx+`"}`, true); r.status != http.StatusOK {
		t.Fatalf("rollback: %d %s", r.status, r.body)
	}
	raw, _ := os.ReadFile(filepath.Join(h.configDir, "server-settings.json"))
	if !strings.Contains(string(raw), "hunter2") {
		t.Fatal("rollback did not bring the previous file back")
	}
}

func TestServerSettingsRefusals(t *testing.T) {
	h := newHarness(t)
	hash := strings.Repeat("0", 64)
	for body, want := range map[string]string{
		`{"settings":{"max_players":8}}`:                             "bad_body",
		`{"settings":{"max_players":8},"hash":"` + hash + `","x":1}`: "bad_body",
		`{"settings":{"rcon_port":1},"hash":"` + hash + `"}`:         "invalid_setting",
		`{"hash":"` + hash + `"}`:                                    "invalid_setting",
	} {
		if r := h.call(t, "PUT", "/v1/server-settings", body, true); r.status != http.StatusBadRequest || code(t, r) != want {
			t.Errorf("%s: %d %s", body, r.status, r.body)
		}
	}
	if r := h.call(t, "POST", "/v1/server-settings/rollback", `{"tx":"../x"}`, true); r.status != http.StatusNotFound || code(t, r) != "settings_tx_not_found" {
		t.Errorf("rollback: %d %s", r.status, r.body)
	}

	if err := os.Remove(filepath.Join(h.configDir, "server-settings.json")); err != nil {
		t.Fatal(err)
	}
	if r := h.call(t, "GET", "/v1/server-settings", "", true); r.status != http.StatusNotFound || code(t, r) != "server_settings_missing" {
		t.Errorf("missing: %d %s", r.status, r.body)
	}
}
