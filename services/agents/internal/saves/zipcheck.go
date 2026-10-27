package saves

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"regexp"
	"strings"
)

// ErrInvalidArchive covers every way a file can fail to be a Factorio save.
var ErrInvalidArchive = errors.New("not a valid Factorio save")

// Bounds on what an archive may declare. A real save holds a few dozen
// entries and expands to well under a gigabyte; these only stop a crafted
// archive from making the check itself the problem.
const (
	maxEntries      = 100_000
	maxUncompressed = 64 << 30
)

// A save holds `<name>/level-init.dat` and `<name>/level.dat<n>`.
var levelEntry = regexp.MustCompile(`(^|/)level(-init\.dat|\.dat[0-9]+)$`)

// VerifySave reads the whole archive: the central directory must parse, every
// entry must decompress with a matching CRC, names must stay relative, and the
// level data must be present. A save truncated mid-write — an autosave copied
// while Factorio was writing it — fails here instead of being archived.
func VerifySave(f *os.File, size int64) error {
	reader, err := zip.NewReader(f, size)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInvalidArchive, err)
	}
	if len(reader.File) == 0 || len(reader.File) > maxEntries {
		return fmt.Errorf("%w: %d entries", ErrInvalidArchive, len(reader.File))
	}

	var total uint64
	hasLevel := false
	for _, entry := range reader.File {
		name := entry.Name
		if path.IsAbs(name) || strings.Contains(name, "\\") || hasDotDot(name) {
			return fmt.Errorf("%w: unsafe entry name %q", ErrInvalidArchive, name)
		}
		total += entry.UncompressedSize64
		if total > maxUncompressed {
			return fmt.Errorf("%w: expands beyond %d bytes", ErrInvalidArchive, uint64(maxUncompressed))
		}
		if levelEntry.MatchString(name) {
			hasLevel = true
		}
		if err := drain(entry); err != nil {
			return fmt.Errorf("%w: %s: %w", ErrInvalidArchive, name, err)
		}
	}
	if !hasLevel {
		return fmt.Errorf("%w: no level data", ErrInvalidArchive)
	}
	return nil
}

// drain decompresses one entry; archive/zip checks the CRC at the end.
func drain(entry *zip.File) error {
	if entry.FileInfo().IsDir() {
		return nil
	}
	rc, err := entry.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	// One byte past the declared size: a lying header is caught as a
	// size mismatch rather than read without end. The declared size is
	// already bounded by maxUncompressed, so the conversion cannot overflow.
	limit := int64(min(entry.UncompressedSize64, maxUncompressed)) + 1
	_, err = io.Copy(io.Discard, io.LimitReader(rc, limit))
	return err
}

func hasDotDot(name string) bool {
	for part := range strings.SplitSeq(name, "/") {
		if part == ".." {
			return true
		}
	}
	return false
}
