package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/Sumitrcs/upwatch"
)

func TestCheckOnce(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/broken" {
			w.WriteHeader(http.StatusBadGateway)
		}
	}))
	defer srv.Close()
	cfg := &upwatch.Config{Checks: []upwatch.Check{{Name: "home", URL: srv.URL + "/"}, {Name: "api", URL: srv.URL + "/broken"}}}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	out, code := capture(t, func() int { return checkOnce(cfg) })
	if code != 1 {
		t.Errorf("exit code %d, want 1 (something is down)", code)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 2 || !strings.HasPrefix(lines[0], "UP    home") || !strings.HasPrefix(lines[1], "DOWN  api") ||
		!strings.HasSuffix(lines[1], "got status 502 Bad Gateway") {
		t.Errorf("output:\n%s", out)
	}
	cfg.Checks = cfg.Checks[:1]
	if _, code := capture(t, func() int { return checkOnce(cfg) }); code != 0 {
		t.Errorf("exit code %d, want 0", code)
	}
}

func capture(t *testing.T, f func() int) (string, int) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout := os.Stdout
	os.Stdout = w
	code := f()
	os.Stdout = stdout
	w.Close()
	b, _ := io.ReadAll(r)
	return string(b), code
}
