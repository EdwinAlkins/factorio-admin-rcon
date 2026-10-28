// Package serversettings reads and edits Factorio's server-settings.json.
//
// The file is the operator's as much as the panel's: it carries the
// `_comment_*` notes of the example file, keys of newer Factorio versions,
// and whatever was added by hand. An edit rewrites only the keys it names,
// in place, and keeps every other member as it was, in its order.
//
// Three keys are secrets — the factorio.com password and token, and the game
// password. They are never returned, only reported as set or not, and can
// only be replaced or cleared.
package serversettings

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/files"
)

var (
	// ErrMissing: the server has not created its settings yet (never started).
	ErrMissing = errors.New("server-settings.json does not exist")
	// ErrUnreadable: the file is not a JSON object; it is left alone.
	ErrUnreadable = errors.New("server-settings.json is not a JSON object")
	// ErrChanged: the file changed since the caller read it.
	ErrChanged    = errors.New("server-settings.json changed since it was read")
	ErrTxNotFound = errors.New("no such settings change")
	// ErrPublicCredentials: a public game needs a factorio.com account.
	ErrPublicCredentials = errors.New("a public game needs username and token or password")
	ErrNothingToDo       = errors.New("no setting to change")
)

// InvalidError names the setting a change was refused for.
type InvalidError struct{ Key string }

func (e *InvalidError) Error() string { return fmt.Sprintf("setting %q: invalid or unknown", e.Key) }

const fileName = "server-settings.json"

// The example file weighs 5 kB; anything near this bound is not one.
const maxFileBytes = 1 << 20

// Previous versions kept, for rolling back a change the server did not start with.
const keepHistory = 5

var txPattern = regexp.MustCompile(`^[0-9]{8}-[0-9]{6}(-[0-9]{1,3})?$`)

type kind int

const (
	kindText kind = iota
	// Like text, line breaks allowed.
	kindLongText
	kindTags
	kindInt
	kindBool
	kindVisibility
	kindAllowCommands
)

type field struct {
	kind     kind
	min, max int64
}

// The keys the panel may change, as Factorio 2.0 documents them.
var fields = map[string]field{
	"name":                               {kind: kindText, max: 100},
	"description":                        {kind: kindLongText, max: 5000},
	"tags":                               {kind: kindTags},
	"max_players":                        {kind: kindInt, max: 65535},
	"visibility":                         {kind: kindVisibility},
	"username":                           {kind: kindText, max: 100},
	"require_user_verification":          {kind: kindBool},
	"max_upload_in_kilobytes_per_second": {kind: kindInt, max: 10_000_000},
	"max_upload_slots":                   {kind: kindInt, max: 1000},
	"minimum_latency_in_ticks":           {kind: kindInt, max: 1000},
	"max_heartbeats_per_second":          {kind: kindInt, min: 6, max: 240},
	"ignore_player_limit_for_returning_players": {kind: kindBool},
	"allow_commands":                  {kind: kindAllowCommands},
	"autosave_interval":               {kind: kindInt, min: 1, max: 1440},
	"autosave_slots":                  {kind: kindInt, min: 1, max: 1000},
	"afk_autokick_interval":           {kind: kindInt, max: 1440},
	"auto_pause":                      {kind: kindBool},
	"auto_pause_when_players_connect": {kind: kindBool},
	"only_admins_can_pause_the_game":  {kind: kindBool},
	"autosave_only_on_server":         {kind: kindBool},
	"non_blocking_saving":             {kind: kindBool},
	"minimum_segment_size":            {kind: kindInt, min: 1, max: 10_000},
	"minimum_segment_size_peer_count": {kind: kindInt, min: 1, max: 10_000},
	"maximum_segment_size":            {kind: kindInt, min: 1, max: 10_000},
	"maximum_segment_size_peer_count": {kind: kindInt, min: 1, max: 10_000},
}

// Secrets are written, never read back.
var secrets = []string{"password", "token", "game_password"}

const maxSecret = 200

// View is the file as the panel sees it: the editable keys present in it,
// and whether each secret is set.
type View struct {
	Settings map[string]jsontext.Value `json:"settings"`
	Secrets  map[string]bool           `json:"secrets"`
	// SHA-256 of the file: an update names the version it was made from.
	Hash string `json:"hash"`
}

// SecretChange replaces a secret (`set`) or empties it (`clear`).
type SecretChange struct {
	Set   *string `json:"set,omitzero"`
	Clear bool    `json:"clear,omitzero"`
}

// Patch is a change: new values for some editable keys, and secrets.
type Patch struct {
	Settings map[string]jsontext.Value `json:"settings"`
	Secrets  map[string]SecretChange   `json:"secrets"`
}

type Store struct {
	config  *os.Root
	history *os.Root
	now     func() time.Time
	mu      sync.Mutex
}

// New edits server-settings.json in `config`, keeping previous versions in
// `history`.
func New(config, history *os.Root) *Store {
	return &Store{config: config, history: history, now: time.Now}
}

