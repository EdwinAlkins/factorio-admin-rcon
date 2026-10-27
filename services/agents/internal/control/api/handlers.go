package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/agentkit"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/control/config"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/docker"
)

// ContainerStatus is everything the agent ever says about the container. It is
// built field by field from the inspect: nothing else the daemon returns
// (environment, mounts, labels, network settings) can reach a response.
type ContainerStatus struct {
	State        string `json:"state"`
	Health       string `json:"health,omitzero"`
	StartedAt    string `json:"startedAt,omitzero"`
	FinishedAt   string `json:"finishedAt,omitzero"`
	ExitCode     int    `json:"exitCode"`
	RestartCount int    `json:"restartCount"`
	Image        string `json:"image"`
}

// Docker reports "never" as the zero time rather than leaving the field out.
const dockerZeroTime = "0001-01-01T00:00:00Z"

func statusOf(inspect docker.Inspect) ContainerStatus {
	status := ContainerStatus{
		State:        inspect.State.Status,
		ExitCode:     inspect.State.ExitCode,
		RestartCount: inspect.RestartCount,
		Image:        inspect.Config.Image,
	}
	if inspect.State.Health != nil {
		status.Health = inspect.State.Health.Status
	}
	if inspect.State.StartedAt != dockerZeroTime {
		status.StartedAt = inspect.State.StartedAt
	}
	if inspect.State.FinishedAt != dockerZeroTime {
		status.FinishedAt = inspect.State.FinishedAt
	}
	return status
}

type statusResponse struct {
	OK        bool            `json:"ok"`
	Container ContainerStatus `json:"container"`
}

type statsResponse struct {
	OK    bool         `json:"ok"`
	Stats docker.Stats `json:"stats"`
}

type logsResponse struct {
	OK    bool          `json:"ok"`
	Lines []docker.Line `json:"lines"`
}

type mutationResponse struct {
	OK bool `json:"ok"`
	// false when the container was already in the requested state.
	Changed   bool            `json:"changed"`
	Container ContainerStatus `json:"container"`
}

