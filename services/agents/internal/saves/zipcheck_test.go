package saves

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/fakesave"
)

func check(t *testing.T, data []byte) error {
	t.Helper()
	path := filepath.Join(t.TempDir(), "x.zip")
	must(t, os.WriteFile(path, data, 0o600))
	f, err := os.Open(path)
	must(t, err)
	defer f.Close()
	return VerifySave(f, int64(len(data)))
}

func TestVerifySave(t *testing.T) {
	if err := check(t, fakesave.Valid(t, "_autosave1", "x")); err != nil {
		t.Fatalf("valid save refused: %v", err)
	}

	valid := fakesave.Valid(t, "_autosave1", "x")
	for name, data := range map[string][]byte{
		"not a zip":     []byte("hello"),
		"truncated":     valid[:len(valid)/2],
		"bad crc":       fakesave.CorruptCRC(t, "_autosave1"),
		"no level data": fakesave.Build(t, map[string]string{"x/control.lua": "--"}),
		"parent path":   fakesave.Build(t, map[string]string{"../level.dat0": "x"}),
		"absolute path": fakesave.Build(t, map[string]string{"/x/level.dat0": "x"}),
		"empty":         fakesave.Build(t, map[string]string{}),
	} {
		if err := check(t, data); !errors.Is(err, ErrInvalidArchive) {
			t.Errorf("%s: got %v", name, err)
		}
	}
}
