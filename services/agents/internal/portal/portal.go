// Package portal is the data agent's client of the official mod portal,
// mods.factorio.com — the only place on the Internet any part of the stack
// reaches out to.
//
// No URL ever comes from a caller: requests are built from a fixed base and
// validated mod names, and every redirect is checked against a short list of
// hosts (the portal, and the download host it hands files out from), over
// HTTPS only. The player's token travels in a download URL's query string,
// as the portal requires; it is stripped from every error before anything
// can log it.
package portal

import (
	"bytes"
	"context"
	"crypto/sha1" //nolint:gosec // G505: the portal publishes SHA-1 sums; this only compares to them
	"encoding/hex"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	// ErrNotFound: no mod by that name on the portal.
	ErrNotFound = errors.New("mod not found on the portal")
	// ErrUnreachable: network failure, timeout, a 5xx or a malformed answer.
	ErrUnreachable = errors.New("mod portal unreachable")
	// ErrRejected: the portal refused the credentials.
	ErrRejected = errors.New("mod portal refused the credentials")
	// ErrNoCredentials: the operation needs a player's username and token,
	// and none were configured.
	ErrNoCredentials = errors.New("no mod portal credentials configured")
	// ErrTooLarge: a download exceeded the configured bound.
	ErrTooLarge = errors.New("download larger than allowed")
	// ErrChecksum: the downloaded bytes do not match the portal's SHA-1.
	ErrChecksum = errors.New("download does not match the portal's checksum")
)

// Production endpoints. Downloads are redirected to the second host.
const (
	DefaultBaseURL = "https://mods.factorio.com"
	downloadHost   = "dl-mod.factorio.com"
)

// DefaultHosts are the hosts a request may reach, redirects included.
var DefaultHosts = []string{"mods.factorio.com", downloadHost}

// Names on the portal: letters, digits, `-`, `_`, `.` and spaces.
var namePattern = regexp.MustCompile(`^[A-Za-z0-9._ -]{1,100}$`)

// ValidName reports whether name can be a mod's name.
func ValidName(name string) bool {
	return namePattern.MatchString(name) && strings.TrimSpace(name) == name
}

// Credentials are a factorio.com username and its token (from
// `player-data.json`, or the profile page).
type Credentials struct {
	Username string `json:"username"`
	Token    string `json:"token"`
}

// ReadCredentials reads the JSON secret. A missing, empty or `{}` file means
// no credentials: the feature that needs them is off, not broken.
func ReadCredentials(path string) (Credentials, error) {
	if path == "" {
		return Credentials{}, nil
	}
	raw, err := os.ReadFile(path) //nolint:gosec // G304: the path is the operator's own setting
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Credentials{}, nil
		}
		return Credentials{}, err
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return Credentials{}, nil
	}
	var creds Credentials
	if err := json.Unmarshal(raw, &creds); err != nil {
		return Credentials{}, fmt.Errorf("portal credentials: expected {\"username\": …, \"token\": …}: %w", err)
	}
	creds.Username = strings.TrimSpace(creds.Username)
	creds.Token = strings.TrimSpace(creds.Token)
	if (creds.Username == "") != (creds.Token == "") {
		return Credentials{}, errors.New("portal credentials: username and token go together")
	}
	return creds, nil
}

// Release is one version of a mod, as the portal lists it.
type Release struct {
	Version     string `json:"version"`
	DownloadURL string `json:"download_url"`
	FileName    string `json:"file_name"`
	SHA1        string `json:"sha1"`
	ReleasedAt  string `json:"released_at"`
	InfoJSON    struct {
		FactorioVersion string `json:"factorio_version"`
		// Only in the full form; nil means the game's default, `["base"]`.
		Dependencies *[]string `json:"dependencies"`
	} `json:"info_json"`
}

// Mod is a mod's page on the portal.
type Mod struct {
	Name           string    `json:"name"`
	Title          string    `json:"title"`
	Summary        string    `json:"summary"`
	Owner          string    `json:"owner"`
	Category       string    `json:"category"`
	DownloadsCount int       `json:"downloads_count"`
	Releases       []Release `json:"releases"`
}

// Hit is one search result.
type Hit struct {
	Name           string `json:"name"`
	Title          string `json:"title"`
	Summary        string `json:"summary"`
	Owner          string `json:"owner"`
	Category       string `json:"category"`
	DownloadsCount int    `json:"downloads_count"`
}

// SearchResult is one page of results.
type SearchResult struct {
	Hits      []Hit `json:"hits"`
	Page      int   `json:"page"`
	PageCount int   `json:"pageCount"`
}

type Options struct {
	BaseURL      string
	AllowedHosts []string
	Credentials  Credentials
	// Tests pass a client trusting their TLS server; nil builds one.
	HTTPClient *http.Client
	// How long portal answers are reused. Zero: 10 minutes.
	CacheTTL time.Duration
}

