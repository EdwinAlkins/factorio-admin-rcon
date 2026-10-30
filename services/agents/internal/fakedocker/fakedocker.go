// Package fakedocker is an in-process stand-in for the Docker daemon, served
// on a real Unix socket so the agent's client is exercised end to end. It
// records every request it receives: the security tests assert as much on
// what never reached the daemon as on what did.
package fakedocker

import (
	"encoding/binary"
	"encoding/json/v2"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// Container is one fake container. Env and Mounts exist so tests can check
// they never leak through the agent.
type Container struct {
	ID     string
	Labels map[string]string
	Env    []string
	State  string
	Tty    bool
	// Output lines, served by /logs.
	Stdout []string
	Stderr []string
}

type Request struct {
	Method string
	Path   string
	Query  string
}

type Daemon struct {
	Socket string

	mu         sync.Mutex
	containers []*Container
	requests   []Request
	// Delay applied to stop and restart, to hold the agent's lock open.
	StopDelay time.Duration
}

// Start serves a daemon with the given containers until the test ends.
func Start(t *testing.T, containers ...*Container) *Daemon {
	t.Helper()

	// Unix socket paths are limited to ~108 bytes; t.TempDir() can exceed it.
	dir, err := os.MkdirTemp("", "fakedocker")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	socket := filepath.Join(dir, "docker.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}

	daemon := &Daemon{Socket: socket, containers: containers}
	server := httptest.NewUnstartedServer(http.HandlerFunc(daemon.serve))
	server.Listener = listener
	server.Start()
	t.Cleanup(server.Close)

	return daemon
}

// Requests returns a copy of every request received so far.
func (d *Daemon) Requests() []Request {
	d.mu.Lock()
	defer d.mu.Unlock()
	return slices.Clone(d.requests)
}

// State returns a container's current state.
func (d *Daemon) State(id string) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	if c := d.find(id); c != nil {
		return c.State
	}
	return ""
}

func (d *Daemon) find(id string) *Container {
	for _, c := range d.containers {
		if c.ID == id || (len(id) >= 12 && strings.HasPrefix(c.ID, id)) {
			return c
		}
	}
	return nil
}

func (d *Daemon) serve(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	d.requests = append(d.requests, Request{Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery})
	d.mu.Unlock()

	// Strip the pinned version prefix ("/v1.43").
	path := r.URL.Path
	if strings.HasPrefix(path, "/v1.") {
		if i := strings.Index(path[1:], "/"); i >= 0 {
			path = path[i+1:]
		}
	}

	if r.Method == http.MethodGet && path == "/containers/json" {
		d.list(w, r)
		return
	}

	rest, ok := strings.CutPrefix(path, "/containers/")
	id, action, _ := strings.Cut(rest, "/")
	if !ok {
		http.Error(w, `{"message":"page not found"}`, http.StatusNotFound)
		return
	}

	d.mu.Lock()
	container := d.find(id)
	d.mu.Unlock()
	if container == nil {
		w.WriteHeader(http.StatusNotFound)
		_ = json.MarshalWrite(w, map[string]string{"message": "No such container: " + id})
		return
	}

	switch {
	case r.Method == http.MethodGet && action == "json":
		d.inspect(w, container)
	case r.Method == http.MethodGet && action == "stats":
		_ = json.MarshalWrite(w, map[string]any{
			"cpu_stats":    map[string]any{"cpu_usage": map[string]any{"total_usage": 2000}, "system_cpu_usage": 20000, "online_cpus": 4},
			"precpu_stats": map[string]any{"cpu_usage": map[string]any{"total_usage": 1000}, "system_cpu_usage": 10000, "online_cpus": 4},
			"memory_stats": map[string]any{"usage": 500, "limit": 1000, "stats": map[string]any{"inactive_file": 100}},
			// Real stats carry much more; none of it may come out of the agent.
			"networks": map[string]any{"eth0": map[string]any{"rx_bytes": 1}},
		})
	case r.Method == http.MethodGet && action == "logs":
		d.logs(w, container)
	case r.Method == http.MethodPost && action == "start":
		d.transition(w, container, "running", 0)
	case r.Method == http.MethodPost && action == "stop":
		d.transition(w, container, "exited", d.StopDelay)
	case r.Method == http.MethodPost && action == "restart":
		time.Sleep(d.StopDelay)
		d.mu.Lock()
		container.State = "running"
		d.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, `{"message":"unsupported by fake"}`, http.StatusNotImplemented)
	}
}

func (d *Daemon) list(w http.ResponseWriter, r *http.Request) {
	var filters map[string][]string
	_ = json.Unmarshal([]byte(r.URL.Query().Get("filters")), &filters)

	d.mu.Lock()
	defer d.mu.Unlock()

	found := []map[string]any{}
	for _, c := range d.containers {
		matches := true
		for _, label := range filters["label"] {
			key, value, _ := strings.Cut(label, "=")
			if c.Labels[key] != value {
				matches = false
			}
		}
		if matches {
			found = append(found, map[string]any{"Id": c.ID, "Names": []string{"/" + c.ID}})
		}
	}
	_ = json.MarshalWrite(w, found)
}

func (d *Daemon) inspect(w http.ResponseWriter, c *Container) {
	d.mu.Lock()
	defer d.mu.Unlock()

	_ = json.MarshalWrite(w, map[string]any{
		"Id":           c.ID,
		"RestartCount": 0,
		"State": map[string]any{
			"Status":     c.State,
			"ExitCode":   0,
			"StartedAt":  "2026-10-27T10:00:00Z",
			"FinishedAt": "0001-01-01T00:00:00Z",
		},
		"Config": map[string]any{
			"Image":  "factoriotools/factorio:stable",
			"Tty":    c.Tty,
			"Labels": c.Labels,
			"Env":    c.Env,
		},
		"Mounts": []map[string]any{{"Source": "/srv/secret", "Destination": "/factorio"}},
	})
}

func (d *Daemon) logs(w http.ResponseWriter, c *Container) {
	if c.Tty {
		for _, line := range c.Stdout {
			_, _ = w.Write([]byte(line + "\n"))
		}
		return
	}
	for _, line := range c.Stdout {
		writeFrame(w, 1, line+"\n")
	}
	for _, line := range c.Stderr {
		writeFrame(w, 2, line+"\n")
	}
}

func writeFrame(w http.ResponseWriter, stream byte, payload string) {
	var header [8]byte
	header[0] = stream
	binary.BigEndian.PutUint32(header[4:], uint32(len(payload)))
	_, _ = w.Write(header[:])
	_, _ = w.Write([]byte(payload))
}

func (d *Daemon) transition(w http.ResponseWriter, c *Container, to string, delay time.Duration) {
	time.Sleep(delay)

	d.mu.Lock()
	defer d.mu.Unlock()
	if c.State == to {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	c.State = to
	w.WriteHeader(http.StatusNoContent)
}
