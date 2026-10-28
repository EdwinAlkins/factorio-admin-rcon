package mods

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Version is a Factorio version, `major.minor.patch`. Mods use the same
// three-part form; `factorio_version` in info.json uses only two.
type Version [3]int

// ParseVersion reads `a.b.c`, or `a.b` (patch 0).
func ParseVersion(raw string) (Version, error) {
	parts := strings.Split(strings.TrimSpace(raw), ".")
	if len(parts) < 2 || len(parts) > 3 {
		return Version{}, fmt.Errorf("version %q: expected a.b or a.b.c", raw)
	}
	var v Version
	for i, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 || n > 65535 || part == "" {
			return Version{}, fmt.Errorf("version %q: %q is not a number", raw, part)
		}
		v[i] = n
	}
	return v, nil
}

func (v Version) String() string { return fmt.Sprintf("%d.%d.%d", v[0], v[1], v[2]) }

// MajorMinor is the `factorio_version` a release must declare to run on v.
func (v Version) MajorMinor() string { return fmt.Sprintf("%d.%d", v[0], v[1]) }

// Compare returns -1, 0 or 1.
func (v Version) Compare(other Version) int {
	for i := range v {
		switch {
		case v[i] < other[i]:
			return -1
		case v[i] > other[i]:
			return 1
		}
	}
	return 0
}

// DependencyKind is the prefix of a dependency string.
type DependencyKind string

const (
	Required DependencyKind = "required"
	Optional DependencyKind = "optional" // `?`
	Hidden   DependencyKind = "hidden"   // `(?)`: optional, not shown in game
	// `+` (Factorio 2.1): optional but recommended — the game enables it by
	// default, and it can be turned off. Never installed for the operator.
	Recommended  DependencyKind = "recommended"
	Incompatible DependencyKind = "incompatible" // `!`
	// `~`: required, without affecting the load order. Same rules here.
	Unordered DependencyKind = "unordered"
)

// Dependency is one entry of info.json's `dependencies`.
type Dependency struct {
	Kind DependencyKind `json:"kind"`
	Name string         `json:"name"`
	// Empty when the dependency accepts any version.
	Op      string  `json:"op,omitzero"`
	Version Version `json:"-"`
}

// Requires reports whether the dependency must be present and enabled.
func (d Dependency) Requires() bool { return d.Kind == Required || d.Kind == Unordered }

// Accepts reports whether version v satisfies the dependency's constraint.
func (d Dependency) Accepts(v Version) bool {
	c := v.Compare(d.Version)
	switch d.Op {
	case "":
		return true
	case "<":
		return c < 0
	case "<=":
		return c <= 0
	case "=":
		return c == 0
	case ">=":
		return c >= 0
	case ">":
		return c > 0
	}
	return false
}

// Constraint renders the version part, `>= 1.2.0`, or "" when there is none.
func (d Dependency) Constraint() string {
	if d.Op == "" {
		return ""
	}
	return d.Op + " " + d.Version.String()
}

func (d Dependency) String() string {
	if c := d.Constraint(); c != "" {
		return d.Name + " " + c
	}
	return d.Name
}

// `[prefix] name [op version]`. Mod names may contain spaces, so the name is
// whatever stands between the prefix and the operator.
var dependencyPattern = regexp.MustCompile(`^\s*(\(\?\)|\?|!|~|\+)?\s*(.+?)\s*(?:(<=|>=|<|>|=)\s*([0-9]+(?:\.[0-9]+){1,2}))?\s*$`)

var errDependency = errors.New("unreadable dependency")

// ParseDependency reads one dependency string, e.g. `? bobplates >= 1.1.0`.
func ParseDependency(raw string) (Dependency, error) {
	match := dependencyPattern.FindStringSubmatch(raw)
	if match == nil || strings.TrimSpace(match[2]) == "" || len(raw) > 200 {
		return Dependency{}, fmt.Errorf("%w: %q", errDependency, raw)
	}
	d := Dependency{Name: match[2], Op: match[3]}
	switch match[1] {
	case "":
		d.Kind = Required
	case "?":
		d.Kind = Optional
	case "(?)":
		d.Kind = Hidden
	case "!":
		d.Kind = Incompatible
	case "~":
		d.Kind = Unordered
	case "+":
		d.Kind = Recommended
	}
	if d.Op != "" {
		v, err := ParseVersion(match[4])
		if err != nil {
			return Dependency{}, fmt.Errorf("%w: %q", errDependency, raw)
		}
		d.Version = v
	}
	if strings.ContainsAny(d.Name, "<>=") {
		return Dependency{}, fmt.Errorf("%w: %q", errDependency, raw)
	}
	return d, nil
}

// ParseDependencies reads a whole list. info.json defaults to `["base"]` when
// the field is absent; callers pass that default themselves.
func ParseDependencies(raw []string) ([]Dependency, error) {
	list := make([]Dependency, 0, len(raw))
	for _, entry := range raw {
		d, err := ParseDependency(entry)
		if err != nil {
			return nil, err
		}
		list = append(list, d)
	}
	return list, nil
}
