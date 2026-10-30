package mods

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/fakesave"
)

func verifyBytes(t *testing.T, archive []byte, name, version string) error {
	t.Helper()
	path := filepath.Join(t.TempDir(), "mod.zip")
	if err := os.WriteFile(path, archive, 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	return VerifyModArchive(f, int64(len(archive)), name, version)
}

func TestVerifyModArchive(t *testing.T) {
	info := `{"name":"flib","version":"1.0.0"}`
	cases := map[string]struct {
		entries map[string]string
		valid   bool
	}{
		"versioned folder": {map[string]string{"flib_1.0.0/info.json": info, "flib_1.0.0/data.lua": ""}, true},
		"plain folder":     {map[string]string{"flib/info.json": info}, true},
		"escaping name":    {map[string]string{"flib_1.0.0/info.json": info, "flib_1.0.0/../../evil.lua": ""}, false},
		"absolute name":    {map[string]string{"flib_1.0.0/info.json": info, "/etc/cron.d/x": ""}, false},
		"two top folders":  {map[string]string{"flib_1.0.0/info.json": info, "other/info.json": info}, false},
		"wrong folder":     {map[string]string{"other_1.0.0/info.json": info}, false},
		"lying info.json":  {map[string]string{"flib_1.0.0/info.json": `{"name":"flib","version":"9.9.9"}`}, false},
		"no info.json":     {map[string]string{"flib_1.0.0/data.lua": ""}, false},
		"broken info.json": {map[string]string{"flib_1.0.0/info.json": `{`}, false},
	}
	for label, c := range cases {
		err := verifyBytes(t, fakesave.Build(t, c.entries), "flib", "1.0.0")
		if c.valid != (err == nil) {
			t.Errorf("%s: %v", label, err)
		}
		if err != nil && !errors.Is(err, ErrInvalidMod) {
			t.Errorf("%s: %v is not ErrInvalidMod", label, err)
		}
	}

	if err := verifyBytes(t, fakesave.CorruptCRC(t, "flib_1.0.0"), "flib", "1.0.0"); !errors.Is(err, ErrInvalidMod) {
		t.Errorf("bad CRC: %v", err)
	}
	if err := verifyBytes(t, []byte("not a zip"), "flib", "1.0.0"); !errors.Is(err, ErrInvalidMod) {
		t.Errorf("garbage: %v", err)
	}
}
