package api_test

import (
	"encoding/json/v2"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/control/api"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/docker"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/fakedocker"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/target"
)

const token = "0123456789abcdef0123456789abcdef-test"

func factorio() *fakedocker.Container {
	return &fakedocker.Container{
		ID:     "aaaaaaaaaaaa1111111111111111111111111111111111111111111111111111",
		Labels: map[string]string{"com.docker.compose.project": "stack", "com.docker.compose.service": "factorio"},
		Env:    []string{"UPDATE_MODS_ON_START=true"},
		State:  "running",
		Stdout: []string{"   0.000 Loading mod base", "  12.345 Info AppManager.cpp: Saving finished"},
		Stderr: []string{"warning: something"},
	}
}

// The panel's container sits on the same host, carries secrets in its
// environment and must never be reachable through the agent.
func panel() *fakedocker.Container {
	return &fakedocker.Container{
		ID:     "bbbbbbbbbbbb2222222222222222222222222222222222222222222222222222",
		Labels: map[string]string{"com.docker.compose.project": "stack", "com.docker.compose.service": "factorio-admin"},
		Env:    []string{"SESSION_SECRET=do-not-leak", "ADMIN_PASSWORD=do-not-leak"},
		State:  "running",
	}
}

type harness struct {
	daemon *fakedocker.Daemon
	server *httptest.Server
}

func newHarness(t *testing.T, mutationsPerMinute int, containers ...*fakedocker.Container) *harness {
	t.Helper()
	daemon := fakedocker.Start(t, containers...)
	client := docker.New(daemon.Socket, "1.43")

	agent := api.New(api.Options{
		Docker:             client,
		Target:             target.NewResolver(client, "stack", "factorio"),
		Token:              []byte(token),
		StopTimeout:        30 * time.Second,
		MutationsPerMinute: mutationsPerMinute,
		Logger:             slog.New(slog.DiscardHandler),
	})
	server := httptest.NewServer(agent.Handler())
	t.Cleanup(server.Close)

	return &harness{daemon: daemon, server: server}
}

type result struct {
	status int
	header http.Header
	body   string
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
	return result{status: response.StatusCode, header: response.Header, body: string(raw)}
}

func code(t *testing.T, r result) string {
	t.Helper()
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal([]byte(r.body), &body); err != nil {
		t.Fatalf("not JSON: %q", r.body)
	}
	return body.Code
}

// Every path the agent may ever send to the daemon. Anything else reaching
// the fake is a bug in the allow-list.
var allowedDaemonPath = regexp.MustCompile(`^/v1\.43/containers/(json|[0-9a-f]{64}/(json|stats|logs|start|stop|restart))$`)

func assertOnlyAllowedDaemonCalls(t *testing.T, daemon *fakedocker.Daemon) {
	t.Helper()
	for _, request := range daemon.Requests() {
		if !allowedDaemonPath.MatchString(request.Path) {
			t.Errorf("daemon received a call outside the allow-list: %s %s", request.Method, request.Path)
		}
	}
}

func TestHealthzNeedsNoTokenAndNoDaemon(t *testing.T) {
	h := newHarness(t, 10, factorio())

	if r := h.call(t, "GET", "/healthz", "", false); r.status != http.StatusOK {
		t.Fatalf("status %d", r.status)
	}
	if n := len(h.daemon.Requests()); n != 0 {
		t.Fatalf("healthz reached the daemon %d times", n)
	}
}

func TestTokenIsRequired(t *testing.T) {
	h := newHarness(t, 10, factorio())

	for _, route := range []struct{ method, path string }{
		{"GET", "/v1/server/status"},
		{"POST", "/v1/server/stop"},
		{"GET", "/v1/does-not-exist"},
	} {
		r := h.call(t, route.method, route.path, "", false)
		if r.status != http.StatusUnauthorized || r.header.Get("WWW-Authenticate") != "Bearer" {
			t.Errorf("%s %s without token: status %d", route.method, route.path, r.status)
		}

		request, _ := http.NewRequest(route.method, h.server.URL+route.path, nil)
		request.Header.Set("Authorization", "Bearer "+token+"x")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s %s with a wrong token: status %d", route.method, route.path, response.StatusCode)
		}
	}

	if n := len(h.daemon.Requests()); n != 0 {
		t.Fatalf("unauthenticated requests reached the daemon %d times", n)
	}
}

