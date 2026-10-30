// Package target resolves the one container the agent is allowed to act on.
//
// The identity comes from the agent's configuration, never from a request: no
// endpoint takes a container id, so a caller cannot point the agent at the
// panel, at the agent itself or at anything else on the host.
package target

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/docker"
)

var (
	// ErrMissing: no container carries the configured labels (not created
	// yet, or removed by `docker compose down`).
	ErrMissing = errors.New("target container not found")
	// ErrAmbiguous: several containers carry them. Acting on "the first one"
	// would be a guess, and a wrong guess here stops the wrong server.
	ErrAmbiguous = errors.New("several containers match the target labels")
)

const (
	projectLabel = "com.docker.compose.project"
	serviceLabel = "com.docker.compose.service"
)

// Docker is the part of the client the resolver needs.
type Docker interface {
	ListContainers(ctx context.Context, labels []string) ([]docker.Container, error)
}

// Resolver finds the target container and remembers its id briefly.
type Resolver struct {
	docker Docker
	labels []string
	ttl    time.Duration
	now    func() time.Time

	mu       sync.Mutex
	cachedID string
	cachedAt time.Time
}

// readCacheTTL keeps a polling panel from listing containers on every status
// request. Short, because `docker compose up` may recreate the container with
// a new id at any time.
const readCacheTTL = 10 * time.Second

func NewResolver(client Docker, project, service string) *Resolver {
	labels := []string{serviceLabel + "=" + service}
	if project != "" {
		labels = append(labels, projectLabel+"="+project)
	}
	return &Resolver{docker: client, labels: labels, ttl: readCacheTTL, now: time.Now}
}

// Describe names the target for the startup log.
func (r *Resolver) Describe() []string {
	return append([]string(nil), r.labels...)
}

// ForRead may answer from the cache: a stale id costs one 404, after which the
// caller calls Forget and retries.
func (r *Resolver) ForRead(ctx context.Context) (string, error) {
	r.mu.Lock()
	if r.cachedID != "" && r.now().Sub(r.cachedAt) < r.ttl {
		id := r.cachedID
		r.mu.Unlock()
		return id, nil
	}
	r.mu.Unlock()

	return r.resolve(ctx)
}

// ForWrite always asks the daemon: a mutation must act on the container that
// carries the labels now, not on the one that carried them ten seconds ago.
func (r *Resolver) ForWrite(ctx context.Context) (string, error) {
	return r.resolve(ctx)
}

// Forget drops the cached id, after a 404 for instance.
func (r *Resolver) Forget() {
	r.mu.Lock()
	r.cachedID = ""
	r.mu.Unlock()
}

func (r *Resolver) resolve(ctx context.Context) (string, error) {
	found, err := r.docker.ListContainers(ctx, r.labels)
	if err != nil {
		return "", fmt.Errorf("listing containers: %w", err)
	}

	switch len(found) {
	case 0:
		r.Forget()
		return "", ErrMissing
	case 1:
	default:
		r.Forget()
		return "", ErrAmbiguous
	}

	id := found[0].ID
	r.mu.Lock()
	r.cachedID, r.cachedAt = id, r.now()
	r.mu.Unlock()
	return id, nil
}

// OwnProject reads the Compose project of the agent's own container, so the
// target is pinned to the same stack without asking the operator to repeat its
// name. Docker sets a container's hostname to its short id.
func OwnProject(ctx context.Context, client interface {
	Inspect(ctx context.Context, id string) (docker.Inspect, error)
}, hostname string) (string, error) {
	inspect, err := client.Inspect(ctx, hostname)
	if err != nil {
		return "", fmt.Errorf("inspecting own container %q: %w", hostname, err)
	}
	project := inspect.Config.Labels[projectLabel]
	if project == "" {
		return "", fmt.Errorf("own container %q has no %s label", hostname, projectLabel)
	}
	return project, nil
}