type Client struct {
	base    *url.URL
	allowed []string
	creds   Credentials
	http    *http.Client
	ttl     time.Duration
	now     func() time.Time

	mu    sync.Mutex
	cache map[string]cached
}

type cached struct {
	at    time.Time
	value any
}

// Deadline of an API call; downloads run on the caller's context.
const apiTimeout = 30 * time.Second

func New(options Options) (*Client, error) {
	base, err := url.Parse(options.BaseURL)
	if err != nil || base.Scheme != "https" || base.Host == "" {
		return nil, fmt.Errorf("portal base URL %q: must be https://host", options.BaseURL)
	}
	if !slices.Contains(options.AllowedHosts, base.Hostname()) {
		return nil, fmt.Errorf("portal base URL %q: host not in the allowed list", options.BaseURL)
	}

	httpClient := options.HTTPClient
	if httpClient == nil {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.ResponseHeaderTimeout = apiTimeout
		transport.TLSHandshakeTimeout = 10 * time.Second
		httpClient = &http.Client{Transport: transport}
	}
	// A copy, so the caller's client keeps its own redirect policy.
	client := *httpClient
	c := &Client{
		base:    base,
		allowed: slices.Clone(options.AllowedHosts),
		creds:   options.Credentials,
		http:    &client,
		ttl:     options.CacheTTL,
		now:     time.Now,
		cache:   map[string]cached{},
	}
	if c.ttl == 0 {
		c.ttl = 10 * time.Minute
	}
	client.CheckRedirect = c.checkRedirect
	return c, nil
}

// HasCredentials reports whether searching and downloading are possible.
func (c *Client) HasCredentials() bool { return c.creds.Token != "" }

func (c *Client) checkRedirect(request *http.Request, via []*http.Request) error {
	if len(via) >= 5 {
		return errors.New("too many redirects")
	}
	if request.URL.Scheme != "https" || !slices.Contains(c.allowed, request.URL.Hostname()) {
		return fmt.Errorf("redirect to %s://%s refused: not an allowed host", request.URL.Scheme, request.URL.Host)
	}
	return nil
}

// Full returns a mod's page with every release and its dependencies.
func (c *Client) Full(ctx context.Context, name string) (Mod, error) {
	if !ValidName(name) {
		return Mod{}, ErrNotFound
	}
	key := "full:" + name
	if value, ok := c.cached(key); ok {
		return value.(Mod), nil
	}
	var mod Mod
	if err := c.getJSON(ctx, "/api/mods/"+url.PathEscape(name)+"/full", nil, &mod); err != nil {
		return Mod{}, err
	}
	c.store(key, mod)
	return mod, nil
}

// Releases returns the releases of several mods in one call per 50 names,
// without dependencies. Unknown names are simply absent from the result.
func (c *Client) Releases(ctx context.Context, names []string) (map[string][]Release, error) {
	result := map[string][]Release{}
	valid := slices.DeleteFunc(slices.Clone(names), func(name string) bool { return !ValidName(name) })
	slices.Sort(valid)
	for chunk := range slices.Chunk(valid, 50) {
		key := "releases:" + strings.Join(chunk, ",")
		if value, ok := c.cached(key); ok {
			for _, mod := range value.([]Mod) {
				result[mod.Name] = mod.Releases
			}
			continue
		}
		var page struct {
			Results []Mod `json:"results"`
		}
		query := url.Values{"namelist": {strings.Join(chunk, ",")}, "page_size": {"max"}}
		if err := c.getJSON(ctx, "/api/mods", query, &page); err != nil {
			return nil, err
		}
		c.store(key, page.Results)
		for _, mod := range page.Results {
			result[mod.Name] = mod.Releases
		}
	}
	return result, nil
}

