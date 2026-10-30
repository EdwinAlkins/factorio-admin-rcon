package serversettings

import (
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fixture struct {
	store                 *Store
	configDir, historyDir string
	clock                 time.Time
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{configDir: t.TempDir(), historyDir: t.TempDir(), clock: time.Date(2026, 10, 28, 10, 15, 0, 0, time.UTC)}
	example, err := os.ReadFile("testdata/server-settings.example.json")
	must(t, err)
	must(t, os.WriteFile(filepath.Join(f.configDir, fileName), example, 0o644))
	config, err := os.OpenRoot(f.configDir)
	must(t, err)
	history, err := os.OpenRoot(f.historyDir)
	must(t, err)
	f.store = New(config, history)
	f.store.now = func() time.Time { return f.clock }
	return f
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) file(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(f.configDir, fileName))
	must(t, err)
	return string(raw)
}

func values(pairs map[string]string) map[string]jsontext.Value {
	out := map[string]jsontext.Value{}
	for key, value := range pairs {
		out[key] = jsontext.Value(value)
	}
	return out
}

func TestReadNeverReturnsSecrets(t *testing.T) {
	f := newFixture(t)
	v, err := f.store.Read()
	must(t, err)

	if string(v.Settings["max_players"]) != "0" || string(v.Settings["allow_commands"]) != `"admins-only"` {
		t.Fatalf("settings %v", v.Settings)
	}
	for _, key := range append([]string{"_comment_token", "a_key_from_a_newer_version"}, secrets...) {
		if _, shown := v.Settings[key]; shown {
			t.Errorf("%s shown", key)
		}
	}
	if !v.Secrets["game_password"] || v.Secrets["password"] || v.Secrets["token"] {
		t.Fatalf("secrets %v", v.Secrets)
	}
	raw, _ := json.Marshal(v)
	if strings.Contains(string(raw), "hunter2") {
		t.Fatal("a secret leaked")
	}
	if len(v.Hash) != 64 {
		t.Fatalf("hash %q", v.Hash)
	}
}

func TestUpdateKeepsEverythingItDoesNotTouch(t *testing.T) {
	f := newFixture(t)
	before, err := f.store.Read()
	must(t, err)

	newPassword := "s3cret"
	tx, after, err := f.store.Update(Patch{
		Settings: values(map[string]string{
			"name":                            `"My server"`,
			"max_players":                     "12",
			"visibility":                      `{"lan":false}`,
			"auto_pause_when_players_connect": "true",
		}),
		Secrets: map[string]SecretChange{"game_password": {Set: &newPassword}},
	}, before.Hash)
	must(t, err)
	if tx != "20261028-101500" || after.Hash == before.Hash {
		t.Fatalf("tx %q, hash unchanged: %v", tx, after.Hash == before.Hash)
	}

	text := f.file(t)
	var doc map[string]any
	must(t, json.Unmarshal([]byte(text), &doc))
	if doc["name"] != "My server" || doc["max_players"] != 12.0 || doc["game_password"] != newPassword ||
		doc["auto_pause_when_players_connect"] != true {
		t.Fatalf("values %v", doc)
	}
	if v := doc["visibility"].(map[string]any); v["public"] != false || v["lan"] != false {
		t.Fatalf("visibility merged wrong: %v", v)
	}
	// Comments, unknown keys and order survive.
	if doc["_comment_token"] == nil || doc["a_key_from_a_newer_version"] == nil {
		t.Fatalf("lost members: %v", doc)
	}
	if strings.Index(text, `"name"`) > strings.Index(text, `"_comment_max_players"`) ||
		strings.Index(text, `"auto_pause_when_players_connect"`) < strings.Index(text, `"a_key_from_a_newer_version"`) {
		t.Fatalf("order changed:\n%s", text)
	}
	info, err := os.Stat(filepath.Join(f.configDir, fileName))
	must(t, err)
	if info.Mode().Perm() != 0o644 {
		t.Fatalf("mode %v", info.Mode())
	}

	// The previous version comes back whole.
	must(t, f.store.Rollback(tx))
	original, _ := os.ReadFile("testdata/server-settings.example.json")
	if f.file(t) != string(original) {
		t.Fatal("rollback did not restore the file byte for byte")
	}
}

