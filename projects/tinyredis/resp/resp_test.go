package resp

import (
	"bytes"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
)

func TestReadArrayAndInlineCommands(t *testing.T) {
	in := "*3\r\n$3\r\nSET\r\n$4\r\nname\r\n$12\r\nhello\r\nworld\r\n" + // binary-safe value with CRLF inside
		"PING\r\n" +
		"\r\n" + // blank line ignored
		"  get   name \n" // inline, extra spaces, bare LF
	r := NewReader(strings.NewReader(in))
	want := [][]string{{"SET", "name", "hello\r\nworld"}, {"PING"}, {"get", "name"}}
	for _, w := range want {
		got, err := r.ReadCommand()
		if err != nil || !reflect.DeepEqual(got, w) {
			t.Fatalf("got %q, %v; want %q", got, err, w)
		}
	}
	if _, err := r.ReadCommand(); !errors.Is(err, io.EOF) {
		t.Fatalf("want EOF, got %v", err)
	}
}

func TestProtocolErrors(t *testing.T) {
	for _, in := range []string{"*x\r\n", "*1\r\n:5\r\n", "*1\r\n$-5\r\n", "*1\r\n$3\r\nabcde"} {
		_, err := NewReader(strings.NewReader(in)).ReadCommand()
		if err == nil {
			t.Errorf("%q: expected an error", in)
		}
	}
}

func TestWriterAndEncodeRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)
	w.Simple("OK")
	w.Error("ERR bad")
	w.Int(-7)
	w.Bulk("")
	w.Null()
	w.Array([]string{"a", "bc"})
	w.Flush()
	want := "+OK\r\n-ERR bad\r\n:-7\r\n$0\r\n\r\n$-1\r\n*2\r\n$1\r\na\r\n$2\r\nbc\r\n"
	if buf.String() != want {
		t.Fatalf("got %q", buf.String())
	}
	args := []string{"LPUSH", "list", "x y", ""}
	got, err := NewReader(bytes.NewReader(EncodeCommand(args))).ReadCommand()
	if err != nil || !reflect.DeepEqual(got, args) {
		t.Fatalf("round trip: %q %v", got, err)
	}
}