func TestUnknownOperationsNeverReachTheDaemon(t *testing.T) {
	h := newHarness(t, 10, factorio(), panel())

	for _, route := range []struct{ method, path string }{
		{"GET", "/v1/containers/json"},
		{"GET", "/v1.43/containers/json"},
		{"GET", "/containers/" + panel().ID + "/json"},
		{"POST", "/v1/server/exec"},
		{"POST", "/v1/containers/" + panel().ID + "/stop"},
		{"POST", "/v1/server/" + panel().ID + "/stop"},
		{"GET", "/v1/server/start"},
		{"DELETE", "/v1/server/status"},
		{"PUT", "/v1/server/stop"},
		{"GET", "/v1/server/../../containers/json"},
	} {
		r := h.call(t, route.method, route.path, "", true)
		if r.status < 400 || r.status >= 500 {
			t.Errorf("%s %s: status %d, want a 4xx", route.method, route.path, r.status)
		}
	}

	if n := len(h.daemon.Requests()); n != 0 {
		t.Fatalf("unknown operations reached the daemon: %+v", h.daemon.Requests())
	}
}

func TestStatusIsAllowListed(t *testing.T) {
	h := newHarness(t, 10, factorio(), panel())

	r := h.call(t, "GET", "/v1/server/status", "", true)
	if r.status != http.StatusOK {
		t.Fatalf("status %d: %s", r.status, r.body)
	}

	for _, forbidden := range []string{"do-not-leak", "UPDATE_MODS_ON_START", "Env", "Mounts", "/srv/secret", "Labels", "com.docker"} {
		if strings.Contains(r.body, forbidden) {
			t.Errorf("status response leaks %q: %s", forbidden, r.body)
		}
	}

	var body struct {
		Container api.ContainerStatus `json:"container"`
	}
	if err := json.Unmarshal([]byte(r.body), &body); err != nil {
		t.Fatal(err)
	}
	if body.Container.State != "running" || body.Container.Image != "factoriotools/factorio:stable" || body.Container.FinishedAt != "" {
		t.Errorf("unexpected status: %+v", body.Container)
	}

	for _, request := range h.daemon.Requests() {
		if strings.Contains(request.Path, panel().ID) {
			t.Errorf("the panel's container was queried: %s", request.Path)
		}
	}
	assertOnlyAllowedDaemonCalls(t, h.daemon)
}

func TestStatsKeepOnlyCPUAndMemory(t *testing.T) {
	h := newHarness(t, 10, factorio())

	r := h.call(t, "GET", "/v1/server/stats", "", true)
	if r.status != http.StatusOK {
		t.Fatalf("status %d: %s", r.status, r.body)
	}
	if strings.Contains(r.body, "networks") || strings.Contains(r.body, "total_inactive_file") {
		t.Errorf("unexpected stats fields: %s", r.body)
	}
	if !strings.Contains(r.body, `"inactive_file":100`) || !strings.Contains(r.body, `"online_cpus":4`) {
		t.Errorf("missing stats fields: %s", r.body)
	}
}

func TestTargetMustBeUnique(t *testing.T) {
	twin := factorio()
	twin.ID = "cccccccccccc3333333333333333333333333333333333333333333333333333"

	h := newHarness(t, 10, factorio(), twin)
	if r := h.call(t, "GET", "/v1/server/status", "", true); r.status != http.StatusServiceUnavailable || code(t, r) != "target_ambiguous" {
		t.Errorf("two matches: status %d %s", r.status, r.body)
	}
	if r := h.call(t, "POST", "/v1/server/stop", "", true); r.status != http.StatusServiceUnavailable || code(t, r) != "target_ambiguous" {
		t.Errorf("two matches on stop: status %d %s", r.status, r.body)
	}
	if twin := h.daemon.State(twin.ID); twin != "running" {
		t.Errorf("an ambiguous target was stopped anyway: %s", twin)
	}

	empty := newHarness(t, 10, panel())
	if r := empty.call(t, "GET", "/v1/server/status", "", true); r.status != http.StatusServiceUnavailable || code(t, r) != "target_missing" {
		t.Errorf("no match: status %d %s", r.status, r.body)
	}
}

func TestOtherProjectIsIgnored(t *testing.T) {
	foreign := factorio()
	foreign.ID = "dddddddddddd4444444444444444444444444444444444444444444444444444"
	foreign.Labels = map[string]string{"com.docker.compose.project": "other", "com.docker.compose.service": "factorio"}

	h := newHarness(t, 10, factorio(), foreign)
	if r := h.call(t, "POST", "/v1/server/stop", "", true); r.status != http.StatusOK {
		t.Fatalf("stop: %d %s", r.status, r.body)
	}
	if state := h.daemon.State(foreign.ID); state != "running" {
		t.Errorf("a container from another project was stopped: %s", state)
	}
}

func TestLogs(t *testing.T) {
	h := newHarness(t, 10, factorio())

	r := h.call(t, "GET", "/v1/server/logs?tail=50", "", true)
	if r.status != http.StatusOK {
		t.Fatalf("status %d: %s", r.status, r.body)
	}
	var body struct {
		Lines []docker.Line `json:"lines"`
	}
	if err := json.Unmarshal([]byte(r.body), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Lines) != 3 || body.Lines[1].Text != "  12.345 Info AppManager.cpp: Saving finished" || body.Lines[2].Stream != "stderr" {
		t.Errorf("unexpected lines: %+v", body.Lines)
	}

	for _, query := range []string{"tail=0", "tail=1001", "tail=abc", "since=-1", "since=1e3"} {
		if r := h.call(t, "GET", "/v1/server/logs?"+query, "", true); r.status != http.StatusBadRequest {
			t.Errorf("?%s: status %d", query, r.status)
		}
	}
	assertOnlyAllowedDaemonCalls(t, h.daemon)
}

