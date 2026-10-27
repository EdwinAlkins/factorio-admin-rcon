// Package saves manages the server's live saves and the panel's archives.
//
// Two directories, two roles: `saves` is Factorio's own folder, where its
// autosave slots are recycled; `backups` holds the panel's archives, each a
// verified copy with a JSON sidecar describing it. An archive is
// self-describing: the panel's database is not needed to know what it is.
package saves

import (
	"encoding/json/v2"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/files"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/mods"
)

var (
	ErrNotFound = errors.New("backup not found")
	// ErrNoSave: the server has no save yet (never started).
	ErrNoSave = errors.New("no save to archive")
	// ErrChecksum: the archive no longer matches the hash recorded when it was
	// made — altered or corrupted on disk since. Never restored.
	ErrChecksum = errors.New("archive does not match its recorded checksum")
)

// Sources of an archive. The `pre-*` ones are safety copies the panel takes
// before changing the server; they are protected from pruning for a while.
const (
	SourceManual     = "manual"
	SourceScheduled  = "scheduled"
	SourcePreRestore = "pre-restore"
	SourcePreMods    = "pre-mods"
)

var sources = []string{SourceManual, SourceScheduled, SourcePreRestore, SourcePreMods}

// IDs are generated here, never taken from a caller as-is: `20261027-143000-manual`.
var idPattern = regexp.MustCompile(`^[0-9]{8}-[0-9]{6}-(manual|scheduled|pre-restore|pre-mods)(-[0-9]{1,3})?$`)

// ValidID reports whether id has the shape of an archive id.
func ValidID(id string) bool { return idPattern.MatchString(id) }

// ValidSource reports whether source is one the panel may ask for.
func ValidSource(source string) bool { return slices.Contains(sources, source) }

// Safety copies are kept at least this long, whatever the pruning policy.
const protectPreCopies = 7 * 24 * time.Hour

// How many sets of replaced saves a restore keeps (see Restore).
const keepReplaced = 3

// Meta is an archive's sidecar.
type Meta struct {
	ID        string    `json:"id"`
	Source    string    `json:"source"`
	Label     string    `json:"label,omitzero"`
	CreatedAt time.Time `json:"createdAt"`
	CreatedBy string    `json:"createdBy,omitzero"`
	Size      int64     `json:"size"`
	SHA256    string    `json:"sha256"`
	// The save file the archive was taken from (`_autosave1.zip`): a restore
	// writes it back under this name.
	SaveName string `json:"saveName"`
	// Recorded so a restore can warn before loading a map into a different
	// game version or mod set.
	FactorioVersion string     `json:"factorioVersion,omitzero"`
	Mods            []mods.Mod `json:"mods"`
}

