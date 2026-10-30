package mods_test

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/fakeportal"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/mods"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/portal"
)

var game = mods.Version{2, 1, 23}

// A mod-list.json as Factorio writes it, with a field the agent must keep.
const originalList = `{
  "mods": [
    {"name": "base", "enabled": true},
    {"name": "quality", "enabled": true, "future_field": 1},
    {"name": "b", "enabled": true}
  ]
}`

type setup struct {
	fake     *fakeportal.Portal
	modsDir  string
	workDir  string
	manager  *mods.Manager
	original []byte
}

func newSetup(t *testing.T, withCredentials bool) *setup {
	t.Helper()
	s := &setup{fake: fakeportal.New(t), modsDir: t.TempDir(), workDir: t.TempDir(), original: []byte(originalList)}
	s.fake.Publish(t, "b", "1.0.0", "2.1", []string{}, nil)
	s.fake.Publish(t, "b", "1.1.0", "2.1", []string{}, nil)
	s.fake.Publish(t, "a", "1.0.0", "2.1", []string{"base >= 2.1.0", "b >= 1.1.0"}, nil)

	s.write(t, "mod-list.json", s.original)
	s.write(t, "b_1.0.0.zip", fakeportal.ModArchive(t, "b", "1.0.0", []string{}))

	work, err := os.OpenRoot(s.workDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { work.Close() })
	s.manager = mods.NewManager(s.modsDir, work, s.fake.NewClient(t, withCredentials), 1<<20)
	return s
}

func (s *setup) write(t *testing.T, name string, content []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(s.modsDir, name), content, 0o644); err != nil {
		t.Fatal(err)
	}
}

