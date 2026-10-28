// Package worlds is the library of generated worlds: one folder where each
// world is `<id>.zip` (the save Factorio created), `<id>.png` (its preview)
// and `<id>.json` (a sidecar: name, seed, settings, game version, mod set).
//
// The world agent writes it; the data agent reads it, to turn a world into an
// archive the server can be restored from. Nothing here runs Factorio — that
// is internal/factorio, linked by the world agent only.
//
// Worlds are kept until deleted: no retention policy applies to them.
package worlds

import (
	"encoding/json/v2"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/files"
)

var ErrNotFound = errors.New("world not found")

// IDs are generated here: `20261028-091500`, suffixed when two land in the
// same second.
var idPattern = regexp.MustCompile(`^[0-9]{8}-[0-9]{6}(-[0-9]{1,3})?$`)

// ValidID reports whether id has the shape of a world id.
func ValidID(id string) bool { return idPattern.MatchString(id) }

// Mod is one mod the world was generated with, as Factorio loaded it.
// Version is empty for the mods that ship with the game (`base`,
// `space-age`…), the convention of the data agent's mod set.
type Mod struct {
	Name    string `json:"name"`
	Version string `json:"version,omitzero"`
}

// Meta is a world's sidecar.
type Meta struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Seed      uint32    `json:"seed"`
	CreatedAt time.Time `json:"createdAt"`
	CreatedBy string    `json:"createdBy,omitzero"`
	Size      int64     `json:"size"`
	SHA256    string    `json:"sha256"`
	// The same seed reproduces the same map only with the same settings,
	// game version and mods: all three are recorded.
	Settings        Settings `json:"settings"`
	FactorioVersion string   `json:"factorioVersion"`
	Mods            []Mod    `json:"mods"`
	Preview         bool     `json:"preview"`
}

type Store struct {
	root *os.Root
	now  func() time.Time
}

func NewStore(root *os.Root) *Store {
	return &Store{root: root, now: time.Now}
}

// List returns every world with a readable sidecar, newest first.
func (s *Store) List() ([]Meta, error) {
	entries, err := fs.ReadDir(s.root.FS(), ".")
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

// Get reads one sidecar; the world exists only if its save does too.
func (s *Store) Get(id string) (Meta, error) {
	if !ValidID(id) {
		return Meta{}, ErrNotFound
	}
	raw, err := s.root.ReadFile(id + ".json")
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
	if _, err := s.root.Stat(id + ".zip"); err != nil {
		return Meta{}, ErrNotFound
	}
	return meta, nil
}

// Open returns a world's save, for download or for archiving.
func (s *Store) Open(id string) (*os.File, Meta, error) {
	meta, err := s.Get(id)
	if err != nil {
		return nil, Meta{}, err
	}
	f, err := s.root.Open(id + ".zip")
	return f, meta, err
}

// Root is the library folder, for copies out of it (the data agent's archive).
func (s *Store) Root() *os.Root { return s.root }

// OpenPreview returns a world's preview image.
func (s *Store) OpenPreview(id string) (*os.File, Meta, error) {
	meta, err := s.Get(id)
	if err != nil {
		return nil, Meta{}, err
	}
	if !meta.Preview {
		return nil, Meta{}, ErrNotFound
	}
	f, err := s.root.Open(id + ".png")
	return f, meta, err
}

// NewID reserves nothing: it returns an id free at the time of the call. The
// world agent creates one world at a time, so nothing races for it.
func (s *Store) NewID() (string, error) {
	base := s.now().UTC().Format("20060102-150405")
	for n := 1; n < 1000; n++ {
		id := base
		if n > 1 {
			id += "-" + strconv.Itoa(n)
		}
		if _, err := s.root.Stat(id + ".json"); files.IsNotExist(err) {
			return id, nil
		}
	}
	return "", errors.New("too many worlds in the same second")
}

// Publish copies a save Factorio just wrote (`src/srcName`) into the library,
// with its preview, then writes the sidecar last: until then the world is not
// listed, so a crash halfway leaves nothing that looks complete.
func (s *Store) Publish(src *os.Root, srcName string, preview []byte, meta Meta) (Meta, error) {
	if !ValidID(meta.ID) {
		return Meta{}, fmt.Errorf("invalid world id %q", meta.ID)
	}
	copied, err := files.CopyAtomic(src, srcName, s.root, meta.ID+".zip", 0o640, nil)
	if err != nil {
		return Meta{}, err
	}
	meta.Size, meta.SHA256 = copied.Size, copied.SHA256
	meta.CreatedAt = s.now().UTC()
	if meta.Mods == nil {
		meta.Mods = []Mod{}
	}

	meta.Preview = false
	if len(preview) > 0 {
		if err := files.WriteAtomic(s.root, meta.ID+".png", preview, 0o640); err == nil {
			meta.Preview = true
		}
	}

	raw, err := json.Marshal(meta)
	if err == nil {
		err = files.WriteAtomic(s.root, meta.ID+".json", raw, 0o640)
	}
	if err != nil {
		_ = s.root.Remove(meta.ID + ".zip")
		_ = s.root.Remove(meta.ID + ".png")
		return Meta{}, err
	}
	return meta, nil
}

// Delete removes a world: sidecar first, so a half-deleted world is no
// longer listed.
func (s *Store) Delete(id string) error {
	if _, err := s.Get(id); err != nil {
		return err
	}
	if err := s.root.Remove(id + ".json"); err != nil {
		return err
	}
	_ = s.root.Remove(id + ".png")
	return s.root.Remove(id + ".zip")
}

var slugUnsafe = regexp.MustCompile(`[^a-z0-9]+`)

// SaveName is the file name a world's save takes in the server's saves
// folder: its name, made safe, or its id when nothing of the name survives.
func SaveName(meta Meta) string {
	slug := strings.Trim(slugUnsafe.ReplaceAllString(strings.ToLower(meta.Name), "-"), "-")
	if len(slug) > 60 {
		slug = strings.TrimRight(slug[:60], "-")
	}
	if slug == "" {
		slug = "world-" + meta.ID
	}
	return slug + ".zip"
}