// SaveFile is one file of Factorio's saves folder.
type SaveFile struct {
	Name     string    `json:"name"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
	// The newest save: the one factoriotools loads (`--start-server-load-latest`).
	Latest bool `json:"latest"`
}

type Store struct {
	saves   *os.Root
	backups *os.Root
	// Optional: without it, archives record no mod set.
	mods *os.Root
	now  func() time.Time
	// Between two attempts at archiving a save that was being written.
	retryDelay time.Duration
}

func NewStore(saves, backups, mods *os.Root) *Store {
	return &Store{saves: saves, backups: backups, mods: mods, now: time.Now, retryDelay: 2 * time.Second}
}

// ListSaves returns the saves folder, newest first.
func (s *Store) ListSaves() ([]SaveFile, error) {
	entries, err := fs.ReadDir(s.saves.FS(), ".")
	if err != nil {
		return nil, err
	}
	list := []SaveFile{}
	for _, entry := range entries {
		if !entry.Type().IsRegular() || !files.ValidZipName(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		list = append(list, SaveFile{Name: entry.Name(), Size: info.Size(), Modified: info.ModTime()})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Modified.After(list[j].Modified) })
	if len(list) > 0 {
		list[0].Latest = true
	}
	return list, nil
}

// CurrentMods is the server's mod set as it is now.
func (s *Store) CurrentMods() ([]mods.Mod, error) {
	if s.mods == nil {
		return []mods.Mod{}, nil
	}
	return mods.Snapshot(s.mods)
}

// ListBackups returns every archive with a readable sidecar, newest first.
// An archive whose sidecar is missing or unreadable is not listed: without
// its checksum it could not be restored anyway.
func (s *Store) ListBackups() ([]Meta, error) {
	entries, err := fs.ReadDir(s.backups.FS(), ".")
	if err != nil {
		return nil, err
	}
	list := []Meta{}
	for _, entry := range entries {
		id, ok := strings.CutSuffix(entry.Name(), ".json")
		if !ok || !ValidID(id) || !entry.Type().IsRegular() {
			continue
		}
		if meta, err := s.Get(id); err == nil {
			list = append(list, meta)
		}
	}
	sort.Slice(list, func(i, j int) bool { return list[i].CreatedAt.After(list[j].CreatedAt) })
	return list, nil
}

// Get reads one sidecar.
func (s *Store) Get(id string) (Meta, error) {
	if !ValidID(id) {
		return Meta{}, ErrNotFound
	}
	raw, err := s.backups.ReadFile(id + ".json")
	if err != nil {
		if files.IsNotExist(err) {
			return Meta{}, ErrNotFound
		}
		return Meta{}, err
	}
	var meta Meta
	if err := json.Unmarshal(raw, &meta); err != nil || meta.ID != id {
		return Meta{}, fmt.Errorf("sidecar %s: unreadable", id)
	}
	if _, err := s.backups.Stat(id + ".zip"); err != nil {
		return Meta{}, ErrNotFound
	}
	return meta, nil
}

// Open returns an archive for download.
func (s *Store) Open(id string) (*os.File, Meta, error) {
	meta, err := s.Get(id)
	if err != nil {
		return nil, Meta{}, err
	}
	f, err := s.backups.Open(id + ".zip")
	return f, meta, err
}

// CreateRequest describes an archive to take.
type CreateRequest struct {
	Source          string
	Label           string
	CreatedBy       string
	FactorioVersion string
}

// Create archives the newest save. An autosave may be mid-write when it is
// copied: the copy is verified before being published, and retried a few
// times if it does not check out.
func (s *Store) Create(request CreateRequest) (Meta, error) {
	saves, err := s.ListSaves()
	if err != nil {
		return Meta{}, err
	}
	if len(saves) == 0 {
		return Meta{}, ErrNoSave
	}
	source := saves[0].Name

	modSet, err := s.CurrentMods()
	if err != nil {
		return Meta{}, fmt.Errorf("reading the mod set: %w", err)
	}

	id, err := s.newID(request.Source)
	if err != nil {
		return Meta{}, err
	}

	var copied files.Copied
	for attempt := 1; ; attempt++ {
		copied, err = files.CopyAtomic(s.saves, source, s.backups, id+".zip", 0o640, VerifySave)
		if err == nil || !errors.Is(err, ErrInvalidArchive) || attempt == 3 {
			break
		}
		time.Sleep(s.retryDelay)
	}
	if err != nil {
		return Meta{}, err
	}

	meta := Meta{
		ID:              id,
		Source:          request.Source,
		Label:           request.Label,
		CreatedAt:       s.now().UTC(),
		CreatedBy:       request.CreatedBy,
		Size:            copied.Size,
		SHA256:          copied.SHA256,
		SaveName:        source,
		FactorioVersion: request.FactorioVersion,
		Mods:            modSet,
	}
	if err := s.writeMeta(meta); err != nil {
		_ = s.backups.Remove(id + ".zip")
		return Meta{}, err
	}
	return meta, nil
}

// RestoreResult reports what a restore changed.
type RestoreResult struct {
	SaveName string `json:"saveName"`
	// Where the saves that were in the folder went (inside the backups
	// directory), so nothing is ever destroyed by a restore.
	ReplacedDir string   `json:"replacedDir,omitzero"`
	Replaced    []string `json:"replaced"`
}

// Restore puts an archive back in the saves folder, as its only save.
//
// The archive is checked against its recorded checksum and fully verified
// first; a corrupted archive is never restored. The saves currently in the
// folder are moved to `replaced-<time>/` in the backups directory — out of the
// saves folder, so neither Factorio nor the factoriotools entrypoint can pick
// one of them instead. The restored file is written last, with the current
// time, so `--start-server-load-latest` loads it; `targetName` overrides its
// name for servers started with a fixed SAVE_NAME.
//
// The server must be stopped: the panel's restore operation does that first.
func (s *Store) Restore(id, targetName string) (RestoreResult, error) {
	meta, err := s.Get(id)
	if err != nil {
		return RestoreResult{}, err
	}
	name := meta.SaveName
	if targetName != "" {
		name = targetName
	}
	if !files.ValidZipName(name) {
		return RestoreResult{}, fmt.Errorf("invalid save name %q", name)
	}

	if err := s.check(meta); err != nil {
		return RestoreResult{}, err
	}

	result := RestoreResult{SaveName: name, Replaced: []string{}}
	current, err := s.ListSaves()
	if err != nil {
		return RestoreResult{}, err
	}
	if len(current) > 0 {
		result.ReplacedDir = "replaced-" + s.now().UTC().Format("20060102-150405")
		if err := s.backups.MkdirAll(result.ReplacedDir, 0o750); err != nil {
			return RestoreResult{}, err
		}
		dir, err := s.backups.OpenRoot(result.ReplacedDir)
		if err != nil {
			return RestoreResult{}, err
		}
		defer dir.Close()

		for _, save := range current {
			if _, err := files.CopyAtomic(s.saves, save.Name, dir, save.Name, 0o640, nil); err != nil {
				return result, fmt.Errorf("setting %s aside: %w", save.Name, err)
			}
			if err := s.saves.Remove(save.Name); err != nil {
				return result, err
			}
			result.Replaced = append(result.Replaced, save.Name)
		}
	}

	if _, err := files.CopyAtomic(s.backups, id+".zip", s.saves, name, 0o644, VerifySave); err != nil {
		return result, err
	}
	s.pruneReplaced()
	return result, nil
}

// Verify checks an archive against its recorded checksum, then reads it in
// full. The panel calls it before stopping the server for a restore, so a
// damaged archive is refused without disconnecting anyone; Restore checks
// again, since the file could change in between.
func (s *Store) Verify(id string) error {
	meta, err := s.Get(id)
	if err != nil {
		return err
	}
	return s.check(meta)
}

func (s *Store) check(meta Meta) error {
	sum, err := files.HashFile(s.backups, meta.ID+".zip")
	if err != nil {
		return err
	}
	if sum != meta.SHA256 {
		return ErrChecksum
	}
	return s.verifyArchive(meta.ID)
}

// Delete removes an archive and its sidecar.
func (s *Store) Delete(id string) error {
	if _, err := s.Get(id); err != nil {
		return err
	}
	// Sidecar first: an archive without one is no longer listed.
	if err := s.backups.Remove(id + ".json"); err != nil {
		return err
	}
	return s.backups.Remove(id + ".zip")
}

// PrunePolicy selects archives to delete among `Sources`: beyond the
// `KeepLast` newest, or older than `MaxAge`. Zero disables either rule.
type PrunePolicy struct {
	Sources  []string
	KeepLast int
	MaxAge   time.Duration
}

// Prune applies a policy and returns the ids it removed. Safety copies
// younger than a week are never removed, whatever the policy says.
func (s *Store) Prune(policy PrunePolicy) ([]string, error) {
	all, err := s.ListBackups()
	if err != nil {
		return nil, err
	}
	now := s.now()
	removed := []string{}
	kept := 0
	for _, meta := range all {
		if !slices.Contains(policy.Sources, meta.Source) {
			continue
		}
		age := now.Sub(meta.CreatedAt)
		if strings.HasPrefix(meta.Source, "pre-") && age < protectPreCopies {
			kept++
			continue
		}
		tooMany := policy.KeepLast > 0 && kept >= policy.KeepLast
		tooOld := policy.MaxAge > 0 && age > policy.MaxAge
		if !tooMany && !tooOld {
			kept++
			continue
		}
		if err := s.Delete(meta.ID); err != nil {
			return removed, err
		}
		removed = append(removed, meta.ID)
	}
	return removed, nil
}

func (s *Store) verifyArchive(id string) error {
	f, err := s.backups.Open(id + ".zip")
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	return VerifySave(f, info.Size())
}

func (s *Store) writeMeta(meta Meta) error {
	raw, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	return files.WriteAtomic(s.backups, meta.ID+".json", raw, 0o640)
}

// newID builds a fresh id for source, suffixed when two archives land in the
// same second.
func (s *Store) newID(source string) (string, error) {
	if !ValidSource(source) {
		return "", fmt.Errorf("unknown source %q", source)
	}
	base := s.now().UTC().Format("20060102-150405") + "-" + source
	for n := 1; n < 1000; n++ {
		id := base
		if n > 1 {
			id += "-" + strconv.Itoa(n)
		}
		if _, err := s.backups.Stat(id + ".zip"); files.IsNotExist(err) {
			return id, nil
		}
	}
	return "", errors.New("too many archives in the same second")
}

// pruneReplaced keeps the newest few sets of saves set aside by restores.
func (s *Store) pruneReplaced() {
	entries, err := fs.ReadDir(s.backups.FS(), ".")
	if err != nil {
		return
	}
	var dirs []string
	for _, entry := range entries {
		if entry.IsDir() && strings.HasPrefix(entry.Name(), "replaced-") {
			dirs = append(dirs, entry.Name())
		}
	}
	// Names embed the time: lexical order is chronological.
	sort.Sort(sort.Reverse(sort.StringSlice(dirs)))
	for _, dir := range dirs[min(len(dirs), keepReplaced):] {
		_ = s.backups.RemoveAll(dir)
	}
}
