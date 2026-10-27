package mods

import (
	"archive/zip"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/files"
)

// ErrInvalidMod covers every way a downloaded file can fail to be the mod
// release it claims to be.
var ErrInvalidMod = errors.New("not a valid mod archive")

var errNoInfo = errors.New("no info.json")

// Bounds on what a mod archive may declare. The largest mods on the portal
// weigh a few hundred megabytes; these only stop a crafted archive from
// making the check itself the problem.
const (
	maxModEntries      = 200_000
	maxModUncompressed = 8 << 30
	maxInfoBytes       = 256 << 10
)

type info struct {
	name         string
	version      string
	dependencies []Dependency
}

type rawInfo struct {
	Name         string    `json:"name"`
	Version      string    `json:"version"`
	Dependencies *[]string `json:"dependencies"`
}

func parseInfo(raw []byte) (info, error) {
	var parsed rawInfo
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return info{}, err
	}
	// Absent means `["base"]`, per the game's own default.
	declared := []string{"base"}
	if parsed.Dependencies != nil {
		declared = *parsed.Dependencies
	}
	dependencies, err := ParseDependencies(declared)
	if err != nil {
		return info{}, err
	}
	return info{name: parsed.Name, version: parsed.Version, dependencies: dependencies}, nil
}

func readInfoEntry(entry *zip.File) (info, error) {
	if entry.UncompressedSize64 > maxInfoBytes {
		return info{}, errors.New("info.json too large")
	}
	rc, err := entry.Open()
	if err != nil {
		return info{}, err
	}
	defer rc.Close()
	raw, err := io.ReadAll(io.LimitReader(rc, maxInfoBytes+1))
	if err != nil {
		return info{}, err
	}
	return parseInfo(raw)
}

// VerifyModArchive checks that f is release `name` `version` of a mod, as
// Factorio expects it:
//
//   - the archive reads in full, every entry with a matching CRC;
//   - every name is relative and stays inside the archive;
//   - everything sits under one top folder, `{name}_{version}/` or `{name}/`;
//   - that folder holds an info.json naming the same mod and version.
func VerifyModArchive(f *os.File, size int64, name, version string) error {
	reader, err := zip.NewReader(f, size)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInvalidMod, err)
	}
	if len(reader.File) == 0 || len(reader.File) > maxModEntries {
		return fmt.Errorf("%w: %d entries", ErrInvalidMod, len(reader.File))
	}

	top := ""
	var infoEntry *zip.File
	var total uint64
	for _, entry := range reader.File {
		if !files.SafeEntryName(entry.Name) {
			return fmt.Errorf("%w: unsafe entry name %q", ErrInvalidMod, entry.Name)
		}
		first, rest, _ := strings.Cut(entry.Name, "/")
		if top == "" {
			top = first
		}
		if first != top || first == "" {
			return fmt.Errorf("%w: more than one top folder (%q, %q)", ErrInvalidMod, top, first)
		}
		if rest == "info.json" {
			infoEntry = entry
		}
		total += entry.UncompressedSize64
		if total > maxModUncompressed {
			return fmt.Errorf("%w: expands beyond %d bytes", ErrInvalidMod, uint64(maxModUncompressed))
		}
		if err := drain(entry); err != nil {
			return fmt.Errorf("%w: %s: %w", ErrInvalidMod, entry.Name, err)
		}
	}

	if top != name+"_"+version && top != name {
		return fmt.Errorf("%w: top folder %q, expected %s_%s", ErrInvalidMod, top, name, version)
	}
	if infoEntry == nil {
		return fmt.Errorf("%w: %w", ErrInvalidMod, errNoInfo)
	}
	declared, err := readInfoEntry(infoEntry)
	if err != nil {
		return fmt.Errorf("%w: info.json: %w", ErrInvalidMod, err)
	}
	if declared.name != name || declared.version != version {
		return fmt.Errorf("%w: info.json declares %s %s, expected %s %s",
			ErrInvalidMod, declared.name, declared.version, name, version)
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
	// One byte past the declared size: a lying header is caught as a size
	// mismatch rather than read without end.
	limit := int64(min(entry.UncompressedSize64, maxModUncompressed)) + 1
	_, err = io.Copy(io.Discard, io.LimitReader(rc, limit))
	return err
}
