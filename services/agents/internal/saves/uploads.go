package saves

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"regexp"
	"time"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/files"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/mods"
)

// An upload is a save sent from the operator's computer, in chunks, then
// published as an archive of source `upload` — never written to the saves
// folder directly: putting it in play is a restore, with everything a
// restore does first.
//
// Chunks land in `.uploads/` inside the backups directory: out of the
// listings, and on the same filesystem as the archives, so publishing is a
// rename. One upload at a time: a few hundred megabytes of disk, bounded.

var (
	ErrUploadNotFound = errors.New("upload not found")
	// ErrUploadBusy: another upload is under way, or a chunk is being written.
	ErrUploadBusy       = errors.New("another upload is in progress")
	ErrUploadTooLarge   = errors.New("upload larger than allowed")
	ErrUploadIncomplete = errors.New("upload incomplete")
	ErrUploadsDisabled  = errors.New("uploads are disabled")
)

// OffsetError: a chunk does not start where the upload stands, typically a
// retry of a chunk that did arrive. The caller resumes from Offset.
type OffsetError struct{ Offset int64 }

func (e *OffsetError) Error() string { return fmt.Sprintf("upload stands at offset %d", e.Offset) }

// ChunkBytes bounds one chunk: small enough for a reverse proxy's body limit
// and the agent's read deadline, large enough to keep requests few.
const ChunkBytes = 8 << 20

// An upload left alone this long no longer blocks a new one.
const uploadIdle = 15 * time.Minute

const uploadsDir = ".uploads"

var uploadID = regexp.MustCompile(`^[0-9a-f]{32}$`)

type upload struct {
	id       string
	name     string
	size     int64
	received int64
	lastSeen time.Time
	// A chunk or the completion is running: nothing else may touch the file.
	busy bool
}

func (u *upload) file() string { return uploadsDir + "/" + u.id + ".partial" }

// UploadState is where an upload stands.
type UploadState struct {
	ID     string `json:"id"`
	Offset int64  `json:"offset"`
	Size   int64  `json:"size"`
}

// EnableUploads accepts uploads of up to max bytes. Leftovers of a previous
// run are removed: their state lived in memory and cannot be resumed.
func (s *Store) EnableUploads(max int64) error {
	if err := s.backups.RemoveAll(uploadsDir); err != nil {
		return err
	}
	if err := s.backups.MkdirAll(uploadsDir, 0o750); err != nil {
		return err
	}
	s.maxUpload = max
	return nil
}

// MaxUpload is the largest upload accepted; zero when uploads are off.
func (s *Store) MaxUpload() int64 { return s.maxUpload }

// BeginUpload opens an upload of `size` bytes. `name` is the file's name on
// the operator's computer, kept as the archive's save name when it is a
// plain one.
func (s *Store) BeginUpload(size int64, name string) (UploadState, error) {
	if s.maxUpload == 0 {
		return UploadState{}, ErrUploadsDisabled
	}
	if size > s.maxUpload {
		return UploadState{}, ErrUploadTooLarge
	}
	if !files.ValidZipName(name) {
		name = "upload.zip"
	}

	s.uploadMu.Lock()
	defer s.uploadMu.Unlock()
	if u := s.upload; u != nil {
		if u.busy || s.now().Sub(u.lastSeen) < uploadIdle {
			return UploadState{}, ErrUploadBusy
		}
		_ = s.backups.Remove(u.file())
		s.upload = nil
	}

	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return UploadState{}, err
	}
	u := &upload{id: hex.EncodeToString(raw), name: name, size: size, lastSeen: s.now()}
	f, err := s.backups.OpenFile(u.file(), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o640)
	if err != nil {
		return UploadState{}, err
	}
	if err := f.Close(); err != nil {
		return UploadState{}, err
	}
	s.upload = u
	return UploadState{ID: u.id, Size: size}, nil
}

// UploadOffset reports how much of an upload has arrived.
func (s *Store) UploadOffset(id string) (UploadState, error) {
	s.uploadMu.Lock()
	defer s.uploadMu.Unlock()
	u, err := s.current(id)
	if err != nil {
		return UploadState{}, err
	}
	return UploadState{ID: u.id, Offset: u.received, Size: u.size}, nil
}

