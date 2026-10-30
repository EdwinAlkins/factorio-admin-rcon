// Package fakeportal stands in for mods.factorio.com in tests: one TLS server
// answering for three hosts — the portal, its download host, and a host the
// client must never reach — with a client that dials all three to it.
package fakeportal

import (
	"context"
	"crypto/sha1" //nolint:gosec // G505: mirrors the portal's checksums
	"crypto/x509"
	"encoding/hex"
	"encoding/json/v2"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/fakesave"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/portal"
)

const (
	PortalHost   = "portal.test"
	DownloadHost = "dl.test"
	EvilHost     = "evil.test"
	Username     = "engineer"
	Token        = "s3cr3t-portal-token-0123456789"
)

// Hosts the client is allowed to reach.
var Hosts = []string{PortalHost, DownloadHost}

type Portal struct {
	Server *httptest.Server
	// Trusts the server's certificate, dials every host to it.
	Client *http.Client

	mu    sync.Mutex
	mods  map[string]*portal.Mod
	files map[string][]byte
	// Downloads are redirected here instead of DownloadHost when set.
	RedirectHost string
	requests     []string
}

func New(t *testing.T) *Portal {
	t.Helper()
	p := &Portal{mods: map[string]*portal.Mod{}, files: map[string][]byte{}}
	p.Server = httptest.NewTLSServer(http.HandlerFunc(p.serve))
	t.Cleanup(p.Server.Close)

	pool := x509.NewCertPool()
	pool.AddCert(p.Server.Certificate())
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, p.Server.Listener.Addr().String())
		},
	}
	transport.TLSClientConfig = p.Server.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
	transport.TLSClientConfig.RootCAs = pool
	// httptest's certificate names example.com: checked against that name,
	// whatever host the URL says.
	transport.TLSClientConfig.ServerName = "example.com"
	p.Client = &http.Client{Transport: transport}
	return p
}

// BaseURL is the portal's address for portal.Options.
func (p *Portal) BaseURL() string { return "https://" + PortalHost }

// NewClient returns a portal client on this fake, with or without credentials.
func (p *Portal) NewClient(t *testing.T, withCredentials bool) *portal.Client {
	t.Helper()
	options := portal.Options{BaseURL: p.BaseURL(), AllowedHosts: Hosts, HTTPClient: p.Client}
	if withCredentials {
		options.Credentials = portal.Credentials{Username: Username, Token: Token}
	}
	client, err := portal.New(options)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

// Publish adds a release served as `archive` (nil: a valid mod archive).
// deps nil means the field is absent from info.json.
func (p *Portal) Publish(t *testing.T, name, version, factorio string, deps []string, archive []byte) {
	t.Helper()
	if archive == nil {
		archive = ModArchive(t, name, version, deps)
	}
	sum := sha1.Sum(archive) //nolint:gosec // G401: mirrors the portal
	release := portal.Release{
		Version:     version,
		DownloadURL: "/download/" + name + "/" + version,
		FileName:    name + "_" + version + ".zip",
		SHA1:        hex.EncodeToString(sum[:]),
		ReleasedAt:  "2026-10-" + version + "T00:00:00Z",
	}
	release.InfoJSON.FactorioVersion = factorio
	if deps != nil {
		list := append([]string{}, deps...)
		release.InfoJSON.Dependencies = &list
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	mod := p.mods[name]
	if mod == nil {
		mod = &portal.Mod{Name: name, Title: strings.ToUpper(name), Owner: "someone"}
		p.mods[name] = mod
	}
	mod.Releases = append(mod.Releases, release)
	p.files[release.FileName] = archive
}

// Tamper replaces the bytes served for a file, keeping the published SHA-1.
func (p *Portal) Tamper(fileName string, archive []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.files[fileName] = archive
}

// Requests lists what the fake received, `host path?query`.
func (p *Portal) Requests() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string{}, p.requests...)
}

// ModArchive builds a well-formed mod archive.
func ModArchive(t *testing.T, name, version string, deps []string) []byte {
	t.Helper()
	info := map[string]any{"name": name, "version": version, "title": name, "factorio_version": "2.1"}
	if deps != nil {
		info["dependencies"] = deps
	}
	raw, err := json.Marshal(info)
	if err != nil {
		t.Fatal(err)
	}
	root := name + "_" + version + "/"
	return fakesave.Build(t, map[string]string{
		root + "info.json":   string(raw),
		root + "control.lua": "-- " + name,
	})
}

func (p *Portal) serve(w http.ResponseWriter, r *http.Request) {
	host, _, err := net.SplitHostPort(r.Host)
	if err != nil {
		host = r.Host
	}
	p.mu.Lock()
	p.requests = append(p.requests, host+" "+r.URL.RequestURI())
	p.mu.Unlock()

	switch host {
	case PortalHost:
		p.servePortal(w, r)
	case DownloadHost:
		p.serveFile(w, r)
	default:
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write([]byte("evil payload"))
	}
}

func (p *Portal) servePortal(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	defer p.mu.Unlock()
	path := r.URL.Path
	switch {
	case path == "/login":
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html>log in</html>"))

	case r.Method == http.MethodGet && strings.HasPrefix(path, "/api/mods/") && strings.HasSuffix(path, "/full"):
		name := strings.TrimSuffix(strings.TrimPrefix(path, "/api/mods/"), "/full")
		mod := p.mods[name]
		if mod == nil {
			http.Error(w, `{"message":"Mod not found"}`, http.StatusNotFound)
			return
		}
		writeJSON(w, mod)

	case r.Method == http.MethodGet && path == "/api/mods":
		results := []portal.Mod{}
		for name := range strings.SplitSeq(r.URL.Query().Get("namelist"), ",") {
			if mod := p.mods[name]; mod != nil {
				short := *mod
				short.Releases = nil
				for _, release := range mod.Releases {
					release.InfoJSON.Dependencies = nil
					short.Releases = append(short.Releases, release)
				}
				results = append(results, short)
			}
		}
		writeJSON(w, map[string]any{"pagination": nil, "results": results})

	case r.Method == http.MethodPost && path == "/api/search":
		var body struct {
			Username string `json:"username"`
			Token    string `json:"token"`
			Query    string `json:"query"`
		}
		if json.UnmarshalRead(r.Body, &body) != nil || body.Username != Username || body.Token != Token {
			http.Error(w, `{"message":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		hits := []portal.Hit{}
		for name, mod := range p.mods {
			if strings.Contains(name, body.Query) {
				hits = append(hits, portal.Hit{Name: name, Title: mod.Title, Owner: mod.Owner})
			}
		}
		writeJSON(w, map[string]any{"pagination": map[string]int{"page": 1, "page_count": 1}, "results": hits})

	case strings.HasPrefix(path, "/download/"):
		query := r.URL.Query()
		if query.Get("username") != Username || query.Get("token") != Token {
			http.Redirect(w, r, "https://"+PortalHost+"/login", http.StatusFound)
			return
		}
		parts := strings.Split(strings.TrimPrefix(path, "/download/"), "/")
		target := p.RedirectHost
		if target == "" {
			target = DownloadHost
		}
		http.Redirect(w, r, "https://"+target+"/files/"+parts[0]+"_"+parts[len(parts)-1]+".zip?signed=1", http.StatusFound)

	default:
		http.NotFound(w, r)
	}
}

func (p *Portal) serveFile(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	archive, ok := p.files[strings.TrimPrefix(r.URL.Path, "/files/")]
	p.mu.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	_, _ = w.Write(archive)
}

func writeJSON(w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.MarshalWrite(w, body)
}
