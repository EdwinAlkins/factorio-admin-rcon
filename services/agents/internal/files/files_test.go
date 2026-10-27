package files

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestValidZipName(t *testing.T) {
	for name, want := range map[string]bool{
		"_autosave1.zip": true, "my-map.v2.zip": true,
		"../x.zip": false, "a/b.zip": false, ".hidden.zip": false, "x.ZIP": false,
		"x.tmp.zip": false, "x.zip.partial": false, "": false, "x y.zip": false,
	} {
		if got := ValidZipName(name); got != want {
			t.Errorf("%q: got %v", name, got)
		}
	}
}

func TestCopyAtomicLeavesNothingWhenVerificationFails(t *testing.T) {
	srcDir, dstDir := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(srcDir, "a.zip"), []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	src, _ := os.OpenRoot(srcDir)
	dst, _ := os.OpenRoot(dstDir)

	refuse := errors.New("refused")
	_, err := CopyAtomic(src, "a.zip", dst, "b.zip", 0o600, func(*os.File, int64) error { return refuse })
	if !errors.Is(err, refuse) {
		t.Fatalf("got %v", err)
	}
	if entries, _ := os.ReadDir(dstDir); len(entries) != 0 {
		t.Fatalf("left %v", entries)
	}

	copied, err := CopyAtomic(src, "a.zip", dst, "b.zip", 0o600, nil)
	if err != nil || copied.Size != 4 || len(copied.SHA256) != 64 {
		t.Fatalf("copy: %+v %v", copied, err)
	}
	if entries, _ := os.ReadDir(dstDir); len(entries) != 1 {
		t.Fatalf("expected only b.zip, got %v", entries)
	}
}

func TestRootRefusesEscapes(t *testing.T) {
	inside, outside := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.zip"), []byte("s"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.zip"), filepath.Join(inside, "link.zip")); err != nil {
		t.Fatal(err)
	}
	src, _ := os.OpenRoot(inside)
	dst, _ := os.OpenRoot(t.TempDir())

	for _, name := range []string{"link.zip", "../" + filepath.Base(outside) + "/secret.zip"} {
		if _, err := CopyAtomic(src, name, dst, "out.zip", 0o600, nil); err == nil {
			t.Errorf("%s: read outside the root", name)
		}
	}
}