// Read returns the current settings.
func (s *Store) Read() (View, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, _, err := s.read()
	if err != nil {
		return View{}, err
	}
	doc, err := parseObject(raw)
	if err != nil {
		return View{}, err
	}
	return view(doc, raw), nil
}

// Update applies a patch made from the version `hash`, and returns the id
// under which the previous version is kept (see Rollback) with the new view.
func (s *Store) Update(patch Patch, hash string) (string, View, error) {
	if len(patch.Settings) == 0 && len(patch.Secrets) == 0 {
		return "", View{}, ErrNothingToDo
	}
	if err := validate(patch); err != nil {
		return "", View{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	raw, perm, err := s.read()
	if err != nil {
		return "", View{}, err
	}
	if digest(raw) != hash {
		return "", View{}, ErrChanged
	}
	doc, err := parseObject(raw)
	if err != nil {
		return "", View{}, err
	}

	// Sorted: the same patch always produces the same file.
	for _, key := range sortedKeys(patch.Settings) {
		value := patch.Settings[key]
		if key == "visibility" {
			if value, err = mergeVisibility(doc.get(key), value); err != nil {
				return "", View{}, err
			}
		}
		doc.set(key, value)
	}
	for _, key := range sortedKeys(patch.Secrets) {
		change := patch.Secrets[key]
		value := ""
		if change.Set != nil {
			value = *change.Set
		}
		encoded, _ := jsontext.AppendQuote(nil, value)
		doc.set(key, encoded)
	}
	if err := checkPublic(doc); err != nil {
		return "", View{}, err
	}

	updated, err := doc.marshal()
	if err != nil {
		return "", View{}, err
	}
	tx, err := s.newTx()
	if err != nil {
		return "", View{}, err
	}
	if err := files.WriteAtomic(s.history, tx+".json", raw, 0o640); err != nil {
		return "", View{}, err
	}
	if err := files.WriteAtomic(s.config, fileName, updated, perm); err != nil {
		_ = s.history.Remove(tx + ".json")
		return "", View{}, err
	}
	s.pruneHistory()
	return tx, view(doc, updated), nil
}

// Rollback puts back the version an Update replaced.
func (s *Store) Rollback(tx string) error {
	if !txPattern.MatchString(tx) {
		return ErrTxNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	previous, err := s.history.ReadFile(tx + ".json")
	if errors.Is(err, fs.ErrNotExist) {
		return ErrTxNotFound
	}
	if err != nil {
		return err
	}
	perm := fs.FileMode(0o640)
	if info, err := s.config.Stat(fileName); err == nil {
		perm = info.Mode().Perm()
	}
	return files.WriteAtomic(s.config, fileName, previous, perm)
}

func (s *Store) read() ([]byte, fs.FileMode, error) {
	f, err := s.config.Open(fileName)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, 0, ErrMissing
	}
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, 0, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxFileBytes {
		return nil, 0, ErrUnreadable
	}
	raw, err := io.ReadAll(io.LimitReader(f, maxFileBytes+1))
	if err != nil {
		return nil, 0, err
	}
	return raw, info.Mode().Perm(), nil
}

// newID builds a fresh history id, suffixed when two changes land in the
// same second.
func (s *Store) newTx() (string, error) {
	base := s.now().UTC().Format("20060102-150405")
	for n := 1; n < 1000; n++ {
		tx := base
		if n > 1 {
			tx += "-" + strconv.Itoa(n)
		}
		if _, err := s.history.Stat(tx + ".json"); files.IsNotExist(err) {
			return tx, nil
		}
	}
	return "", errors.New("too many changes in the same second")
}

func (s *Store) pruneHistory() {
	entries, err := fs.ReadDir(s.history.FS(), ".")
	if err != nil {
		return
	}
	var kept []string
	for _, entry := range entries {
		if tx, ok := strings.CutSuffix(entry.Name(), ".json"); ok && txPattern.MatchString(tx) {
			kept = append(kept, entry.Name())
		}
	}
	// Names embed the time: lexical order is chronological.
	sort.Sort(sort.Reverse(sort.StringSlice(kept)))
	for _, name := range kept[min(len(kept), keepHistory):] {
		_ = s.history.Remove(name)
	}
}

func view(doc object, raw []byte) View {
	v := View{Settings: map[string]jsontext.Value{}, Secrets: map[string]bool{}, Hash: digest(raw)}
	for _, m := range doc {
		if _, editable := fields[m.name]; editable {
			v.Settings[m.name] = m.value
		}
	}
	for _, key := range secrets {
		var value string
		if raw := doc.get(key); raw != nil && json.Unmarshal(raw, &value) == nil {
			v.Secrets[key] = value != ""
		} else {
			v.Secrets[key] = false
		}
	}
	return v
}

func digest(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}

// --- Validation -------------------------------------------------------------

func validate(patch Patch) error {
	for key, value := range patch.Settings {
		f, known := fields[key]
		if !known || !valid(f, value) {
			return &InvalidError{Key: key}
		}
	}
	for key, change := range patch.Secrets {
		ok := slices.Contains(secrets, key) && (change.Set != nil) != change.Clear
		if ok && change.Set != nil {
			ok = len(*change.Set) > 0 && len(*change.Set) <= maxSecret && printable(*change.Set, false)
		}
		if !ok {
			return &InvalidError{Key: key}
		}
	}
	return nil
}

func valid(f field, raw jsontext.Value) bool {
	strict := json.RejectUnknownMembers(true)
	switch f.kind {
	case kindText, kindLongText:
		var text string
		return json.Unmarshal(raw, &text) == nil && int64(len(text)) <= f.max && printable(text, f.kind == kindLongText)
	case kindTags:
		var tags []string
		if json.Unmarshal(raw, &tags) != nil || tags == nil || len(tags) > 20 {
			return false
		}
		for _, tag := range tags {
			if tag == "" || len(tag) > 50 || !printable(tag, false) {
				return false
			}
		}
		return true
	case kindInt:
		var n int64
		return json.Unmarshal(raw, &n) == nil && n >= f.min && n <= f.max
	case kindBool:
		var b bool
		return json.Unmarshal(raw, &b) == nil
	case kindVisibility:
		var v struct {
			Public *bool `json:"public"`
			LAN    *bool `json:"lan"`
		}
		return json.Unmarshal(raw, &v, strict) == nil && (v.Public != nil || v.LAN != nil)
	case kindAllowCommands:
		var mode string
		return json.Unmarshal(raw, &mode) == nil && slices.Contains([]string{"true", "false", "admins-only"}, mode)
	}
	return false
}

// printable keeps control characters out of the file, line breaks aside
// where a multi-line text is expected.
func printable(text string, lines bool) bool {
	return !strings.ContainsFunc(text, func(r rune) bool {
		if lines && r == '\n' {
			return false
		}
		return r < 0x20 || r == 0x7f
	})
}

// mergeVisibility changes the members a patch names, keeping the others.
func mergeVisibility(current, patch jsontext.Value) (jsontext.Value, error) {
	base := object{}
	if current != nil {
		parsed, err := parseObject(current)
		if err != nil {
			return nil, &InvalidError{Key: "visibility"}
		}
		base = parsed
	}
	changes, err := parseObject(patch)
	if err != nil {
		return nil, &InvalidError{Key: "visibility"}
	}
	for _, m := range changes {
		base.set(m.name, m.value)
	}
	return base.marshal()
}

func checkPublic(doc object) error {
	var visibility struct {
		Public bool `json:"public"`
	}
	if raw := doc.get("visibility"); raw == nil || json.Unmarshal(raw, &visibility) != nil || !visibility.Public {
		return nil
	}
	text := func(key string) string {
		var value string
		if raw := doc.get(key); raw != nil {
			_ = json.Unmarshal(raw, &value)
		}
		return value
	}
	if text("username") == "" || (text("token") == "" && text("password") == "") {
		return ErrPublicCredentials
	}
	return nil
}

// --- Ordered JSON -----------------------------------------------------------

type member struct {
	name  string
	value jsontext.Value
}

// object is a JSON object that keeps its members' order.
type object []member

func parseObject(raw []byte) (object, error) {
	dec := jsontext.NewDecoder(bytes.NewReader(raw))
	if token, err := dec.ReadToken(); err != nil || token.Kind() != '{' {
		return nil, ErrUnreadable
	}
	doc := object{}
	for dec.PeekKind() != '}' {
		token, err := dec.ReadToken()
		if err != nil {
			return nil, ErrUnreadable
		}
		// Read before the next call voids the token.
		name := token.String()
		value, err := dec.ReadValue()
		if err != nil {
			return nil, ErrUnreadable
		}
		doc = append(doc, member{name: name, value: value.Clone()})
	}
	if _, err := dec.ReadToken(); err != nil {
		return nil, ErrUnreadable
	}
	if _, err := dec.ReadToken(); err != io.EOF {
		return nil, ErrUnreadable
	}
	return doc, nil
}

func (o object) get(name string) jsontext.Value {
	for _, m := range o {
		if m.name == name {
			return m.value
		}
	}
	return nil
}

// set replaces a member in place, or appends it.
func (o *object) set(name string, value jsontext.Value) {
	for i := range *o {
		if (*o)[i].name == name {
			(*o)[i].value = value
			return
		}
	}
	*o = append(*o, member{name: name, value: value})
}

func (o object) marshal() ([]byte, error) {
	var buffer bytes.Buffer
	enc := jsontext.NewEncoder(&buffer, jsontext.WithIndent("  "))
	if err := enc.WriteToken(jsontext.BeginObject); err != nil {
		return nil, err
	}
	for _, m := range o {
		if err := enc.WriteToken(jsontext.String(m.name)); err != nil {
			return nil, err
		}
		if err := enc.WriteValue(m.value); err != nil {
			return nil, err
		}
	}
	if err := enc.WriteToken(jsontext.EndObject); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}
