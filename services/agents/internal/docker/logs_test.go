package docker

import (
	"bytes"
	"encoding/binary"
	"strings"
	"testing"
	"unicode/utf8"
)

func frame(stream byte, payload string) []byte {
	header := make([]byte, 8)
	header[0] = stream
	binary.BigEndian.PutUint32(header[4:], uint32(len(payload)))
	return append(header, payload...)
}

func TestDemultiplex(t *testing.T) {
	var stream bytes.Buffer
	// One line split over two frames, two lines in one frame, interleaved
	// stderr, and a last line without a terminator.
	stream.Write(frame(1, "Loading mod "))
	stream.Write(frame(2, "oops\n"))
	stream.Write(frame(1, "base\r\nSaving finished\nlast"))

	lines, err := Demultiplex(&stream)
	if err != nil {
		t.Fatal(err)
	}

	want := []Line{
		{Stream: "stderr", Text: "oops"},
		{Stream: "stdout", Text: "Loading mod base"},
		{Stream: "stdout", Text: "Saving finished"},
		{Stream: "stdout", Text: "last"},
	}
	if len(lines) != len(want) {
		t.Fatalf("got %+v", lines)
	}
	for i := range want {
		if lines[i] != want[i] {
			t.Errorf("line %d: got %+v, want %+v", i, lines[i], want[i])
		}
	}
}

func TestDemultiplexTruncatedStream(t *testing.T) {
	full := frame(1, "complete\n")
	partial := frame(1, "this frame is cut short\n")[:12]

	// The size limit can cut a frame anywhere: what did arrive is kept.
	lines, err := Demultiplex(bytes.NewReader(append(full, partial...)))
	if err != nil || len(lines) != 2 || lines[0].Text != "complete" || lines[1].Text != "this" {
		t.Fatalf("got %+v, %v", lines, err)
	}
}

func TestCleanBoundsAndSanitises(t *testing.T) {
	long := clean([]byte(strings.Repeat("x", MaxLogLineBytes+100) + "\n"))
	if len(long) != MaxLogLineBytes {
		t.Errorf("length %d", len(long))
	}

	if text := clean([]byte("bad \xff byte")); !utf8.ValidString(text) {
		t.Errorf("invalid UTF-8 kept: %q", text)
	}
}
