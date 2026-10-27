package docker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Line is one line of container output.
type Line struct {
	Stream string `json:"stream"`
	Text   string `json:"text"`
}

// Bounds on what one logs request may pull through the agent. Factorio is
// chatty at startup (one line per mod and prototype), but a thousand lines of
// a few hundred bytes each is far below these.
const (
	MaxLogBytes     = 2 << 20
	MaxLogLineBytes = 4096
)

// LogsOptions selects the lines to return.
type LogsOptions struct {
	Tail int
	// Unix seconds; zero means "from the beginning of the tail".
	Since int64
	// Whether the container has a TTY: its output is then raw, not
	// multiplexed, and has no stderr.
	Tty bool
}

// Logs returns the last `Tail` lines of the container's output.
func (c *Client) Logs(ctx context.Context, id string, options LogsOptions) ([]Line, error) {
	query := url.Values{
		"stdout": {"1"},
		"stderr": {"1"},
		"tail":   {strconv.Itoa(options.Tail)},
	}
	if options.Since > 0 {
		query.Set("since", strconv.FormatInt(options.Since, 10))
	}

	response, err := c.do(ctx, http.MethodGet, "/containers/"+url.PathEscape(id)+"/logs", query)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return nil, failure(response)
	}

	body := io.LimitReader(response.Body, MaxLogBytes)
	if options.Tty {
		return splitLines(body, "stdout")
	}
	return Demultiplex(body)
}

// Demultiplex decodes Docker's stream format for containers without a TTY:
// each frame is an 8-byte header (stream type, three zero bytes, big-endian
// payload size) followed by the payload. A frame may hold several lines, or
// part of one, so lines are reassembled per stream.
func Demultiplex(r io.Reader) ([]Line, error) {
	var (
		lines   []Line
		header  [8]byte
		pending = map[string]*bytes.Buffer{}
	)

	flush := func(stream string, final bool) {
		buffer := pending[stream]
		if buffer == nil {
			return
		}
		for {
			index := bytes.IndexByte(buffer.Bytes(), '\n')
			if index < 0 {
				break
			}
			lines = append(lines, Line{Stream: stream, Text: clean(buffer.Next(index + 1))})
		}
		if final && buffer.Len() > 0 {
			lines = append(lines, Line{Stream: stream, Text: clean(buffer.Bytes())})
			buffer.Reset()
		}
	}

	for {
		if _, err := io.ReadFull(r, header[:]); err != nil {
			// A clean end, or a stream truncated by the size limit: either
			// way, what was read so far is returned.
			break
		}

		stream := "stdout"
		if header[0] == 2 {
			stream = "stderr"
		}
		size := int64(binary.BigEndian.Uint32(header[4:]))

		buffer := pending[stream]
		if buffer == nil {
			buffer = &bytes.Buffer{}
			pending[stream] = buffer
		}
		if _, err := io.CopyN(buffer, r, size); err != nil {
			break
		}
		flush(stream, false)
	}

	flush("stdout", true)
	flush("stderr", true)
	return lines, nil
}

func splitLines(r io.Reader, stream string) ([]Line, error) {
	var lines []Line
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), MaxLogBytes)
	for scanner.Scan() {
		lines = append(lines, Line{Stream: stream, Text: clean(scanner.Bytes())})
	}
	return lines, scanner.Err()
}

// clean drops the line terminator, bounds the length and replaces invalid
// UTF-8, so a line is always safe to put in JSON and display.
func clean(raw []byte) string {
	raw = bytes.TrimRight(raw, "\r\n")
	if len(raw) > MaxLogLineBytes {
		raw = raw[:MaxLogLineBytes]
	}
	return strings.ToValidUTF8(string(raw), string(utf8.RuneError))
}