func (s *setup) files(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(s.modsDir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

func (s *setup) modList(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(s.modsDir, "mod-list.json"))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

var installA = []mods.Change{{Action: mods.ActionInstall, Name: "a"}}

func (s *setup) stage(t *testing.T, changes []mods.Change) string {
	t.Helper()
	plan, err := s.manager.Plan(context.Background(), changes, game)
	if err != nil || len(plan.Conflicts) > 0 {
		t.Fatalf("plan: %+v %v", plan, err)
	}
	tx, _, err := s.manager.Stage(context.Background(), changes, game, plan.Hash)
	if err != nil {
		t.Fatalf("stage: %v", err)
	}
	return tx
}

func TestStageCommitRollback(t *testing.T) {
	s := newSetup(t, true)
	tx := s.stage(t, installA)

	// Staging leaves the mods folder alone: the server may still be running.
	if got := s.files(t); !slices.Equal(got, []string{"b_1.0.0.zip", "mod-list.json"}) {
		t.Fatalf("staging touched the mods folder: %v", got)
	}

	if err := s.manager.Commit(tx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if got := s.files(t); !slices.Equal(got, []string{"a_1.0.0.zip", "b_1.1.0.zip", "mod-list.json"}) {
		t.Fatalf("after commit: %v", got)
	}
	list := string(s.modList(t))
	for _, want := range []string{`"name": "a"`, `"future_field": 1`} {
		if !strings.Contains(list, want) {
			t.Errorf("mod-list.json lacks %s:\n%s", want, list)
		}
	}
	if err := s.manager.Commit(tx); !errors.Is(err, mods.ErrAlreadyCommitted) {
		t.Errorf("second commit: %v", err)
	}

	if err := s.manager.Rollback(tx); err != nil {
		t.Fatalf("rollback: %v", err)
	}
	if got := s.files(t); !slices.Equal(got, []string{"b_1.0.0.zip", "mod-list.json"}) {
		t.Fatalf("after rollback: %v", got)
	}
	if !bytes.Equal(s.modList(t), s.original) {
		t.Fatalf("mod-list.json not restored byte for byte:\n%s", s.modList(t))
	}
	// Twice is harmless.
	if err := s.manager.Rollback(tx); err != nil {
		t.Fatalf("second rollback: %v", err)
	}
}

func TestCommitFailingHalfwayRollsBack(t *testing.T) {
	s := newSetup(t, true)
	tx := s.stage(t, installA)

	// The staged copy of `a` gets corrupted after staging: Commit has already
	// set b 1.0.0 aside when it refuses it.
	staged := filepath.Join(s.workDir, tx, "downloads", "a_1.0.0.zip")
	if err := os.WriteFile(staged, []byte("garbage"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := s.manager.Commit(tx); !errors.Is(err, mods.ErrInvalidMod) {
		t.Fatalf("commit: %v", err)
	}
	if err := s.manager.Rollback(tx); err != nil {
		t.Fatalf("rollback: %v", err)
	}
	if got := s.files(t); !slices.Equal(got, []string{"b_1.0.0.zip", "mod-list.json"}) {
		t.Fatalf("after rollback: %v", got)
	}
	if !bytes.Equal(s.modList(t), s.original) {
		t.Fatal("mod-list.json not restored")
	}
}

func TestStageRefusals(t *testing.T) {
	t.Run("changed plan", func(t *testing.T) {
		s := newSetup(t, true)
		if _, _, err := s.manager.Stage(context.Background(), installA, game, "stale"); !errors.Is(err, mods.ErrPlanChanged) {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("bad checksum leaves nothing behind", func(t *testing.T) {
		s := newSetup(t, true)
		s.fake.Tamper("a_1.0.0.zip", fakeportal.ModArchive(t, "a", "1.0.0", []string{"evil"}))
		plan, _ := s.manager.Plan(context.Background(), installA, game)
		if _, _, err := s.manager.Stage(context.Background(), installA, game, plan.Hash); !errors.Is(err, portal.ErrChecksum) {
			t.Fatalf("got %v", err)
		}
		if entries, _ := os.ReadDir(s.workDir); len(entries) != 0 {
			t.Fatalf("a failed stage left %v", entries)
		}
	})

	t.Run("archive that is not the release", func(t *testing.T) {
		s := newSetup(t, true)
		s.fake.Publish(t, "liar", "1.0.0", "2.1", []string{}, fakeportal.ModArchive(t, "other", "1.0.0", []string{}))
		changes := []mods.Change{{Action: mods.ActionInstall, Name: "liar"}}
		plan, _ := s.manager.Plan(context.Background(), changes, game)
		if _, _, err := s.manager.Stage(context.Background(), changes, game, plan.Hash); !errors.Is(err, mods.ErrInvalidMod) {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("conflicts", func(t *testing.T) {
		s := newSetup(t, true)
		changes := []mods.Change{{Action: mods.ActionDisable, Name: "quality"}}
		plan, _ := s.manager.Plan(context.Background(), changes, game)
		if _, _, err := s.manager.Stage(context.Background(), changes, game, plan.Hash); !errors.Is(err, mods.ErrConflict) {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("downloads need credentials, toggles do not", func(t *testing.T) {
		s := newSetup(t, false)
		plan, _ := s.manager.Plan(context.Background(), installA, game)
		if _, _, err := s.manager.Stage(context.Background(), installA, game, plan.Hash); !errors.Is(err, portal.ErrNoCredentials) {
			t.Fatalf("install: %v", err)
		}

		disable := []mods.Change{{Action: mods.ActionDisable, Name: "b"}}
		tx := s.stage(t, disable)
		if err := s.manager.Commit(tx); err != nil {
			t.Fatal(err)
		}
		if list := string(s.modList(t)); !strings.Contains(list, `"name": "b",`+"\n"+`      "enabled": false`) {
			t.Fatalf("b still enabled:\n%s", list)
		}
	})

	t.Run("unknown transaction", func(t *testing.T) {
		s := newSetup(t, true)
		for _, tx := range []string{"../../etc", "20261027-143000-zzzzzz", "20261027-143000-abcdef"} {
			if err := s.manager.Commit(tx); !errors.Is(err, mods.ErrTxNotFound) {
				t.Errorf("%s: %v", tx, err)
			}
		}
	})
}

func TestListShowsUpdates(t *testing.T) {
	s := newSetup(t, false)
	state, err := s.manager.List(context.Background(), game.String())
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]mods.Status{}
	for _, mod := range state.Mods {
		byName[mod.Name] = mod
	}
	if byName["b"].Update != "1.1.0" || byName["b"].Version != "1.0.0" {
		t.Errorf("b: %+v", byName["b"])
	}
	if !byName["quality"].Builtin || !byName["quality"].DLC || byName["quality"].Version != game.String() {
		t.Errorf("quality: %+v", byName["quality"])
	}
	if state.Credentials {
		t.Error("credentials reported without any")
	}

	// Without a mods folder yet (server never started): an empty list.
	empty := mods.NewManager(filepath.Join(t.TempDir(), "absent"), nil, s.fake.NewClient(t, false), 1<<20)
	if state, err := empty.List(context.Background(), ""); err != nil || len(state.Mods) != 0 {
		t.Fatalf("absent folder: %+v %v", state, err)
	}
}

func TestPruneKeepsRecentTransactions(t *testing.T) {
	s := newSetup(t, true)
	disable := []mods.Change{{Action: mods.ActionDisable, Name: "b"}}
	var txs []string
	for range 5 {
		tx := s.stage(t, disable)
		txs = append(txs, tx)
	}
	entries, _ := os.ReadDir(s.workDir)
	if len(entries) > 3 {
		t.Fatalf("kept %d transactions", len(entries))
	}
	if _, err := os.Stat(filepath.Join(s.workDir, txs[len(txs)-1])); err != nil {
		t.Fatal("the newest transaction was pruned")
	}
}
