package saves

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/fakesave"
)

func uploadFixture(t *testing.T, max int64) *fixture {
	t.Helper()
	f := newFixture(t)
	must(t, f.store.EnableUploads(max))
	return f
}

// failingReader yields its data, then fails: a browser gone mid-chunk.
type failingReader struct{ data []byte }

func (r *failingReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, errors.New("connection reset")
	}
	n := copy(p, r.data)
	r.data = r.data[n:]
	return n, nil
}

func TestUploadInChunksPublishesAnArchive(t *testing.T) {
	f := uploadFixture(t, 1<<20)
	save := fakesave.Valid(t, "my-map", "uploaded")
	half := len(save) / 2

	state, err := f.store.BeginUpload(int64(len(save)), "my-map.zip")
	must(t, err)
	_, err = f.store.AppendUpload(state.ID, 0, bytes.NewReader(save[:half]))
	must(t, err)

	// A chunk cut short leaves the upload at its last complete chunk.
	if _, err := f.store.AppendUpload(state.ID, int64(half), &failingReader{data: save[half : half+3]}); err == nil {
		t.Fatal("a failed chunk was accepted")
	}
	// A chunk resent after it did arrive is refused with where to resume.
	var offset *OffsetError
	if _, err := f.store.AppendUpload(state.ID, 0, bytes.NewReader(save[:half])); !errors.As(err, &offset) || offset.Offset != int64(half) {
		t.Fatalf("resent chunk: %v", err)
	}
	if got, err := f.store.UploadOffset(state.ID); err != nil || got.Offset != int64(half) {
		t.Fatalf("offset %+v, %v", got, err)
	}

	if _, err := f.store.CompleteUpload(state.ID, "", ""); !errors.Is(err, ErrUploadIncomplete) {
		t.Fatalf("early complete: %v", err)
	}
	_, err = f.store.AppendUpload(state.ID, int64(half), bytes.NewReader(save[half:]))
	must(t, err)

	meta, err := f.store.CompleteUpload(state.ID, "from my laptop", "admin")
	must(t, err)
	sum := sha256.Sum256(save)
	if meta.ID != "20261027-143000-upload" || meta.Source != SourceUpload || meta.SaveName != "my-map.zip" ||
		meta.SHA256 != hex.EncodeToString(sum[:]) || meta.Size != int64(len(save)) || len(meta.Mods) != 0 || meta.FactorioVersion != "" {
		t.Fatalf("meta %+v", meta)
	}
	must(t, f.store.Verify(meta.ID))
	if entries, _ := os.ReadDir(filepath.Join(f.backupsDir, uploadsDir)); len(entries) != 0 {
		t.Fatalf("left in the work directory: %v", entries)
	}
	if _, err := f.store.UploadOffset(state.ID); !errors.Is(err, ErrUploadNotFound) {
		t.Fatalf("after completion: %v", err)
	}

	// It restores like any archive.
	result, err := f.store.Restore(meta.ID, "")
	must(t, err)
	if result.SaveName != "my-map.zip" {
		t.Fatalf("restore %+v", result)
	}
}

func TestUploadRefusesAnInvalidSaveAndDropsIt(t *testing.T) {
	f := uploadFixture(t, 1<<20)
	junk := []byte("PK\x03\x04 not a save")
	state, err := f.store.BeginUpload(int64(len(junk)), "x.zip")
	must(t, err)
	_, err = f.store.AppendUpload(state.ID, 0, bytes.NewReader(junk))
	must(t, err)

	if _, err := f.store.CompleteUpload(state.ID, "", ""); !errors.Is(err, ErrInvalidArchive) {
		t.Fatalf("got %v", err)
	}
	if _, err := f.store.UploadOffset(state.ID); !errors.Is(err, ErrUploadNotFound) {
		t.Fatalf("invalid upload kept: %v", err)
	}
	if list, _ := f.store.ListBackups(); len(list) != 0 {
		t.Fatalf("published %+v", list)
	}
}

func TestUploadBounds(t *testing.T) {
	f := uploadFixture(t, 100)
	if _, err := f.store.BeginUpload(101, "x.zip"); !errors.Is(err, ErrUploadTooLarge) {
		t.Fatalf("declared size: %v", err)
	}

	state, err := f.store.BeginUpload(10, "../../etc/x.zip")
	must(t, err)
	// More than declared: refused, nothing kept.
	if _, err := f.store.AppendUpload(state.ID, 0, bytes.NewReader(make([]byte, 11))); !errors.Is(err, ErrUploadTooLarge) {
		t.Fatalf("overflow: %v", err)
	}
	if got, _ := f.store.UploadOffset(state.ID); got.Offset != 0 {
		t.Fatalf("offset after overflow %d", got.Offset)
	}
	if f.store.upload.name != "upload.zip" {
		t.Fatalf("unsafe name kept: %q", f.store.upload.name)
	}

	for _, id := range []string{"", "../x", "ABCDEF0123456789abcdef0123456789", state.ID + "0"} {
		if _, err := f.store.UploadOffset(id); !errors.Is(err, ErrUploadNotFound) {
			t.Errorf("id %q: %v", id, err)
		}
	}
}

func TestOneUploadAtATime(t *testing.T) {
	f := uploadFixture(t, 1<<20)
	first, err := f.store.BeginUpload(10, "a.zip")
	must(t, err)
	if _, err := f.store.BeginUpload(10, "b.zip"); !errors.Is(err, ErrUploadBusy) {
		t.Fatalf("second upload: %v", err)
	}

	// Abandoned for long enough, it no longer blocks; its data goes.
	f.clock = f.clock.Add(uploadIdle + time.Second)
	second, err := f.store.BeginUpload(10, "b.zip")
	must(t, err)
	if _, err := f.store.UploadOffset(first.ID); !errors.Is(err, ErrUploadNotFound) {
		t.Fatalf("stale upload: %v", err)
	}
	if entries, _ := os.ReadDir(filepath.Join(f.backupsDir, uploadsDir)); len(entries) != 1 {
		t.Fatalf("work directory %v", entries)
	}

	must(t, f.store.AbortUpload(second.ID))
	if entries, _ := os.ReadDir(filepath.Join(f.backupsDir, uploadsDir)); len(entries) != 0 {
		t.Fatalf("after abort %v", entries)
	}
	if _, err := f.store.BeginUpload(10, "c.zip"); err != nil {
		t.Fatalf("after abort: %v", err)
	}
}

func TestEnableUploadsDropsLeftovers(t *testing.T) {
	f := uploadFixture(t, 1<<20)
	state, err := f.store.BeginUpload(10, "a.zip")
	must(t, err)
	_, err = f.store.AppendUpload(state.ID, 0, io.LimitReader(bytes.NewReader(make([]byte, 5)), 5))
	must(t, err)

	restarted := NewStore(f.saves, f.backups, f.mods)
	must(t, restarted.EnableUploads(1<<20))
	if entries, _ := os.ReadDir(filepath.Join(f.backupsDir, uploadsDir)); len(entries) != 0 {
		t.Fatalf("leftovers %v", entries)
	}
}

func TestUploadsOffByDefault(t *testing.T) {
	f := newFixture(t)
	if _, err := f.store.BeginUpload(10, "a.zip"); !errors.Is(err, ErrUploadsDisabled) {
		t.Fatalf("got %v", err)
	}
	f.save(t, "_autosave1", "a", time.Minute)
	if _, err := f.store.Create(CreateRequest{Source: SourceUpload}); err == nil {
		t.Fatal("an upload archive was taken from the saves folder")
	}
}
