package mods

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"regexp"
	"slices"
	"sort"
	"time"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/files"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/portal"
)

var (
	// ErrPlanChanged: the plan recomputed at stage time differs from the one
	// the operator confirmed.
	ErrPlanChanged = errors.New("the plan changed since it was confirmed")
	// ErrNothingToDo: the basket changes nothing.
	ErrNothingToDo = errors.New("the plan changes nothing")
	// ErrTxNotFound: no staged transaction by that id.
	ErrTxNotFound = errors.New("transaction not found")
	// ErrAlreadyCommitted: a transaction is applied once.
	ErrAlreadyCommitted = errors.New("transaction already applied")
	// ErrNoModsDir: the mods folder does not exist yet (the server never ran).
	ErrNoModsDir = errors.New("the mods folder does not exist yet")
)

// Portal is the part of the portal client the manager uses.
type Portal interface {
	Catalog
	Releases(ctx context.Context, names []string) (map[string][]portal.Release, error)
	Search(ctx context.Context, query, gameVersion string, page int) (portal.SearchResult, error)
	Download(ctx context.Context, release portal.Release, w io.Writer, maxBytes int64) (int64, error)
	HasCredentials() bool
}

// Manager changes the mod set in two phases, so the server is stopped only
// for the second:
//
//   - Stage downloads and verifies everything into a transaction folder,
//     with the server still running;
//   - Commit, once the panel has stopped it, sets the replaced archives and
//     mod-list.json aside in that folder, then swaps the new files in;
//   - Rollback puts back what Commit set aside.
//
// Transactions live under the work directory (`/backups/.mods`), outside the
// mods folder: Factorio never sees a half-done change or a staging folder.
type Manager struct {
	// Opened per operation: the folder appears when the server first starts,
	// possibly after the agent did.
	modsDir     string
	work        *os.Root
	portal      Portal
	maxDownload int64
	now         func() time.Time
}

func NewManager(modsDir string, work *os.Root, client Portal, maxDownload int64) *Manager {
	return &Manager{modsDir: modsDir, work: work, portal: client, maxDownload: maxDownload, now: time.Now}
}

// How many transactions are kept for rollback.
const keepTransactions = 3

var txPattern = regexp.MustCompile(`^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$`)

func (m *Manager) openMods() (*os.Root, error) {
	root, err := os.OpenRoot(m.modsDir)
	if files.IsNotExist(err) {
		return nil, ErrNoModsDir
	}
	return root, err
}

// Status is a mod as the panel lists it.
type Status struct {
	Installed
	// Newest release on the portal for this game version, when newer than
	// the installed one.
	Update string `json:"update,omitzero"`
}

// State is the mods tab's content.
type State struct {
	Mods []Status `json:"mods"`
	// Whether searching and installing are possible.
	Credentials bool `json:"credentials"`
	// Set when the update check failed; the list itself is still valid.
	PortalError string `json:"portalError,omitzero"`
}

// List returns the installed mods and, when the game version is known, the
// updates available on the portal (public API, no credentials needed).
func (m *Manager) List(ctx context.Context, game string) (State, error) {
	state := State{Mods: []Status{}, Credentials: m.portal.HasCredentials()}
	root, err := m.openMods()
	if errors.Is(err, ErrNoModsDir) {
		return state, nil
	}
	if err != nil {
		return State{}, err
	}
	defer root.Close()

	inventory, err := Inventory(root, game)
	if err != nil {
		return State{}, err
	}
	var names []string
	for _, mod := range inventory {
		state.Mods = append(state.Mods, Status{Installed: mod})
		if !mod.Builtin && !mod.Unpacked {
			names = append(names, mod.Name)
		}
	}

	gameVersion, err := ParseVersion(game)
	if err != nil || len(names) == 0 {
		return state, nil
	}
	releases, err := m.portal.Releases(ctx, names)
	if err != nil {
		state.PortalError = "portal_unreachable"
		return state, nil
	}
	for i := range state.Mods {
		mod := &state.Mods[i]
		current, err := ParseVersion(mod.Version)
		if err != nil {
			continue
		}
		for _, release := range releases[mod.Name] {
			v, err := ParseVersion(release.Version)
			if err != nil || release.InfoJSON.FactorioVersion != gameVersion.MajorMinor() || v.Compare(current) <= 0 {
				continue
			}
			if best, err := ParseVersion(mod.Update); err != nil || v.Compare(best) > 0 {
				mod.Update = release.Version
			}
		}
	}
	return state, nil
}

