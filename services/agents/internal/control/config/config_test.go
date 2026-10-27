package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const token = "0123456789abcdef0123456789abcdef"

func lookup(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}

func TestDefaults(t *testing.T) {
	cfg, err := Load(lookup(map[string]string{"CONTROL_AGENT_TOKEN": token}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ListenAddr != ":8080" || cfg.DockerAPIVersion != "1.43" || cfg.TargetService != "factorio" ||
		cfg.StopTimeout != 60*time.Second || cfg.MutationsPerMinute != 10 {
		t.Errorf("unexpected defaults: %+v", cfg)
	}
}

func TestTokenFileWins(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte(token+"-from-file\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(lookup(map[string]string{"CONTROL_AGENT_TOKEN_FILE": path, "CONTROL_AGENT_TOKEN": token}))
	if err != nil {
		t.Fatal(err)
	}
	if string(cfg.Token) != token+"-from-file" {
		t.Errorf("token %q", cfg.Token)
	}
}

func TestInvalid(t *testing.T) {
	for name, values := range map[string]map[string]string{
		"no token":           {},
		"short token":        {"CONTROL_AGENT_TOKEN": "short"},
		"missing token file": {"CONTROL_AGENT_TOKEN_FILE": "/does/not/exist"},
		"api version":        {"CONTROL_AGENT_TOKEN": token, "DOCKER_API_VERSION": "2.0"},
		"old api version":    {"CONTROL_AGENT_TOKEN": token, "DOCKER_API_VERSION": "1.24"},
		"stop timeout":       {"CONTROL_AGENT_TOKEN": token, "STOP_TIMEOUT_SECONDS": "5"},
		"mutations":          {"CONTROL_AGENT_TOKEN": token, "MUTATIONS_PER_MINUTE": "0"},
		"log level":          {"CONTROL_AGENT_TOKEN": token, "LOG_LEVEL": "verbose"},
	} {
		if _, err := Load(lookup(values)); err == nil || !strings.Contains(err.Error(), "invalid configuration") {
			t.Errorf("%s: got %v", name, err)
		}
	}
}
