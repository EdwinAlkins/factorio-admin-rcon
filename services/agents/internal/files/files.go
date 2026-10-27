// Package files holds the data agent's two file primitives: name validation
// and the atomic, verified copy. Every path goes through an *os.Root, so a
// name cannot leave its directory — `..`, absolute paths and symbolic links
// pointing outside are refused by the standard library, not by a check of
// ours that could be got wrong.
package files

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"regexp"
	"strings"
)

var zipName = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}\.zip$`)

// ValidZipName accepts a plain archive name: no directory, no leading dot
// (autosaves do lead with an underscore), nothing outside [A-Za-z0-9._-]. `*.tmp.zip` is Factorio's own half-written
// save, which factoriotools deletes at startup: never a valid source.
func ValidZipName(name string) bool {
	return zipName.MatchString(name) && !strings.HasSuffix(strings.ToLower(name), ".tmp.zip")
}

// Copied describes a completed copy.
type Copied struct {
	Size   int64
	SHA256 string
}

// Verifier inspects the fully written copy before it is published.
type Verifier func(f *os.File, size int64) error

// CopyAtomic copies src/srcName to dst/dstName through a temporary file in
// dst, published by a rename only once it is complete, synced and verified.
// A crash or a failed check leaves no partial file under dstName. The
// temporary name ends in neither `.zip` nor `.json`, so no reader — the
// agent's listings, Factorio, the factoriotools entrypoint — ever mistakes it
// for a real file.
func CopyAtomic(src *os.Root, srcName string, dst *os.Root, dstName string, perm fs.FileMode, verify Verifier) (Copied, error) {
	in, err := src.Open(srcName)
	if err != nil {
		return Copied{}, err
	}
	defer in.Close()

	tmp, err := tempName(dstName)
	if err != nil {
		return Copied{}, err
	}
	// Read-write: the verifier reads back what was written.
	out, err := dst.OpenFile(tmp, os.O_RDWR|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return Copied{}, err
	}
	published := false
	defer func() {
		if !published {
			_ = out.Close()
			_ = dst.Remove(tmp)
		}
	}()

	hash := sha256.New()
	size, err := io.Copy(io.MultiWriter(out, hash), in)
	if err != nil {
		return Copied{}, fmt.Errorf("copying %s: %w", srcName, err)
	}
	if err := out.Sync(); err != nil {
		return Copied{}, err
	}
	if verify != nil {
		if err := verify(out, size); err != nil {
			return Copied{}, err
		}
	}
	if err := out.Close(); err != nil {
		return Copied{}, err
	}
	if err := dst.Rename(tmp, dstName); err != nil {
		return Copied{}, err
	}
	published = true
	syncDir(dst)

	return Copied{Size: size, SHA256: hex.EncodeToString(hash.Sum(nil))}, nil
}

// WriteAtomic writes a small file (a sidecar) with the same publish-by-rename
// guarantee.
func WriteAtomic(dst *os.Root, name string, data []byte, perm fs.FileMode) error {
	tmp, err := tempName(name)
	if err != nil {
		return err
	}
	out, err := dst.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return err
	}
	_, err = out.Write(data)
	if err == nil {
		err = out.Sync()
	}
	if closeErr := out.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = dst.Rename(tmp, name)
	}
	if err != nil {
		_ = dst.Remove(tmp)
		return err
	}
	syncDir(dst)
	return nil
}

// HashFile returns the SHA-256 of a file inside root.
func HashFile(root *os.Root, name string) (string, error) {
	f, err := root.Open(name)
	if err != nil {
		return "", err
	}
	defer f.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// CheckWritable fails early, at startup, when the agent cannot write into a
// directory — typically a host directory not owned by the agent's uid.
func CheckWritable(root *os.Root) error {
	name, err := tempName("write-check")
	if err != nil {
		return err
	}
	if err := root.WriteFile(name, nil, 0o600); err != nil {
		return err
	}
	return root.Remove(name)
}

// IsNotExist reports a missing file, whichever layer said so.
func IsNotExist(err error) bool {
	return errors.Is(err, fs.ErrNotExist)
}

func tempName(base string) (string, error) {
	suffix := make([]byte, 6)
	if _, err := rand.Read(suffix); err != nil {
		return "", err
	}
	return "." + base + ".partial-" + hex.EncodeToString(suffix), nil
}

// syncDir makes the rename itself durable. Best effort: a filesystem that
// cannot fsync a directory still has the file.
func syncDir(root *os.Root) {
	if dir, err := root.Open("."); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
}