// SearchHit marks whether a result is already installed.
type SearchHit struct {
	portal.Hit
	Installed bool `json:"installed"`
}

// Search runs a portal search for the game's major.minor version.
func (m *Manager) Search(ctx context.Context, query string, game Version, page int) ([]SearchHit, portal.SearchResult, error) {
	result, err := m.portal.Search(ctx, query, game.MajorMinor(), page)
	if err != nil {
		return nil, portal.SearchResult{}, err
	}
	installed := map[string]bool{}
	if root, err := m.openMods(); err == nil {
		if inventory, err := Inventory(root, ""); err == nil {
			for _, mod := range inventory {
				installed[mod.Name] = true
			}
		}
		_ = root.Close()
	}
	hits := make([]SearchHit, len(result.Hits))
	for i, hit := range result.Hits {
		hits[i] = SearchHit{Hit: hit, Installed: installed[hit.Name]}
	}
	return hits, result, nil
}

// ReleaseInfo is a release as the mod's page in the panel shows it.
type ReleaseInfo struct {
	Version         string   `json:"version"`
	FactorioVersion string   `json:"factorioVersion"`
	ReleasedAt      string   `json:"releasedAt"`
	Dependencies    []string `json:"dependencies"`
	// Runs on this game version.
	Compatible bool `json:"compatible"`
}

// Details is a mod's page.
type Details struct {
	Name           string        `json:"name"`
	Title          string        `json:"title"`
	Summary        string        `json:"summary"`
	Owner          string        `json:"owner"`
	Category       string        `json:"category"`
	DownloadsCount int           `json:"downloadsCount"`
	Releases       []ReleaseInfo `json:"releases"`
}

// maxReleasesShown keeps a mod's page short: older releases rarely matter.
const maxReleasesShown = 20

func (m *Manager) Details(ctx context.Context, name string, game Version) (Details, error) {
	mod, err := m.portal.Full(ctx, name)
	if err != nil {
		return Details{}, err
	}
	details := Details{
		Name: mod.Name, Title: mod.Title, Summary: mod.Summary, Owner: mod.Owner,
		Category: mod.Category, DownloadsCount: mod.DownloadsCount, Releases: []ReleaseInfo{},
	}
	releases := slices.Clone(mod.Releases)
	sort.SliceStable(releases, func(i, j int) bool { return releases[i].ReleasedAt > releases[j].ReleasedAt })
	for _, release := range releases[:min(len(releases), maxReleasesShown)] {
		info := ReleaseInfo{
			Version:         release.Version,
			FactorioVersion: release.InfoJSON.FactorioVersion,
			ReleasedAt:      release.ReleasedAt,
			Dependencies:    []string{"base"},
			Compatible:      release.InfoJSON.FactorioVersion == game.MajorMinor(),
		}
		if release.InfoJSON.Dependencies != nil {
			info.Dependencies = *release.InfoJSON.Dependencies
		}
		details.Releases = append(details.Releases, info)
	}
	return details, nil
}

// Plan works out what a basket would do. Nothing is written.
func (m *Manager) Plan(ctx context.Context, changes []Change, game Version) (Plan, error) {
	root, err := m.openMods()
	if err != nil {
		return Plan{}, err
	}
	defer root.Close()
	inventory, err := Inventory(root, game.String())
	if err != nil {
		return Plan{}, err
	}
	return BuildPlan(ctx, m.portal, inventory, changes, game)
}

