package portal_test

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/fakeportal"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/portal"
)

func release(t *testing.T, client *portal.Client, name string) portal.Release {
	t.Helper()
	mod, err := client.Full(context.Background(), name)
	if err != nil {
		t.Fatal(err)
	}
	return mod.Releases[len(mod.Releases)-1]
}

func TestFullAndReleases(t *testing.T) {
	fake := fakeportal.New(t)
	fake.Publish(t, "flib", "1.0.0", "2.1", []string{"base >= 2.1.0"}, nil)
	client := fake.NewClient(t, false)

	mod, err := client.Full(context.Background(), "flib")
	if err != nil || len(mod.Releases) != 1 {
		t.Fatalf("full: %+v %v", mod, err)
	}
	if deps := mod.Releases[0].InfoJSON.Dependencies; deps == nil || (*deps)[0] != "base >= 2.1.0" {
		t.Fatalf("dependencies: %v", deps)
	}
	if _, err := client.Full(context.Background(), "nope"); !errors.Is(err, portal.ErrNotFound) {
		t.Fatalf("unknown mod: %v", err)
	}
	if _, err := client.Full(context.Background(), "../etc"); !errors.Is(err, portal.ErrNotFound) {
		t.Fatalf("crafted name reached the portal: %v", err)
	}

	releases, err := client.Releases(context.Background(), []string{"flib", "nope"})
	if err != nil || len(releases["flib"]) != 1 || len(releases) != 1 {
		t.Fatalf("releases: %v %v", releases, err)
	}

	// Answers are cached: a second look does not call the portal again.
	before := len(fake.Requests())
	_, _ = client.Full(context.Background(), "flib")
	if len(fake.Requests()) != before {
		t.Error("the mod page was fetched twice")
	}
}

func TestDownload(t *testing.T) {
	fake := fakeportal.New(t)
	fake.Publish(t, "flib", "1.0.0", "2.1", nil, nil)
	client := fake.NewClient(t, true)
	r := release(t, client, "flib")

	var out bytes.Buffer
	if _, err := client.Download(context.Background(), r, &out, 1<<20); err != nil {
		t.Fatalf("download: %v", err)
	}
	if !bytes.HasPrefix(out.Bytes(), []byte("PK")) {
		t.Fatal("not a zip")
	}

	t.Run("checksum", func(t *testing.T) {
		fake.Tamper(r.FileName, fakeportal.ModArchive(t, "flib", "1.0.0", []string{"evil"}))
		defer fake.Tamper(r.FileName, out.Bytes())
		if _, err := client.Download(context.Background(), r, &bytes.Buffer{}, 1<<20); !errors.Is(err, portal.ErrChecksum) {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("too large", func(t *testing.T) {
		if _, err := client.Download(context.Background(), r, &bytes.Buffer{}, 10); !errors.Is(err, portal.ErrTooLarge) {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("redirect to another host", func(t *testing.T) {
		fake.RedirectHost = fakeportal.EvilHost
		defer func() { fake.RedirectHost = "" }()
		_, err := client.Download(context.Background(), r, &bytes.Buffer{}, 1<<20)
		if !errors.Is(err, portal.ErrUnreachable) {
			t.Fatalf("got %v", err)
		}
		if strings.Contains(err.Error(), fakeportal.Token) {
			t.Fatalf("the token leaked into the error: %v", err)
		}
		for _, request := range fake.Requests() {
			if strings.HasPrefix(request, fakeportal.EvilHost) {
				t.Fatalf("the client reached %s", request)
			}
		}
	})

	t.Run("refused credentials", func(t *testing.T) {
		wrong, err := portal.New(portal.Options{
			BaseURL: fake.BaseURL(), AllowedHosts: fakeportal.Hosts, HTTPClient: fake.Client,
			Credentials: portal.Credentials{Username: fakeportal.Username, Token: "wrong-token"},
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := wrong.Download(context.Background(), r, &bytes.Buffer{}, 1<<20); !errors.Is(err, portal.ErrRejected) {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("no credentials", func(t *testing.T) {
		anonymous := fake.NewClient(t, false)
		if _, err := anonymous.Download(context.Background(), r, &bytes.Buffer{}, 1<<20); !errors.Is(err, portal.ErrNoCredentials) {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("download path from elsewhere", func(t *testing.T) {
		crafted := r
		crafted.DownloadURL = "/api/mods?x=1"
		if _, err := client.Download(context.Background(), crafted, &bytes.Buffer{}, 1<<20); err == nil {
			t.Fatal("a non-download path was fetched")
		}
	})
}

func TestUnreachableErrorHidesToken(t *testing.T) {
	fake := fakeportal.New(t)
	fake.Publish(t, "flib", "1.0.0", "2.1", nil, nil)
	client := fake.NewClient(t, true)
	r := release(t, client, "flib")
	fake.Server.Close()

	_, err := client.Download(context.Background(), r, &bytes.Buffer{}, 1<<20)
	if !errors.Is(err, portal.ErrUnreachable) || strings.Contains(err.Error(), fakeportal.Token) {
		t.Fatalf("got %v", err)
	}
}

func TestSearch(t *testing.T) {
	fake := fakeportal.New(t)
	fake.Publish(t, "even-distribution", "1.0.0", "2.1", nil, nil)

	if _, err := fake.NewClient(t, false).Search(context.Background(), "even", "2.1", 1); !errors.Is(err, portal.ErrNoCredentials) {
		t.Fatalf("anonymous search: %v", err)
	}
	result, err := fake.NewClient(t, true).Search(context.Background(), "even", "2.1", 1)
	if err != nil || len(result.Hits) != 1 || result.Hits[0].Name != "even-distribution" {
		t.Fatalf("search: %+v %v", result, err)
	}
}

func TestNewRefusesUnsafeBase(t *testing.T) {
	for _, base := range []string{"http://mods.factorio.com", "https://elsewhere.example"} {
		if _, err := portal.New(portal.Options{BaseURL: base, AllowedHosts: portal.DefaultHosts}); err == nil {
			t.Errorf("%s accepted", base)
		}
	}
}

func TestReadCredentials(t *testing.T) {
	dir := t.TempDir()
	write := func(content string) string {
		path := filepath.Join(dir, "creds")
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}

	for _, content := range []string{"", "  \n", "{}"} {
		if creds, err := portal.ReadCredentials(write(content)); err != nil || creds.Token != "" {
			t.Errorf("%q: %v %v", content, creds, err)
		}
	}
	if creds, err := portal.ReadCredentials(filepath.Join(dir, "missing")); err != nil || creds.Token != "" {
		t.Errorf("missing file: %v %v", creds, err)
	}
	if _, err := portal.ReadCredentials(write(`{"username":"a"}`)); err == nil {
		t.Error("a username without a token was accepted")
	}
	if _, err := portal.ReadCredentials(write(`not json`)); err == nil {
		t.Error("garbage was accepted")
	}
	creds, err := portal.ReadCredentials(write(`{"username":" a ","token":"t"}`))
	if err != nil || creds.Username != "a" || creds.Token != "t" {
		t.Errorf("valid file: %v %v", creds, err)
	}
}