// AppendUpload writes one chunk, which must start where the upload stands.
// A chunk cut short — the browser went away — is undone, so the upload
// stays exactly at its last complete chunk.
func (s *Store) AppendUpload(id string, offset int64, chunk io.Reader) (UploadState, error) {
	u, err := s.claim(id)
	if err != nil {
		return UploadState{}, err
	}
	written, err := s.appendChunk(u, offset, chunk)

	s.uploadMu.Lock()
	defer s.uploadMu.Unlock()
	u.busy = false
	u.lastSeen = s.now()
	if err != nil {
		return UploadState{}, err
	}
	u.received += written
	return UploadState{ID: u.id, Offset: u.received, Size: u.size}, nil
}

func (s *Store) appendChunk(u *upload, offset int64, chunk io.Reader) (int64, error) {
	if offset != u.received {
		return 0, &OffsetError{Offset: u.received}
	}
	f, err := s.backups.OpenFile(u.file(), os.O_WRONLY, 0)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	// Whatever a failed chunk left past the offset goes first.
	if err := f.Truncate(offset); err != nil {
		return 0, err
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return 0, err
	}
	remaining := u.size - offset
	written, err := io.Copy(f, io.LimitReader(chunk, remaining+1))
	if err == nil && written > remaining {
		err = ErrUploadTooLarge
	}
	if err != nil {
		_ = f.Truncate(offset)
		return 0, err
	}
	return written, nil
}

// AbortUpload drops an upload and its data.
func (s *Store) AbortUpload(id string) error {
	s.uploadMu.Lock()
	defer s.uploadMu.Unlock()
	u, err := s.current(id)
	if err != nil {
		return err
	}
	if u.busy {
		return ErrUploadBusy
	}
	s.upload = nil
	return s.backups.Remove(u.file())
}

// CompleteUpload verifies a fully received upload as a save and publishes it
// as an archive. The game's version and mod set are unknown: nothing in a
// save says them in a stable form, so the archive records neither. A file
// that is not a valid save is dropped.
func (s *Store) CompleteUpload(id, label, createdBy string) (Meta, error) {
	u, err := s.claim(id)
	if err != nil {
		return Meta{}, err
	}
	meta, err := s.publish(u, label, createdBy)

	s.uploadMu.Lock()
	defer s.uploadMu.Unlock()
	u.busy = false
	u.lastSeen = s.now()
	if err == nil || errors.Is(err, ErrInvalidArchive) {
		s.upload = nil
		_ = s.backups.Remove(u.file())
	}
	return meta, err
}

func (s *Store) publish(u *upload, label, createdBy string) (Meta, error) {
	if u.received != u.size {
		return Meta{}, ErrUploadIncomplete
	}
	f, err := s.backups.OpenFile(u.file(), os.O_RDWR, 0)
	if err != nil {
		return Meta{}, err
	}
	err = f.Sync()
	if err == nil {
		err = VerifySave(f, u.size)
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return Meta{}, err
	}
	sum, err := files.HashFile(s.backups, u.file())
	if err != nil {
		return Meta{}, err
	}

	id, err := s.newID(SourceUpload)
	if err != nil {
		return Meta{}, err
	}
	if err := s.backups.Rename(u.file(), id+".zip"); err != nil {
		return Meta{}, err
	}
	meta := Meta{
		ID:        id,
		Source:    SourceUpload,
		Label:     label,
		CreatedAt: s.now().UTC(),
		CreatedBy: createdBy,
		Size:      u.size,
		SHA256:    sum,
		SaveName:  u.name,
		Mods:      []mods.Mod{},
	}
	if err := s.writeMeta(meta); err != nil {
		_ = s.backups.Remove(id + ".zip")
		return Meta{}, err
	}
	return meta, nil
}

// claim marks the upload busy for one chunk or the completion.
func (s *Store) claim(id string) (*upload, error) {
	s.uploadMu.Lock()
	defer s.uploadMu.Unlock()
	u, err := s.current(id)
	if err != nil {
		return nil, err
	}
	if u.busy {
		return nil, ErrUploadBusy
	}
	u.busy = true
	return u, nil
}

// current returns the upload `id`; the caller holds uploadMu.
func (s *Store) current(id string) (*upload, error) {
	if !uploadID.MatchString(id) || s.upload == nil || s.upload.id != id {
		return nil, ErrUploadNotFound
	}
	if _, err := s.backups.Stat(s.upload.file()); errors.Is(err, fs.ErrNotExist) {
		s.upload = nil
		return nil, ErrUploadNotFound
	}
	return s.upload, nil
}
