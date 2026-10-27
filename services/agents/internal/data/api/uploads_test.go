package api_test

import (
	"encoding/json/v2"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/fakesave"
	"github.com/EdwinAlkins/factorio-admin-rcon/services/agents/internal/saves"
)

func TestUploadLifecycle(t *testing.T) {
	h := newHarness(t)
	save := string(fakesave.Valid(t, "my-map", "x"))

	r := h.call(t, "GET", "/v1/saves", "", true)
	if r.status != http.StatusOK || !strings.Contains(string(r.body), `"maxUploadBytes":1048576`) {
		t.Fatalf("saves: %d %s", r.status, r.body)
	}

	r = h.call(t, "POST", "/v1/uploads", `{"size":`+strconv.Itoa(len(save))+`,"name":"my-map.zip"}`, true)
	if r.status != http.StatusCreated {
		t.Fatalf("begin: %d %s", r.status, r.body)
	}
	var begun struct {
		Upload     saves.UploadState `json:"upload"`
		ChunkBytes int               `json:"chunkBytes"`
	}
	if err := json.Unmarshal(r.body, &begun); err != nil || begun.ChunkBytes != saves.ChunkBytes {
		t.Fatalf("begin body %s: %v", r.body, err)
	}
	path := "/v1/uploads/" + begun.Upload.ID

	half := len(save) / 2
	if r := h.call(t, "PUT", path+"?offset=0", save[:half], true); r.status != http.StatusOK {
		t.Fatalf("chunk 1: %d %s", r.status, r.body)
	}
	if r := h.call(t, "PUT", path+"?offset=0", save[:half], true); r.status != http.StatusConflict || code(t, r) != "upload_offset" {
		t.Fatalf("resent chunk: %d %s", r.status, r.body)
	}
	if r := h.call(t, "GET", path, "", true); !strings.Contains(string(r.body), `"offset":`+strconv.Itoa(half)) {
		t.Fatalf("offset: %s", r.body)
	}
	if r := h.call(t, "PUT", path+"?offset="+strconv.Itoa(half), save[half:], true); r.status != http.StatusOK {
		t.Fatalf("chunk 2: %d %s", r.status, r.body)
	}

	r = h.call(t, "POST", path+"/complete", `{"label":"laptop","createdBy":"admin"}`, true)
	if r.status != http.StatusCreated || !strings.Contains(string(r.body), `"source":"upload"`) {
		t.Fatalf("complete: %d %s", r.status, r.body)
	}
	if r := h.call(t, "GET", path, "", true); r.status != http.StatusNotFound || code(t, r) != "upload_not_found" {
		t.Fatalf("after complete: %d %s", r.status, r.body)
	}
}

func TestUploadRefusals(t *testing.T) {
	h := newHarness(t)

	for _, body := range []string{`{}`, `{"size":-1}`, `{"size":10,"name":"a\nb"}`, `{"size":10,"path":"/etc"}`} {
		if r := h.call(t, "POST", "/v1/uploads", body, true); r.status != http.StatusBadRequest {
			t.Errorf("begin %s: %d", body, r.status)
		}
	}
	if r := h.call(t, "POST", "/v1/uploads", `{"size":2000000}`, true); r.status != http.StatusRequestEntityTooLarge || code(t, r) != "upload_too_large" {
		t.Errorf("too large: %d %s", r.status, r.body)
	}
	// Only the upload routes publish an upload archive.
	if r := h.call(t, "POST", "/v1/backups", `{"source":"upload"}`, true); r.status != http.StatusBadRequest {
		t.Errorf("create upload: %d", r.status)
	}

	r := h.call(t, "POST", "/v1/uploads", `{"size":4}`, true)
	var begun struct {
		Upload saves.UploadState `json:"upload"`
	}
	_ = json.Unmarshal(r.body, &begun)
	path := "/v1/uploads/" + begun.Upload.ID

	if r := h.call(t, "POST", "/v1/uploads", `{"size":4}`, true); r.status != http.StatusConflict || code(t, r) != "upload_busy" {
		t.Errorf("second upload: %d %s", r.status, r.body)
	}
	for _, query := range []string{"", "?offset=-1", "?offset=x"} {
		if r := h.call(t, "PUT", path+query, "abcd", true); r.status != http.StatusBadRequest {
			t.Errorf("offset %q: %d", query, r.status)
		}
	}
	if r := h.call(t, "PUT", path+"?offset=0", "abcde", true); r.status != http.StatusRequestEntityTooLarge {
		t.Errorf("past the size: %d %s", r.status, r.body)
	}
	if r := h.call(t, "PUT", "/v1/uploads/../../x?offset=0", "abcd", true); r.status < 400 || r.status >= 500 {
		t.Errorf("traversal: %d", r.status)
	}
	if r := h.call(t, "PUT", path+"?offset=0", "abcd", true); r.status != http.StatusOK {
		t.Fatalf("chunk: %d %s", r.status, r.body)
	}
	if r := h.call(t, "POST", path+"/complete", "", true); r.status != http.StatusUnprocessableEntity || code(t, r) != "invalid_archive" {
		t.Errorf("not a save: %d %s", r.status, r.body)
	}

	r = h.call(t, "POST", "/v1/uploads", `{"size":4}`, true)
	_ = json.Unmarshal(r.body, &begun)
	if r := h.call(t, "DELETE", "/v1/uploads/"+begun.Upload.ID, "", true); r.status != http.StatusOK {
		t.Errorf("abort: %d %s", r.status, r.body)
	}
	if r := h.call(t, "DELETE", "/v1/uploads/"+begun.Upload.ID, "", true); r.status != http.StatusNotFound {
		t.Errorf("abort twice: %d", r.status)
	}
}