func TestUpdateRefusals(t *testing.T) {
	f := newFixture(t)
	v, err := f.store.Read()
	must(t, err)
	empty := ""

	for name, patch := range map[string]Patch{
		"unknown key":     {Settings: values(map[string]string{"rcon_password": `"x"`})},
		"secret as plain": {Settings: values(map[string]string{"token": `"x"`})},
		"wrong type":      {Settings: values(map[string]string{"max_players": `"12"`})},
		"fraction":        {Settings: values(map[string]string{"max_players": `1.5`})},
		"below min":       {Settings: values(map[string]string{"max_heartbeats_per_second": `5`})},
		"long name":       {Settings: values(map[string]string{"name": `"` + strings.Repeat("x", 101) + `"`})},
		"control char":    {Settings: values(map[string]string{"name": `"a\u0007"`})},
		"newline":         {Settings: values(map[string]string{"name": `"a\nb"`})},
		"bad mode":        {Settings: values(map[string]string{"allow_commands": `"sometimes"`})},
		"empty tag":       {Settings: values(map[string]string{"tags": `[""]`})},
		"visibility":      {Settings: values(map[string]string{"visibility": `{"public":true,"steam":true}`})},
		"unknown secret":  {Secrets: map[string]SecretChange{"rconpw": {Clear: true}}},
		"set and clear":   {Secrets: map[string]SecretChange{"token": {Set: &empty, Clear: true}}},
		"empty secret":    {Secrets: map[string]SecretChange{"token": {Set: &empty}}},
	} {
		var invalid *InvalidError
		if _, _, err := f.store.Update(patch, v.Hash); !errors.As(err, &invalid) {
			t.Errorf("%s: %v", name, err)
		}
	}

	if _, _, err := f.store.Update(Patch{}, v.Hash); !errors.Is(err, ErrNothingToDo) {
		t.Errorf("empty patch: %v", err)
	}
	ok := Patch{Settings: values(map[string]string{"max_players": "3"})}
	if _, _, err := f.store.Update(ok, strings.Repeat("0", 64)); !errors.Is(err, ErrChanged) {
		t.Errorf("stale hash: %v", err)
	}
	public := Patch{Settings: values(map[string]string{"visibility": `{"public":true}`})}
	if _, _, err := f.store.Update(public, v.Hash); !errors.Is(err, ErrPublicCredentials) {
		t.Errorf("public without credentials: %v", err)
	}
	token := "abc"
	public.Settings["username"] = jsontext.Value(`"factorio-fan"`)
	public.Secrets = map[string]SecretChange{"token": {Set: &token}}
	if _, _, err := f.store.Update(public, v.Hash); err != nil {
		t.Errorf("public with credentials: %v", err)
	}
	if err := f.store.Rollback("../../etc/passwd"); !errors.Is(err, ErrTxNotFound) {
		t.Errorf("rollback path: %v", err)
	}
}

func TestMissingAndUnreadableFiles(t *testing.T) {
	f := newFixture(t)
	must(t, os.Remove(filepath.Join(f.configDir, fileName)))
	if _, err := f.store.Read(); !errors.Is(err, ErrMissing) {
		t.Fatalf("missing: %v", err)
	}
	for _, content := range []string{"", "[1]", `{"a":1} trailing`, `{"a":1,"a":2}`} {
		must(t, os.WriteFile(filepath.Join(f.configDir, fileName), []byte(content), 0o644))
		if _, err := f.store.Read(); !errors.Is(err, ErrUnreadable) {
			t.Errorf("%q: %v", content, err)
		}
	}
}

func TestHistoryIsBounded(t *testing.T) {
	f := newFixture(t)
	for i := range 8 {
		v, err := f.store.Read()
		must(t, err)
		_, _, err = f.store.Update(Patch{Settings: values(map[string]string{"max_players": jsontext.Value([]byte{byte('1' + i)}).String()})}, v.Hash)
		must(t, err)
		f.clock = f.clock.Add(time.Second)
	}
	entries, err := os.ReadDir(f.historyDir)
	must(t, err)
	if len(entries) != keepHistory || entries[0].Name() != "20261028-101503.json" {
		t.Fatalf("history %v", entries)
	}
}