func TestStopAndStart(t *testing.T) {
	container := factorio()
	h := newHarness(t, 10, container, panel())

	r := h.call(t, "POST", "/v1/server/stop", `{"timeoutSeconds": 20}`, true)
	if r.status != http.StatusOK || !strings.Contains(r.body, `"changed":true`) || !strings.Contains(r.body, `"state":"exited"`) {
		t.Fatalf("stop: %d %s", r.status, r.body)
	}

	r = h.call(t, "POST", "/v1/server/stop", "", true)
	if r.status != http.StatusOK || !strings.Contains(r.body, `"changed":false`) {
		t.Fatalf("second stop: %d %s", r.status, r.body)
	}

	r = h.call(t, "POST", "/v1/server/start", "{}", true)
	if r.status != http.StatusOK || !strings.Contains(r.body, `"state":"running"`) {
		t.Fatalf("start: %d %s", r.status, r.body)
	}

	r = h.call(t, "POST", "/v1/server/restart", "", true)
	if r.status != http.StatusOK {
		t.Fatalf("restart: %d %s", r.status, r.body)
	}

	stops := 0
	for _, request := range h.daemon.Requests() {
		if strings.HasSuffix(request.Path, "/stop") {
			stops++
			if !strings.Contains(request.Path, container.ID) {
				t.Errorf("stop sent to the wrong container: %s", request.Path)
			}
		}
	}
	if stops != 2 {
		t.Errorf("expected 2 stops, the daemon saw %d", stops)
	}
	if h.daemon.Requests()[1].Query != "t=20" {
		t.Errorf("grace period not forwarded: %+v", h.daemon.Requests()[1])
	}
	assertOnlyAllowedDaemonCalls(t, h.daemon)
}

func TestMutationBodiesAreStrict(t *testing.T) {
	h := newHarness(t, 100, factorio())

	for _, body := range []string{
		`{"timeoutSeconds": 5}`,
		`{"timeoutSeconds": 301}`,
		`{"timeoutSeconds": "60"}`,
		`{"timeoutSecond": 60}`,
		`{"timeoutSeconds": 60, "timeoutSeconds": 20}`,
		`{"timeoutSeconds": 60, "container": "` + panel().ID + `"}`,
		`not json`,
		`{"timeoutSeconds": 60}` + strings.Repeat(" ", 2048),
	} {
		if r := h.call(t, "POST", "/v1/server/stop", body, true); r.status != http.StatusBadRequest {
			t.Errorf("stop with %.60q: status %d", body, r.status)
		}
	}
	if r := h.call(t, "POST", "/v1/server/start", `{"id": "x"}`, true); r.status != http.StatusBadRequest {
		t.Errorf("start with a body: status %d", r.status)
	}

	if state := h.daemon.State(factorio().ID); state != "running" {
		t.Errorf("a refused request still acted: %s", state)
	}
}

func TestConcurrentMutationsAreRefused(t *testing.T) {
	h := newHarness(t, 10, factorio())
	h.daemon.StopDelay = 300 * time.Millisecond

	var (
		wg       sync.WaitGroup
		statuses = make([]int, 2)
	)
	for i := range statuses {
		wg.Go(func() {
			statuses[i] = h.call(t, "POST", "/v1/server/stop", "", true).status
		})
		// Lets the first request take the lock before the second arrives.
		time.Sleep(50 * time.Millisecond)
	}
	wg.Wait()

	if statuses[0] != http.StatusOK || statuses[1] != http.StatusConflict {
		t.Errorf("statuses %v, want [200 409]", statuses)
	}
}

func TestMutationsAreRateLimited(t *testing.T) {
	h := newHarness(t, 2, factorio())

	for i := range 2 {
		if r := h.call(t, "POST", "/v1/server/start", "", true); r.status != http.StatusOK {
			t.Fatalf("call %d: status %d", i, r.status)
		}
	}
	r := h.call(t, "POST", "/v1/server/start", "", true)
	if r.status != http.StatusTooManyRequests || r.header.Get("Retry-After") == "" {
		t.Errorf("third call: status %d, Retry-After %q", r.status, r.header.Get("Retry-After"))
	}
	// Reads are not rate limited: the panel polls them.
	if r := h.call(t, "GET", "/v1/server/status", "", true); r.status != http.StatusOK {
		t.Errorf("status after the limit: %d", r.status)
	}
}