// Search runs a full-text search for mods compatible with gameVersion
// (`2.1`). The portal requires credentials for it.
func (c *Client) Search(ctx context.Context, query, gameVersion string, page int) (SearchResult, error) {
	if !c.HasCredentials() {
		return SearchResult{}, ErrNoCredentials
	}
	body, err := json.Marshal(map[string]any{
		"username":          c.creds.Username,
		"token":             c.creds.Token,
		"query":             query,
		"version":           gameVersion,
		"page":              page,
		"page_size":         20,
		"sort_attribute":    "relevancy",
		"show_deprecated":   false,
		"highlight_pre_tag": "",
		// Plain text: the panel renders these as text, never as HTML.
		"highlight_post_tag": "",
	})
	if err != nil {
		return SearchResult{}, err
	}

	ctx, cancel := context.WithTimeout(ctx, apiTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base.JoinPath("/api/search").String(), bytes.NewReader(body))
	if err != nil {
		return SearchResult{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")

	var answer struct {
		Pagination *struct {
			Page      int `json:"page"`
			PageCount int `json:"page_count"`
		} `json:"pagination"`
		Results []Hit `json:"results"`
	}
	if err := c.doJSON(request, &answer); err != nil {
		return SearchResult{}, err
	}
	result := SearchResult{Hits: answer.Results, Page: page, PageCount: 1}
	if result.Hits == nil {
		result.Hits = []Hit{}
	}
	if answer.Pagination != nil {
		result.Page, result.PageCount = answer.Pagination.Page, answer.Pagination.PageCount
	}
	return result, nil
}

// Download streams a release into w, at most maxBytes, and checks the bytes
// against the portal's SHA-1 before returning. On any error, what was written
// must be thrown away.
func (c *Client) Download(ctx context.Context, release Release, w io.Writer, maxBytes int64) (int64, error) {
	if !c.HasCredentials() {
		return 0, ErrNoCredentials
	}
	if !strings.HasPrefix(release.DownloadURL, "/download/") || strings.ContainsAny(release.DownloadURL, "?#") {
		return 0, fmt.Errorf("%w: unexpected download path", ErrUnreachable)
	}
	target := c.base.JoinPath(release.DownloadURL)
	target.RawQuery = url.Values{"username": {c.creds.Username}, "token": {c.creds.Token}}.Encode()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return 0, redact(err)
	}
	response, err := c.do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	// Any type but HTML: the download host's labels vary, the checksum is
	// what proves the content.
	if err := c.checkAnswer(response); err != nil {
		return 0, err
	}
	if response.ContentLength > maxBytes {
		return 0, ErrTooLarge
	}

	hash := sha1.New() //nolint:gosec // G401: compared to the portal's published SHA-1
	n, err := io.Copy(io.MultiWriter(w, hash), io.LimitReader(response.Body, maxBytes+1))
	if err != nil {
		return n, fmt.Errorf("%w: %w", ErrUnreachable, redact(err))
	}
	if n > maxBytes {
		return n, ErrTooLarge
	}
	if !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), release.SHA1) {
		return n, ErrChecksum
	}
	return n, nil
}

func (c *Client) getJSON(ctx context.Context, path string, query url.Values, into any) error {
	ctx, cancel := context.WithTimeout(ctx, apiTimeout)
	defer cancel()
	target := c.base.JoinPath(path)
	target.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	return c.doJSON(request, into)
}

// Answers are small; anything larger than this is not the portal's API.
const maxAnswerBytes = 16 << 20

func (c *Client) doJSON(request *http.Request, into any) error {
	response, err := c.do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if err := c.checkAnswer(response, "application/json"); err != nil {
		return err
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxAnswerBytes))
	if err != nil {
		return fmt.Errorf("%w: %w", ErrUnreachable, redact(err))
	}
	if err := json.Unmarshal(raw, into); err != nil {
		return fmt.Errorf("%w: malformed answer: %w", ErrUnreachable, err)
	}
	return nil
}

func (c *Client) do(request *http.Request) (*http.Response, error) {
	request.Header.Set("User-Agent", "factorio-admin-rcon data-agent")
	response, err := c.http.Do(request) //nolint:gosec // G704: built from the fixed base URL, redirects checked
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrUnreachable, redact(err))
	}
	return response, nil
}

// checkAnswer sorts a response into success or one of the package's errors.
// A request without valid credentials is redirected to the login page, which
// answers 200 with HTML: caught here by where it landed and what it is.
func (c *Client) checkAnswer(response *http.Response, contentTypes ...string) error {
	landed := response.Request.URL
	if strings.HasPrefix(landed.Path, "/login") {
		return ErrRejected
	}
	switch {
	case response.StatusCode == http.StatusNotFound:
		return ErrNotFound
	case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
		return ErrRejected
	case response.StatusCode != http.StatusOK:
		return fmt.Errorf("%w: HTTP %s from %s", ErrUnreachable, strconv.Itoa(response.StatusCode), landed.Host)
	}
	mediaType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if mediaType == "text/html" {
		return ErrRejected
	}
	if len(contentTypes) > 0 && mediaType != "" && !slices.Contains(contentTypes, mediaType) {
		return fmt.Errorf("%w: unexpected content type %q", ErrUnreachable, mediaType)
	}
	return nil
}

func (c *Client) cached(key string) (any, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.cache[key]
	if !ok || c.now().Sub(entry.at) > c.ttl {
		return nil, false
	}
	return entry.value, true
}

func (c *Client) store(key string, value any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	// Bounded: an entry per mod looked at, dropped wholesale when it grows.
	if len(c.cache) > 1000 {
		clear(c.cache)
	}
	c.cache[key] = cached{at: c.now(), value: value}
}

// redact strips the query string — where the token travels — from the URL a
// *url.Error carries, so the error can be logged.
func redact(err error) error {
	var urlError *url.Error
	if errors.As(err, &urlError) {
		if parsed, parseErr := url.Parse(urlError.URL); parseErr == nil {
			parsed.RawQuery = ""
			urlError.URL = parsed.String()
		} else {
			urlError.URL = "(unparsable URL)"
		}
	}
	return err
}
