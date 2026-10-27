package agentkit

import (
	"fmt"
	"os"
	"strings"
)

// MinTokenBytes is the shortest shared token accepted: below it, the token is
// guessable enough that the bearer check stops meaning anything.
const MinTokenBytes = 32

// Getter reads one variable, trimmed, with a fallback for unset or blank.
type Getter func(key, fallback string) string

// Env wraps a lookup function (os.LookupEnv in production, a map in tests).
func Env(lookup func(string) (string, bool)) Getter {
	return func(key, fallback string) string {
		if value, ok := lookup(key); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
		return fallback
	}
}

// ReadToken reads `<prefix>_TOKEN_FILE`, or `<prefix>_TOKEN` when no file is
// set. The file (a Compose secret) is preferred: a token in the environment
// shows up in `docker inspect`.
func ReadToken(get Getter, prefix string) ([]byte, error) {
	var token string
	if path := get(prefix+"_TOKEN_FILE", ""); path != "" {
		raw, err := os.ReadFile(path) //nolint:gosec // G304: the path is the operator's own setting
		if err != nil {
			return nil, fmt.Errorf("%s_TOKEN_FILE: %w", prefix, err)
		}
		token = strings.TrimSpace(string(raw))
	} else {
		token = get(prefix+"_TOKEN", "")
	}

	if len(token) < MinTokenBytes {
		return nil, fmt.Errorf("%s token: at least %d characters required (set %s_TOKEN_FILE)", prefix, MinTokenBytes, prefix)
	}
	return []byte(token), nil
}

// CheckLogLevel validates LOG_LEVEL.
func CheckLogLevel(level string) error {
	switch level {
	case "debug", "info", "warn", "error":
		return nil
	default:
		return fmt.Errorf("LOG_LEVEL: %q is not one of debug, info, warn, error", level)
	}
}
