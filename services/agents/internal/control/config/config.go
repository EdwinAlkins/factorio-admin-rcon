// Package config reads and validates the agent's environment, once, at
// startup. A malformed value must stop the agent before it opens a port, not
// surface on the first request.
package config

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/agentkit"
)

// Bounds on the grace period given to Factorio before Docker kills it. Below
// 10 s a large map cannot finish writing its save; above 5 min an operator is
// better served by an error than by a request that hangs.
const (
	MinStopTimeout = 10 * time.Second
	MaxStopTimeout = 300 * time.Second
)

type Config struct {
	ListenAddr string
	// Path of the Docker socket inside the agent's container.
	DockerSocket string
	// Pinned rather than negotiated: the agent only calls endpoints that have
	// been stable since 1.41, and a pinned version keeps responses predictable.
	DockerAPIVersion string
	// Compose identity of the one container the agent may act on. An empty
	// project means "the agent's own project", discovered at startup.
	TargetService string
	TargetProject string
	Token         []byte
	StopTimeout   time.Duration
	// Start/stop/restart requests accepted per minute, all callers together.
	MutationsPerMinute int
	LogLevel           string
}

// Load reads the configuration from a lookup function (os.LookupEnv in
// production, a map in tests).
func Load(lookup func(string) (string, bool)) (Config, error) {
	get := agentkit.Env(lookup)

	cfg := Config{
		ListenAddr:       get("LISTEN_ADDR", ":8080"),
		DockerSocket:     get("DOCKER_SOCKET", "/var/run/docker.sock"),
		DockerAPIVersion: get("DOCKER_API_VERSION", "1.43"),
		TargetService:    get("TARGET_SERVICE", "factorio"),
		TargetProject:    get("TARGET_PROJECT", ""),
		LogLevel:         get("LOG_LEVEL", "info"),
	}

	var errs []error

	if !validAPIVersion(cfg.DockerAPIVersion) {
		errs = append(errs, fmt.Errorf("DOCKER_API_VERSION: %q is not of the form 1.NN", cfg.DockerAPIVersion))
	}

	if err := agentkit.CheckLogLevel(cfg.LogLevel); err != nil {
		errs = append(errs, err)
	}

	token, err := agentkit.ReadToken(get, "CONTROL_AGENT")
	if err != nil {
		errs = append(errs, err)
	}
	cfg.Token = token

	seconds, err := strconv.Atoi(get("STOP_TIMEOUT_SECONDS", "60"))
	cfg.StopTimeout = time.Duration(seconds) * time.Second
	if err != nil || cfg.StopTimeout < MinStopTimeout || cfg.StopTimeout > MaxStopTimeout {
		errs = append(errs, fmt.Errorf("STOP_TIMEOUT_SECONDS: must be an integer between %d and %d",
			int(MinStopTimeout.Seconds()), int(MaxStopTimeout.Seconds())))
	}

	cfg.MutationsPerMinute, err = strconv.Atoi(get("MUTATIONS_PER_MINUTE", "10"))
	if err != nil || cfg.MutationsPerMinute < 1 {
		errs = append(errs, errors.New("MUTATIONS_PER_MINUTE: must be a positive integer"))
	}

	if err := errors.Join(errs...); err != nil {
		return Config{}, fmt.Errorf("invalid configuration: %w", err)
	}
	return cfg, nil
}

func validAPIVersion(version string) bool {
	major, minor, ok := strings.Cut(version, ".")
	if !ok || major != "1" {
		return false
	}
	n, err := strconv.Atoi(minor)
	return err == nil && n >= 41
}
