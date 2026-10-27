// Package config reads and validates the agent's environment, once, at
// startup. A malformed value must stop the agent before it opens a port, not
// surface on the first request.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// MinTokenBytes is the shortest shared token accepted: below it, the token is
// guessable enough that the bearer check stops meaning anything.
const MinTokenBytes = 32

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
	get := func(key, fallback string) string {
		if value, ok := lookup(key); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
		return fallback
	}

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

	switch cfg.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		errs = append(errs, fmt.Errorf("LOG_LEVEL: %q is not one of debug, info, warn, error", cfg.LogLevel))
	}

	token, err := readToken(get)
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

// readToken prefers the file (a Compose secret) over the variable: a token in
// the environment shows up in `docker inspect`.
func readToken(get func(string, string) string) ([]byte, error) {
	var token string
	if path := get("CONTROL_AGENT_TOKEN_FILE", ""); path != "" {
		raw, err := os.ReadFile(path) //nolint:gosec // G304: the path is the operator's own setting
		if err != nil {
			return nil, fmt.Errorf("CONTROL_AGENT_TOKEN_FILE: %w", err)
		}
		token = strings.TrimSpace(string(raw))
	} else {
		token = get("CONTROL_AGENT_TOKEN", "")
	}

	if len(token) < MinTokenBytes {
		return nil, fmt.Errorf("control agent token: at least %d characters required (set CONTROL_AGENT_TOKEN_FILE)", MinTokenBytes)
	}
	return []byte(token), nil
}

func validAPIVersion(version string) bool {
	major, minor, ok := strings.Cut(version, ".")
	if !ok || major != "1" {
		return false
	}
	n, err := strconv.Atoi(minor)
	return err == nil && n >= 41
}