// Stage recomputes the plan, checks it is the one the operator confirmed,
// then downloads and verifies every archive it needs into a new transaction
// folder. The mods folder is not touched: the server may keep running.
func (m *Manager) Stage(ctx context.Context, changes []Change, game Version, confirmed string) (string, Plan, error) {
	plan, err := m.Plan(ctx, changes, game)
	if err != nil {
		return "", Plan{}, err
	}
	if len(plan.Conflicts) > 0 {
		return "", plan, &ConflictError{Conflicts: plan.Conflicts}
	}
	if plan.Hash != confirmed {
		return "", plan, ErrPlanChanged
	}
	if len(plan.Steps) == 0 {
		return "", plan, ErrNothingToDo
	}

	downloads := 0
	for _, step := range plan.Steps {
		if step.Download != nil {
			downloads++
		}
	}
	if downloads > 0 && !m.portal.HasCredentials() {
		return "", plan, portal.ErrNoCredentials
	}

	m.pruneTransactions()
	tx, err := m.newTx()
	if err != nil {
		return "", plan, err
	}
	if err := m.work.MkdirAll(tx+"/downloads", 0o750); err != nil {
		return "", plan, err
	}
	dir, err := m.work.OpenRoot(tx)
	if err != nil {
		return "", plan, err
	}
	defer dir.Close()

	staged := false
	defer func() {
		if !staged {
			_ = m.work.RemoveAll(tx)
		}
	}()

	for _, step := range plan.Steps {
		if step.Download == nil {
			continue
		}
		if err := m.download(ctx, dir, step); err != nil {
			return "", plan, fmt.Errorf("%s %s: %w", step.Name, step.To, err)
		}
	}
	raw, err := json.Marshal(plan)
	if err != nil {
		return "", plan, err
	}
	if err := files.WriteAtomic(dir, "plan.json", raw, 0o640); err != nil {
		return "", plan, err
	}
	staged = true
	return tx, plan, nil
}

