// Package agents_test checks the privilege split between the two agents at
// the level that matters: what each binary can call. The control agent holds
// the Docker socket and must contain no code that touches Factorio's files;
// the data agent holds the files and must contain no code that talks to
// Docker. Documentation can drift — the import graph cannot.
package agents_test

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

const module = "github.com/EdwinAlkins/factorio-admin-rcon/services/agents/"

// Packages each entry point must never link, directly or transitively.
var forbidden = map[string][]string{
	"./cmd/control-agent": {"internal/data/", "internal/files", "internal/saves", "internal/mods", "internal/portal", "internal/serversettings"},
	"./cmd/data-agent":    {"internal/control/", "internal/docker", "internal/target"},
	// The shared kit is linked into both: it may hold neither privilege.
	"./internal/agentkit": {
		"internal/control/", "internal/docker", "internal/target",
		"internal/data/", "internal/files", "internal/saves", "internal/mods", "internal/portal", "internal/serversettings",
	},
}

func TestPrivilegeBoundaries(t *testing.T) {
	for pkg, banned := range forbidden {
		if _, err := os.Stat(pkg); err != nil {
			t.Logf("%s does not exist yet, skipped", pkg)
			continue
		}

		out, err := exec.Command("go", "list", "-deps", pkg).Output()
		if err != nil {
			t.Fatalf("go list -deps %s: %v", pkg, err)
		}

		for _, dep := range strings.Fields(string(out)) {
			local, ok := strings.CutPrefix(dep, module)
			if !ok {
				continue
			}
			for _, prefix := range banned {
				if strings.HasPrefix(local, prefix) {
					t.Errorf("%s links %s, which it must never contain", pkg, local)
				}
			}
		}
	}
}
