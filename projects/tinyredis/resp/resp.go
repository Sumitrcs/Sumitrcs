// Package resp reads and writes RESP2, the Redis wire protocol.
//
// Every value starts with a one-byte type marker and ends with \r\n:
//
//	+OK\r\n                      simple string
//	-ERR something\r\n           error
//	:42\r\n                      integer
//	$5\r\nhello\r\n              bulk string (length-prefixed, binary safe)
//	$-1\r\n                      null bulk string
//	*2\r\n$3\r\nGET\r\n$1\r\nk\r\n  array (clients send commands this way)
//
// Clients may also send "inline" commands — plain text like `PING` — which
// is what you get when you talk to the server with telnet or nc.
package resp

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

const (
	maxBulkLen  = 512 << 20 // Redis' own limit for a single string
	maxArrayLen = 1 << 20
)

var ErrProtocol = errors.New("protocol error")

// Reader parses client commands from a buffered connection.
type Reader struct{ r *bufio.Reader }

func NewReader(r io.Reader) *Reader { return &Reader{bufio.NewReader(r)} }

// ReadCommand returns one command as its arguments, e.g. ["SET", "k", "v"].
func (r *Reader) ReadCommand() ([]string, error) {
	line, err := r.line()
	if err != nil {
		return nil, err
	}
	if len(line) == 0 {
		return r.ReadCommand() // ignore blank lines from telnet users
	}
	if line[0] != '*' {
		return strings.Fields(line), nil // inline command
	}
	n, err := strconv.Atoi(line[1:])
	if err != nil || n < 0 || n > maxArrayLen {
		return nil, fmt.Errorf("%w: invalid multibulk length", ErrProtocol)
	}
	args := make([]string, 0, n)
	for i := 0; i < n; i++ {
		s, err := r.bulk()
		if err != nil {
			return nil, err
		}
		args = append(args, s)
	}
	return args, nil
}

func (r *Reader) bulk() (string, error) {
	line, err := r.line()
	if err != nil {
		return "", err
	}
	if len(line) == 0 || line[0] != '$' {
		return "", fmt.Errorf("%w: expected '$', got %q", ErrProtocol, line)
	}
	n, err := strconv.Atoi(line[1:])
	if err != nil || n < 0 || n > maxBulkLen {
		return "", fmt.Errorf("%w: invalid bulk length", ErrProtocol)
	}
	buf := make([]byte, n+2)
	if _, err := io.ReadFull(r.r, buf); err != nil {
		return "", err
	}
	if buf[n] != '\r' || buf[n+1] != '\n' {
		return "", fmt.Errorf("%w: bulk string not terminated by CRLF", ErrProtocol)
	}
	return string(buf[:n]), nil
}

func (r *Reader) line() (string, error) {
	s, err := r.r.ReadString('\n')
	if err != nil {
		return "", err
	}
	return strings.TrimRight(s, "\r\n"), nil
}

// Buffered reports whether more input is already waiting — used to batch
// replies to pipelined commands into a single write.
func (r *Reader) Buffered() int { return r.r.Buffered() }

// Writer encodes replies.
type Writer struct{ w *bufio.Writer }

func NewWriter(w io.Writer) *Writer { return &Writer{bufio.NewWriter(w)} }

func (w *Writer) Simple(s string) { w.w.WriteString("+" + s + "\r\n") }
func (w *Writer) Error(s string)  { w.w.WriteString("-" + s + "\r\n") }
func (w *Writer) Int(n int64)     { w.w.WriteString(":" + strconv.FormatInt(n, 10) + "\r\n") }
func (w *Writer) Null()           { w.w.WriteString("$-1\r\n") }
func (w *Writer) NullArray()      { w.w.WriteString("*-1\r\n") }

func (w *Writer) Bulk(s string) {
	w.w.WriteString("$" + strconv.Itoa(len(s)) + "\r\n" + s + "\r\n")
}

func (w *Writer) Array(items []string) {
	w.w.WriteString("*" + strconv.Itoa(len(items)) + "\r\n")
	for _, s := range items {
		w.Bulk(s)
	}
}

func (w *Writer) Flush() error { return w.w.Flush() }

// EncodeCommand encodes args as a RESP array — the format used by clients
// and by the append-only file.
func EncodeCommand(args []string) []byte {
	var b strings.Builder
	b.WriteString("*" + strconv.Itoa(len(args)) + "\r\n")
	for _, a := range args {
		b.WriteString("$" + strconv.Itoa(len(a)) + "\r\n" + a + "\r\n")
	}
	return []byte(b.String())
}