// download fetches one release into `downloads/`, published under its name
// only once its size, SHA-1 and structure have been checked.
func (m *Manager) download(ctx context.Context, dir *os.Root, step Step) error {
	name := "downloads/" + step.Download.FileName
	partial := name + ".partial"
	out, err := dir.OpenFile(partial, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o640)
	if err != nil {
		return err
	}
	defer func() {
		_ = out.Close()
		_ = dir.Remove(partial)
	}()

	release := portal.Release{
		Version: step.To, DownloadURL: step.Download.URL, FileName: step.Download.FileName, SHA1: step.Download.SHA1,
	}
	size, err := m.portal.Download(ctx, release, out, m.maxDownload)
	if err != nil {
		return err
	}
	if err := out.Sync(); err != nil {
		return err
	}
	if err := VerifyModArchive(out, size, step.Name, step.To); err != nil {
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return dir.Rename(partial, name)
}

// journal records, before each move, what Commit did, so Rollback can undo
// exactly that even after a crash halfway.
type journal struct {
	// mod-list.json did not exist before the commit.
	NoModList  bool     `json:"noModList"`
	Added      []string `json:"added"`
	SetAside   []string `json:"setAside"`
	Committed  bool     `json:"committed"`
	RolledBack bool     `json:"rolledBack"`
}

// Commit applies a staged transaction to the mods folder. The server must be
// stopped: the panel's operation does that first.
func (m *Manager) Commit(tx string) error {
	dir, plan, err := m.openTx(tx)
	if err != nil {
		return err
	}
	defer dir.Close()
	if _, err := dir.Stat("journal.json"); err == nil {
		return ErrAlreadyCommitted
	}

	root, err := m.openMods()
	if err != nil {
		return err
	}
	defer root.Close()
	if err := files.CheckWritable(root); err != nil {
		return fmt.Errorf("mods folder not writable: %w", err)
	}

	// The list as it is, first: the one thing every rollback restores.
	j := journal{Added: []string{}, SetAside: []string{}}
	if _, err := files.CopyAtomic(root, modListName, dir, modListName, 0o640, nil); err != nil {
		if !files.IsNotExist(err) {
			return fmt.Errorf("saving mod-list.json: %w", err)
		}
		j.NoModList = true
	}
	// Sub-roots, not "dir/name" paths: CopyAtomic writes its temporary file
	// next to its target, under a name derived from it.
	if err := dir.MkdirAll("set-aside", 0o750); err != nil {
		return err
	}
	setAside, err := dir.OpenRoot("set-aside")
	if err != nil {
		return err
	}
	defer setAside.Close()
	downloads, err := dir.OpenRoot("downloads")
	if err != nil {
		return err
	}
	defer downloads.Close()
	if err := writeJournal(dir, j); err != nil {
		return err
	}

	for _, step := range plan.Steps {
		for _, old := range step.Replaces {
			// Journal first: a crash after the copy leaves a file Rollback
			// can restore, never one it does not know about.
			j.SetAside = append(j.SetAside, old)
			if err := writeJournal(dir, j); err != nil {
				return err
			}
			if _, err := files.CopyAtomic(root, old, setAside, old, 0o640, nil); err != nil {
				return fmt.Errorf("setting %s aside: %w", old, err)
			}
			if err := root.Remove(old); err != nil {
				return err
			}
		}
		if step.Download != nil {
			name := step.Download.FileName
			j.Added = append(j.Added, name)
			if err := writeJournal(dir, j); err != nil {
				return err
			}
			verify := func(f *os.File, size int64) error { return VerifyModArchive(f, size, step.Name, step.To) }
			if _, err := files.CopyAtomic(downloads, name, root, name, 0o644, verify); err != nil {
				return fmt.Errorf("installing %s: %w", name, err)
			}
		}
	}

	if err := writeModList(root, plan.Steps); err != nil {
		return fmt.Errorf("writing mod-list.json: %w", err)
	}
	j.Committed = true
	return writeJournal(dir, j)
}

// writeModList applies the steps to mod-list.json, keeping every entry and
// field it does not change, in order.
func writeModList(root *os.Root, steps []Step) error {
	list, _, err := readModList(root)
	if err != nil {
		return err
	}
	for _, step := range steps {
		i := slices.IndexFunc(list.Mods, func(entry listEntry) bool { return entry.Name == step.Name })
		switch step.Action {
		case ActionRemove:
			if i >= 0 {
				list.Mods = slices.Delete(list.Mods, i, i+1)
			}
			continue
		case ActionEnable, ActionDisable:
			if i < 0 {
				list.Mods = append(list.Mods, listEntry{Name: step.Name})
				i = len(list.Mods) - 1
			}
			list.Mods[i].Enabled = step.Action == ActionEnable
		case ActionInstall, ActionUpdate:
			if i < 0 {
				list.Mods = append(list.Mods, listEntry{Name: step.Name})
				i = len(list.Mods) - 1
			}
			list.Mods[i].Enabled = step.Enabled
			// A pinned version would keep loading the old release.
			list.Mods[i].Version = ""
		}
	}
	raw, err := encodeModList(list)
	if err != nil {
		return err
	}
	return files.WriteAtomic(root, modListName, raw, 0o644)
}

// Rollback undoes what Commit did, from its journal: added archives are
// removed, set-aside ones and mod-list.json put back. Safe to call on a
// transaction that was never committed, or partly, or twice.
func (m *Manager) Rollback(tx string) error {
	dir, _, err := m.openTx(tx)
	if err != nil {
		return err
	}
	defer dir.Close()
	raw, err := dir.ReadFile("journal.json")
	if files.IsNotExist(err) {
		return nil // never committed: the mods folder is untouched
	}
	if err != nil {
		return err
	}
	var j journal
	if err := json.Unmarshal(raw, &j); err != nil {
		return fmt.Errorf("journal: %w", err)
	}

	root, err := m.openMods()
	if err != nil {
		return err
	}
	defer root.Close()

	var errs []error
	setAside, err := dir.OpenRoot("set-aside")
	if err != nil && (!files.IsNotExist(err) || len(j.SetAside) > 0) {
		return err
	}
	if setAside != nil {
		defer setAside.Close()
	}
	for _, name := range j.Added {
		if err := root.Remove(name); err != nil && !files.IsNotExist(err) {
			errs = append(errs, err)
		}
	}
	for _, name := range j.SetAside {
		if _, err := root.Stat(name); err == nil {
			continue // never removed, or already put back
		}
		if _, err := files.CopyAtomic(setAside, name, root, name, 0o644, nil); err != nil && !files.IsNotExist(err) {
			errs = append(errs, fmt.Errorf("restoring %s: %w", name, err))
		}
	}
	if j.NoModList {
		if err := root.Remove(modListName); err != nil && !files.IsNotExist(err) {
			errs = append(errs, err)
		}
	} else if _, err := files.CopyAtomic(dir, modListName, root, modListName, 0o644, nil); err != nil {
		errs = append(errs, fmt.Errorf("restoring mod-list.json: %w", err))
	}
	if err := errors.Join(errs...); err != nil {
		return err
	}
	j.RolledBack = true
	return writeJournal(dir, j)
}

func (m *Manager) openTx(tx string) (dir *os.Root, plan Plan, err error) {
	if !txPattern.MatchString(tx) {
		return nil, Plan{}, ErrTxNotFound
	}
	dir, err = m.work.OpenRoot(tx)
	if files.IsNotExist(err) {
		return nil, Plan{}, ErrTxNotFound
	}
	if err != nil {
		return nil, Plan{}, err
	}
	defer func() {
		if err != nil {
			_ = dir.Close()
			dir = nil
		}
	}()

	raw, err := dir.ReadFile("plan.json")
	if files.IsNotExist(err) {
		return nil, Plan{}, ErrTxNotFound
	}
	if err != nil {
		return nil, Plan{}, err
	}
	if err := json.Unmarshal(raw, &plan); err != nil {
		return nil, Plan{}, fmt.Errorf("plan.json: %w", err)
	}
	// What was written by this agent is still checked: names reach the mods
	// folder, so they must stay plain names inside it.
	for _, step := range plan.Steps {
		names := slices.Clone(step.Replaces)
		if step.Download != nil {
			names = append(names, step.Download.FileName)
		}
		for _, name := range names {
			if !files.ValidZipName(name) {
				return nil, Plan{}, fmt.Errorf("plan.json: invalid file name %q", name)
			}
		}
	}
	return dir, plan, nil
}

func writeJournal(dir *os.Root, j journal) error {
	raw, err := json.Marshal(j)
	if err != nil {
		return err
	}
	return files.WriteAtomic(dir, "journal.json", raw, 0o640)
}

func (m *Manager) newTx() (string, error) {
	suffix := make([]byte, 3)
	if _, err := rand.Read(suffix); err != nil {
		return "", err
	}
	return m.now().UTC().Format("20060102-150405") + "-" + hex.EncodeToString(suffix), nil
}

// pruneTransactions keeps the newest few, for rollback.
func (m *Manager) pruneTransactions() {
	entries, err := fs.ReadDir(m.work.FS(), ".")
	if err != nil {
		return
	}
	var txs []string
	for _, entry := range entries {
		if entry.IsDir() && txPattern.MatchString(entry.Name()) {
			txs = append(txs, entry.Name())
		}
	}
	// Names embed the time: lexical order is chronological.
	sort.Sort(sort.Reverse(sort.StringSlice(txs)))
	for _, tx := range txs[min(len(txs), keepTransactions-1):] {
		_ = m.work.RemoveAll(tx)
	}
}

// ErrorCode is the stable code of a mods error, for the API.
func ErrorCode(err error) string {
	switch {
	case errors.Is(err, ErrConflict):
		return "mods_conflict"
	case errors.Is(err, ErrPlanChanged):
		return "plan_changed"
	case errors.Is(err, ErrNothingToDo):
		return "mods_nothing_to_do"
	case errors.Is(err, ErrTxNotFound):
		return "tx_not_found"
	case errors.Is(err, ErrAlreadyCommitted):
		return "tx_already_committed"
	case errors.Is(err, ErrNoModsDir):
		return "mods_unavailable"
	case errors.Is(err, ErrInvalidMod):
		return "invalid_mod_archive"
	case errors.Is(err, portal.ErrNotFound):
		return "mod_not_found"
	case errors.Is(err, portal.ErrNoCredentials):
		return "portal_credentials_missing"
	case errors.Is(err, portal.ErrRejected):
		return "portal_rejected"
	case errors.Is(err, portal.ErrTooLarge):
		return "download_too_large"
	case errors.Is(err, portal.ErrChecksum):
		return "download_checksum"
	case errors.Is(err, portal.ErrUnreachable), errors.Is(err, context.DeadlineExceeded):
		return "portal_unreachable"
	}
	return ""
}
