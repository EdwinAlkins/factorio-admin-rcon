package mods

import "testing"

func TestParseVersion(t *testing.T) {
	for raw, want := range map[string]Version{"2.1.23": {2, 1, 23}, "1.0": {1, 0, 0}, "0.18.47": {0, 18, 47}} {
		if got, err := ParseVersion(raw); err != nil || got != want {
			t.Errorf("%s: %v %v", raw, got, err)
		}
	}
	for _, raw := range []string{"", "2", "2.1.x", "1.2.3.4", "-1.0", "2..1"} {
		if _, err := ParseVersion(raw); err == nil {
			t.Errorf("%q accepted", raw)
		}
	}
	if (Version{2, 1, 0}).Compare(Version{2, 0, 99}) != 1 || (Version{1, 1, 1}).MajorMinor() != "1.1" {
		t.Error("comparison")
	}
}

func TestParseDependency(t *testing.T) {
	cases := map[string]Dependency{
		"base >= 2.1.0":           {Kind: Required, Name: "base", Op: ">=", Version: Version{2, 1, 0}},
		"? bobplates":             {Kind: Optional, Name: "bobplates"},
		"(?) hidden-mod < 1.0":    {Kind: Hidden, Name: "hidden-mod", Op: "<", Version: Version{1, 0, 0}},
		"! bad_mod":               {Kind: Incompatible, Name: "bad_mod"},
		"~ flib = 0.15.2":         {Kind: Unordered, Name: "flib", Op: "=", Version: Version{0, 15, 2}},
		"Mod With Spaces > 1.0.0": {Kind: Required, Name: "Mod With Spaces", Op: ">", Version: Version{1, 0, 0}},
		"?flib":                   {Kind: Optional, Name: "flib"},
	}
	for raw, want := range cases {
		got, err := ParseDependency(raw)
		if err != nil || got != want {
			t.Errorf("%q: got %+v %v", raw, got, err)
		}
	}
	for _, raw := range []string{"", "   ", ">= 1.0", "flib >= x", "flib >> 1.0"} {
		if _, err := ParseDependency(raw); err == nil {
			t.Errorf("%q accepted", raw)
		}
	}
}

func TestAccepts(t *testing.T) {
	d, _ := ParseDependency("flib >= 0.15.0")
	if !d.Accepts(Version{0, 15, 0}) || d.Accepts(Version{0, 14, 9}) {
		t.Error(">=")
	}
	any, _ := ParseDependency("flib")
	if !any.Accepts(Version{}) {
		t.Error("no constraint")
	}
}
