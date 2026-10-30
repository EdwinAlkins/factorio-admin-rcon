package api_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/data/api"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/fakeportal"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/fakesave"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/mods"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/saves"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/serversettings"
)

const token = "0123456789abcdef0123456789abcdef-data"

type harness struct {
	server                        *httptest.Server
	savesDir, backupsDir, modsDir string
	configDir                     string
	portal                        *fakeportal.Portal
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{savesDir: t.TempDir(), backupsDir: t.TempDir(), modsDir: t.TempDir(), portal: fakeportal.New(t)}
	savesRoot, err := os.OpenRoot(h.savesDir)
	if err != nil {
		t.Fatal(err)
	}
	backupsRoot, err := os.OpenRoot(h.backupsDir)
	if err != nil {
		t.Fatal(err)
	}
	workRoot, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	store := saves.NewStore(savesRoot, backupsRoot, nil)
	if err := store.EnableUploads(1 << 20); err != nil {
		t.Fatal(err)
	}
	h.configDir = t.TempDir()
	example, err := os.ReadFile("../../serversettings/testdata/server-settings.example.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(h.configDir, "server-settings.json"), example, 0o644); err != nil {
		t.Fatal(err)
	}
	configRoot, err := os.OpenRoot(h.configDir)
	if err != nil {
		t.Fatal(err)
	}
	historyRoot, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	agent := api.New(api.Options{
		Store:              store,
		Settings:           serversettings.New(configRoot, historyRoot),
		Mods:               mods.NewManager(h.modsDir, workRoot, h.portal.NewClient(t, true), 1<<20),
		Token:              []byte(token),
		MutationsPerMinute: 100,
		Logger:             slog.New(slog.DiscardHandler),
	})
	h.server = httptest.NewServer(agent.Handler())
	t.Cleanup(h.server.Close)
	return h
}

type result struct {
	status int
	header http.Header
	body   []byte
}

func (h *harness) call(t *testing.T, method, path, body string, authorized bool) result {
	t.Helper()
	request, err := http.NewRequest(method, h.server.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if authorized {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	return result{status: response.StatusCode, header: response.Header, body: raw}
}

func code(t *testing.T, r result) string {
	t.Helper()
	var body struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(r.body, &body)
	return body.Code
}

func TestTokenAndUnknownRoutes(t *testing.T) {
	h := newHarness(t)

	if r := h.call(t, "GET", "/v1/backups", "", false); r.status != http.StatusUnauthorized {
		t.Errorf("no token: %d", r.status)
	}
	for _, route := range []struct{ method, path string }{
		{"GET", "/v1/files?path=/etc/passwd"},
		{"PUT", "/v1/backups/x"},
		{"GET", "/v1/backups/..%2f..%2fetc%2fpasswd/download"},
		{"POST", "/v1/backups/../../x/restore"},
	} {
		if r := h.call(t, route.method, route.path, "", true); r.status < 400 || r.status >= 500 {
			t.Errorf("%s %s: %d", route.method, route.path, r.status)
		}
	}
}

func TestBackupLifecycle(t *testing.T) {
	h := newHarness(t)
	if err := os.WriteFile(filepath.Join(h.savesDir, "_autosave1.zip"), fakesave.Valid(t, "_autosave1", "x"), 0o644); err != nil {
		t.Fatal(err)
	}

	r := h.call(t, "POST", "/v1/backups", `{"source":"manual","label":"test","createdBy":"admin","factorioVersion":"2.0.77"}`, true)
	if r.status != http.StatusCreated {
		t.Fatalf("create: %d %s", r.status, r.body)
	}
	var created struct {
		Backup saves.Meta `json:"backup"`
	}
	if err := json.Unmarshal(r.body, &created); err != nil {
		t.Fatal(err)
	}
	id := created.Backup.ID

	r = h.call(t, "GET", "/v1/backups", "", true)
	if r.status != http.StatusOK || !strings.Contains(string(r.body), id) {
		t.Fatalf("list: %d %s", r.status, r.body)
	}

	r = h.call(t, "GET", "/v1/backups/"+id+"/download", "", true)
	sum := sha256.Sum256(r.body)
	if r.status != http.StatusOK || hex.EncodeToString(sum[:]) != created.Backup.SHA256 ||
		r.header.Get("X-Content-SHA256") != created.Backup.SHA256 || r.header.Get("Content-Type") != "application/zip" {
		t.Fatalf("download: %d, headers %v", r.status, r.header)
	}

	if r := h.call(t, "GET", "/v1/backups/"+id+"/verify", "", true); r.status != http.StatusOK {
		t.Fatalf("verify: %d %s", r.status, r.body)
	}

	r = h.call(t, "POST", "/v1/backups/"+id+"/restore", "", true)
	if r.status != http.StatusOK || !strings.Contains(string(r.body), `"saveName":"_autosave1.zip"`) {
		t.Fatalf("restore: %d %s", r.status, r.body)
	}

	r = h.call(t, "DELETE", "/v1/backups/"+id, "", true)
	if r.status != http.StatusOK {
		t.Fatalf("delete: %d", r.status)
	}
	if r := h.call(t, "GET", "/v1/backups/"+id+"/download", "", true); r.status != http.StatusNotFound || code(t, r) != "backup_not_found" {
		t.Fatalf("after delete: %d %s", r.status, r.body)
	}
}

func TestBadBodies(t *testing.T) {
	h := newHarness(t)
	for _, body := range []string{
		`{"source":"weekly"}`,
		`{"source":"manual","path":"/etc"}`,
		`{"source":"manual","label":"` + strings.Repeat("x", 101) + `"}`,
		`{"source":"manual","label":"a\nb"}`,
		`{"source":"manual","source":"scheduled"}`,
	} {
		if r := h.call(t, "POST", "/v1/backups", body, true); r.status != http.StatusBadRequest {
			t.Errorf("%.50s: %d", body, r.status)
		}
	}
	for _, body := range []string{`{}`, `{"sources":["manual"]}`, `{"sources":["other"],"keepLast":3}`, `{"sources":["manual"],"keepLast":-1}`} {
		if r := h.call(t, "POST", "/v1/backups/prune", body, true); r.status != http.StatusBadRequest {
			t.Errorf("prune %s: %d", body, r.status)
		}
	}
}

func TestNoSave(t *testing.T) {
	h := newHarness(t)
	if r := h.call(t, "POST", "/v1/backups", `{"source":"manual"}`, true); r.status != http.StatusConflict || code(t, r) != "no_save" {
		t.Fatalf("%d %s", r.status, r.body)
	}
}
