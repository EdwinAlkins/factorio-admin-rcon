// Package fakesave builds Factorio-shaped archives for tests: valid saves,
// and the broken ones the data agent must refuse.
package fakesave

import (
	"archive/zip"
	"bytes"
	"testing"
)

// Valid returns a minimal save named `name` with its level data.
func Valid(t *testing.T, name string, payload string) []byte {
	t.Helper()
	return Build(t, map[string]string{
		name + "/level-init.dat": "init " + payload,
		name + "/level.dat0":     "level " + payload,
		name + "/control.lua":    "-- " + payload,
	})
}

// Build zips arbitrary entries.
func Build(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for name, content := range entries {
		w, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

// CorruptCRC flips a byte inside the first stored entry's data, keeping the
// archive structurally readable: only the checksum can catch it.
func CorruptCRC(t *testing.T, name string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	header := &zip.FileHeader{Name: name + "/level.dat0", Method: zip.Store}
	w, err := writer.CreateHeader(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("PAYLOAD-PAYLOAD-PAYLOAD")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	raw := buffer.Bytes()
	i := bytes.Index(raw, []byte("PAYLOAD"))
	raw[i] = 'X'
	return raw
}
