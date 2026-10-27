package target

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/docker"
)

type stubDocker struct {
	found  []docker.Container
	labels [][]string
}

func (s *stubDocker) ListContainers(_ context.Context, labels []string) ([]docker.Container, error) {
	s.labels = append(s.labels, labels)
	return s.found, nil
}

func TestLabels(t *testing.T) {
	stub := &stubDocker{found: []docker.Container{{ID: "a"}}}

	_, _ = NewResolver(stub, "stack", "factorio").ForWrite(context.Background())
	_, _ = NewResolver(stub, "", "factorio").ForWrite(context.Background())

	if !slices.Equal(stub.labels[0], []string{"com.docker.compose.service=factorio", "com.docker.compose.project=stack"}) {
		t.Errorf("with a project: %v", stub.labels[0])
	}
	if !slices.Equal(stub.labels[1], []string{"com.docker.compose.service=factorio"}) {
		t.Errorf("without a project: %v", stub.labels[1])
	}
}

func TestMatchCount(t *testing.T) {
	for _, tc := range []struct {
		found []docker.Container
		want  error
	}{
		{nil, ErrMissing},
		{[]docker.Container{{ID: "a"}, {ID: "b"}}, ErrAmbiguous},
	} {
		_, err := NewResolver(&stubDocker{found: tc.found}, "stack", "factorio").ForRead(context.Background())
		if !errors.Is(err, tc.want) {
			t.Errorf("%d matches: got %v, want %v", len(tc.found), err, tc.want)
		}
	}
}

func TestReadsAreCachedWritesAreNot(t *testing.T) {
	stub := &stubDocker{found: []docker.Container{{ID: "a"}}}
	now := time.Unix(0, 0)
	resolver := NewResolver(stub, "stack", "factorio")
	resolver.now = func() time.Time { return now }

	for range 3 {
		_, _ = resolver.ForRead(context.Background())
	}
	if len(stub.labels) != 1 {
		t.Errorf("reads listed containers %d times, want 1", len(stub.labels))
	}

	// The container was recreated: a write must see the new id at once.
	stub.found = []docker.Container{{ID: "b"}}
	if id, _ := resolver.ForWrite(context.Background()); id != "b" {
		t.Errorf("write resolved %q", id)
	}

	now = now.Add(readCacheTTL)
	stub.found = []docker.Container{{ID: "c"}}
	if id, _ := resolver.ForRead(context.Background()); id != "c" {
		t.Errorf("read after expiry resolved %q", id)
	}
}