// read resolves the target and runs `fn` against it, retrying once with a
// fresh lookup when the cached id turns out to be stale.
func (s *Server) read(ctx context.Context, fn func(ctx context.Context, id string) error) error {
	ctx, cancel := context.WithTimeout(ctx, readTimeout)
	defer cancel()

	for attempt := 0; ; attempt++ {
		id, err := s.target.ForRead(ctx)
		if err != nil {
			return err
		}
		err = fn(ctx, id)
		if errors.Is(err, docker.ErrNotFound) && attempt == 0 {
			s.target.Forget()
			continue
		}
		return err
	}
}

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	var inspect docker.Inspect
	err := s.read(r.Context(), func(ctx context.Context, id string) (err error) {
		inspect, err = s.docker.Inspect(ctx, id)
		return err
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	agentkit.WriteJSON(w, http.StatusOK, statusResponse{OK: true, Container: statusOf(inspect)})
}

func (s *Server) stats(w http.ResponseWriter, r *http.Request) {
	var stats docker.Stats
	err := s.read(r.Context(), func(ctx context.Context, id string) (err error) {
		stats, err = s.docker.Stats(ctx, id)
		return err
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	agentkit.WriteJSON(w, http.StatusOK, statsResponse{OK: true, Stats: stats})
}

// Bounds on `?tail=`: enough to see a full startup, not enough to turn the
// agent into a bulk export of the container's history.
const (
	defaultLogTail = 200
	maxLogTail     = 1000
)

func (s *Server) logs(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()

	tail, err := agentkit.IntParam(query.Get("tail"), defaultLogTail, 1, maxLogTail)
	if err != nil {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_query", "tail: "+err.Error())
		return
	}
	since, err := agentkit.IntParam(query.Get("since"), 0, 0, 1<<40)
	if err != nil {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_query", "since: "+err.Error())
		return
	}

	var lines []docker.Line
	err = s.read(r.Context(), func(ctx context.Context, id string) error {
		// The TTY flag decides how the stream is framed; reading it costs one
		// inspect, which is negligible next to the logs themselves.
		inspect, err := s.docker.Inspect(ctx, id)
		if err != nil {
			return err
		}
		lines, err = s.docker.Logs(ctx, id, docker.LogsOptions{
			Tail:  tail,
			Since: int64(since),
			Tty:   inspect.Config.Tty,
		})
		return err
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if lines == nil {
		lines = []docker.Line{}
	}
	agentkit.WriteJSON(w, http.StatusOK, logsResponse{OK: true, Lines: lines})
}

type stopBody struct {
	TimeoutSeconds *int `json:"timeoutSeconds"`
}

// stopTimeoutOf validates the optional grace period of a stop or restart.
func (s *Server) stopTimeoutOf(w http.ResponseWriter, r *http.Request) (time.Duration, bool) {
	var body stopBody
	if err := agentkit.ReadBody(w, r, &body, maxBodyBytes); err != nil {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", err.Error())
		return 0, false
	}
	if body.TimeoutSeconds == nil {
		return s.stopTimeout, true
	}

	timeout := time.Duration(*body.TimeoutSeconds) * time.Second
	if timeout < config.MinStopTimeout || timeout > config.MaxStopTimeout {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", fmt.Sprintf("timeoutSeconds: expected an integer between %d and %d",
			int(config.MinStopTimeout.Seconds()), int(config.MaxStopTimeout.Seconds())))
		return 0, false
	}
	return timeout, true
}

// writeContext outlives the caller's request: once the daemon has been asked
// to stop the server, abandoning the call when the panel's request is
// cancelled would release the lock while the operation is still running. The
// deadline covers Docker's own grace period plus a margin for the daemon.
func writeContext(r *http.Request, grace time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(r.Context()), grace+30*time.Second)
}

// act runs one mutation against a freshly resolved target, then reports the
// container's state after it.
func (s *Server) act(w http.ResponseWriter, r *http.Request, grace time.Duration, operation string,
	run func(ctx context.Context, id string) (bool, error)) {
	ctx, cancel := writeContext(r, grace)
	defer cancel()

	id, err := s.target.ForWrite(ctx)
	if err != nil {
		s.fail(w, r, err)
		return
	}

	started := time.Now()
	changed, err := run(ctx, id)
	if err != nil {
		s.fail(w, r, err)
		return
	}

	inspect, err := s.docker.Inspect(ctx, id)
	if err != nil {
		s.fail(w, r, err)
		return
	}

	s.log.InfoContext(r.Context(), "operation done",
		"operation", operation,
		"changed", changed,
		"state", inspect.State.Status,
		"duration", time.Since(started),
	)
	agentkit.WriteJSON(w, http.StatusOK, mutationResponse{OK: true, Changed: changed, Container: statusOf(inspect)})
}

func (s *Server) start(w http.ResponseWriter, r *http.Request) {
	// Start takes no parameter, but a body is still decoded so that a typo
	// ("timeoutSecond") is reported instead of silently ignored.
	if err := agentkit.ReadBody(w, r, &struct{}{}, maxBodyBytes); err != nil {
		agentkit.WriteError(w, http.StatusBadRequest, "bad_body", err.Error())
		return
	}
	s.act(w, r, 0, "start", s.docker.Start)
}

func (s *Server) stop(w http.ResponseWriter, r *http.Request) {
	grace, ok := s.stopTimeoutOf(w, r)
	if !ok {
		return
	}
	s.act(w, r, grace, "stop", func(ctx context.Context, id string) (bool, error) {
		return s.docker.Stop(ctx, id, grace)
	})
}

func (s *Server) restart(w http.ResponseWriter, r *http.Request) {
	grace, ok := s.stopTimeoutOf(w, r)
	if !ok {
		return
	}
	s.act(w, r, grace, "restart", func(ctx context.Context, id string) (bool, error) {
		return true, s.docker.Restart(ctx, id, grace)
	})
}
