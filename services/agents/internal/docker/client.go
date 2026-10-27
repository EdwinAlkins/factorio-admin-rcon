// Package docker is a deliberately tiny Docker Engine API client.
//
// It implements the handful of calls the agent needs and nothing else: there
// is no exec, no create, no delete, no image, volume or network call, so no
// bug elsewhere in the agent can reach them. The official SDK would bring all
// of them in, along with a large dependency tree, for seven requests.
package docker

import (
	"context"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// ErrNotFound is returned when the daemon answers 404: the container was
// removed or recreated since it was resolved.
var ErrNotFound = errors.New("docker: no such container")

// APIError is any other non-success answer from the daemon.
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("docker: HTTP %d: %s", e.Status, e.Message)
}

// Upper bound on any JSON answer the agent decodes. An inspect or a stats
// reading is a few kilobytes; a daemon (or something impersonating it) sending
// more is not to be trusted with the agent's memory.
const maxJSONBytes = 4 << 20

type Client struct {
	http *http.Client
	base string
}

// New returns a client speaking HTTP over the Unix socket at `socket`.
// Per-call deadlines come from the context; the transport only bounds the dial.
func New(socket, apiVersion string) *Client {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialUnix(ctx, "unix", nil, &net.UnixAddr{Name: socket, Net: "unix"})
		},
		MaxIdleConns:    4,
		IdleConnTimeout: 30 * time.Second,
	}
	return &Client{
		http: &http.Client{Transport: transport},
		// The host is ignored by the dialer; "docker" only names it in errors.
		base: "http://docker/v" + apiVersion,
	}
}

// Container is the part of `GET /containers/json` the agent reads.
type Container struct {
	ID    string   `json:"Id"`
	Names []string `json:"Names"`
}

// Inspect is the part of `GET /containers/{id}/json` the agent reads.
//
// The struct is the allow-list: `Config.Env`, mounts, network settings and
// everything else the daemon returns are dropped by the decoder and never
// exist in the agent's memory, let alone in a response.
type Inspect struct {
	ID           string `json:"Id"`
	RestartCount int    `json:"RestartCount"`
	State        struct {
		Status     string `json:"Status"`
		ExitCode   int    `json:"ExitCode"`
		StartedAt  string `json:"StartedAt"`
		FinishedAt string `json:"FinishedAt"`
		Health     *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
	Config struct {
		Image  string            `json:"Image"`
		Tty    bool              `json:"Tty"`
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
}

// Stats is the part of `GET /containers/{id}/stats` the panel's metrics use.
type Stats struct {
	CPUStats    CPUStats    `json:"cpu_stats"`
	PreCPUStats CPUStats    `json:"precpu_stats"`
	MemoryStats MemoryStats `json:"memory_stats"`
}

type CPUStats struct {
	CPUUsage struct {
		TotalUsage  uint64   `json:"total_usage"`
		PercpuUsage []uint64 `json:"percpu_usage,omitzero"`
	} `json:"cpu_usage"`
	SystemCPUUsage uint64 `json:"system_cpu_usage"`
	OnlineCPUs     int    `json:"online_cpus"`
}

type MemoryStats struct {
	Usage uint64 `json:"usage"`
	Limit uint64 `json:"limit"`
	// cgroup v2 exposes `inactive_file`, cgroup v1 `total_inactive_file`.
	// `omitzero` keeps the absent one absent: the panel picks whichever is
	// present, and a 0 standing in for the missing field would win.
	Stats struct {
		InactiveFile      uint64 `json:"inactive_file,omitzero"`
		TotalInactiveFile uint64 `json:"total_inactive_file,omitzero"`
	} `json:"stats"`
}

// ListContainers returns every container, running or not, carrying all of
// `labels` (each of the form "key=value").
func (c *Client) ListContainers(ctx context.Context, labels []string) ([]Container, error) {
	filters, err := json.Marshal(map[string][]string{"label": labels})
	if err != nil {
		return nil, err
	}
	query := url.Values{"all": {"1"}, "filters": {string(filters)}}

	var found []Container
	return found, c.getJSON(ctx, "/containers/json", query, &found)
}

func (c *Client) Inspect(ctx context.Context, id string) (Inspect, error) {
	var inspect Inspect
	return inspect, c.getJSON(ctx, "/containers/"+url.PathEscape(id)+"/json", nil, &inspect)
}

// Stats takes one reading. With `stream=false` the daemon fills
// `precpu_stats` itself, so both ends of the CPU delta come from one answer.
func (c *Client) Stats(ctx context.Context, id string) (Stats, error) {
	var stats Stats
	query := url.Values{"stream": {"false"}}
	return stats, c.getJSON(ctx, "/containers/"+url.PathEscape(id)+"/stats", query, &stats)
}

// Start answers changed=false when the container was already running (304).
func (c *Client) Start(ctx context.Context, id string) (changed bool, err error) {
	return c.post(ctx, "/containers/"+url.PathEscape(id)+"/start", nil)
}

// Stop sends SIGTERM, then SIGKILL after `timeout`. Answers changed=false when
// the container was already stopped (304).
func (c *Client) Stop(ctx context.Context, id string, timeout time.Duration) (changed bool, err error) {
	query := url.Values{"t": {strconv.Itoa(int(timeout.Seconds()))}}
	return c.post(ctx, "/containers/"+url.PathEscape(id)+"/stop", query)
}

func (c *Client) Restart(ctx context.Context, id string, timeout time.Duration) error {
	query := url.Values{"t": {strconv.Itoa(int(timeout.Seconds()))}}
	_, err := c.post(ctx, "/containers/"+url.PathEscape(id)+"/restart", query)
	return err
}

func (c *Client) getJSON(ctx context.Context, path string, query url.Values, into any) error {
	response, err := c.do(ctx, http.MethodGet, path, query)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return failure(response)
	}
	return json.UnmarshalRead(io.LimitReader(response.Body, maxJSONBytes), into)
}

func (c *Client) post(ctx context.Context, path string, query url.Values) (bool, error) {
	response, err := c.do(ctx, http.MethodPost, path, query)
	if err != nil {
		return false, err
	}
	defer response.Body.Close()

	switch response.StatusCode {
	case http.StatusNoContent, http.StatusOK:
		return true, nil
	case http.StatusNotModified:
		return false, nil
	default:
		return false, failure(response)
	}
}

func (c *Client) do(ctx context.Context, method, path string, query url.Values) (*http.Response, error) {
	target := c.base + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}

	request, err := http.NewRequestWithContext(ctx, method, target, nil)
	if err != nil {
		return nil, err
	}
	return c.http.Do(request)
}

// failure turns a non-success answer into an error, keeping the daemon's own
// message (bounded) for the agent's log.
func failure(response *http.Response) error {
	if response.StatusCode == http.StatusNotFound {
		return ErrNotFound
	}

	var body struct {
		Message string `json:"message"`
	}
	_ = json.UnmarshalRead(io.LimitReader(response.Body, 4096), &body)
	return &APIError{Status: response.StatusCode, Message: body.Message}
}
