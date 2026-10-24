package upwatch

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var t0 = time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)

func check(name, url string) Check {
	c := Check{Name: name, URL: url}
	cfg := Config{Checks: []Check{c}}
	if err := cfg.Validate(); err != nil {
		panic(err)
	}
	return cfg.Checks[0]
}

func ok(at time.Time, latency time.Duration) Result {
	return Result{Time: at, OK: true, Status: 200, Latency: latency}
}

func fail(at time.Time, why string) Result { return Result{Time: at, Error: why} }

// ---- probing ------------------------------------------------------------

func TestProbe(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ok":
			fmt.Fprint(w, "<h1>Welcome to the shop</h1>")
		case "/error-page":
			fmt.Fprint(w, "<h1>Database connection failed</h1>") // 200, but broken
		case "/missing":
			http.NotFound(w, r)
		case "/created":
			w.WriteHeader(http.StatusCreated)
		case "/slow":
			time.Sleep(300 * time.Millisecond)
		case "/redirect":
			http.Redirect(w, r, "/ok", http.StatusFound)
		case "/loop":
			http.Redirect(w, r, "/loop", http.StatusFound)
		}
	}))
	defer srv.Close()
	client := NewMonitor(nil).Client

	cases := []struct {
		name   string
		modify func(*Check)
		path   string
		ok     bool
		err    string
	}{
		{"plain 200", nil, "/ok", true, ""},
		{"expected text found", func(c *Check) { c.ExpectText = "Welcome" }, "/ok", true, ""},
		{"expected text missing", func(c *Check) { c.ExpectText = "Welcome" }, "/error-page", false, `doesn't contain "Welcome"`},
		{"404", nil, "/missing", false, "got status 404 Not Found"},
		{"exact status", func(c *Check) { c.ExpectStatus = 201 }, "/created", true, ""},
		{"wrong exact status", func(c *Check) { c.ExpectStatus = 201 }, "/ok", false, "got status 200, expected 201"},
		{"timeout", func(c *Check) { c.Timeout = Duration(50 * time.Millisecond) }, "/slow", false, "no answer within 50ms"},
		{"redirect followed", func(c *Check) { c.ExpectText = "Welcome" }, "/redirect", true, ""},
		{"redirect loop stops", nil, "/loop", true, ""}, // the last 302 is an answer, not an error
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := check("x", srv.URL+tc.path)
			if tc.modify != nil {
				tc.modify(&c)
			}
			r := Probe(context.Background(), client, c)
			if r.OK != tc.ok || !strings.Contains(r.Error, tc.err) {
				t.Fatalf("got ok=%v err=%q, want ok=%v err containing %q", r.OK, r.Error, tc.ok, tc.err)
			}
			if r.Latency <= 0 || r.Time.IsZero() {
				t.Errorf("latency %v, time %v should be set", r.Latency, r.Time)
			}
		})
	}
}

func TestProbeConnectionErrors(t *testing.T) {
	// A port nobody listens on.
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	r := Probe(context.Background(), http.DefaultClient, check("x", "http://"+addr+"/"))
	if r.OK || !strings.Contains(r.Error, "connection refused") {
		t.Errorf("closed port: %+v", r)
	}
	r = Probe(context.Background(), http.DefaultClient, check("x", "http://no-such-host.invalid/"))
	if r.OK || !strings.Contains(r.Error, "can't find the server no-such-host.invalid") {
		t.Errorf("bad host: %+v", r)
	}
}

// ---- state changes ---------------------------------------------------------

func TestStateChangesAndIncidents(t *testing.T) {
	m := NewMonitor([]Check{check("site", "https://example.com/")})
	var events []Event
	m.OnChange = func(e Event) { events = append(events, e) }
	at := func(min int) time.Time { return t0.Add(time.Duration(min) * time.Minute) }

	m.Record("site", ok(at(0), 100*time.Millisecond))    // unknown → up
	m.Record("site", fail(at(1), "timeout"))             // 1 failure: still up
	m.Record("site", ok(at(2), 100*time.Millisecond))    // recovered, no event
	m.Record("site", fail(at(3), "connection refused"))  // 1
	m.Record("site", fail(at(4), "connection refused"))  // 2 → down
	m.Record("site", fail(at(5), "connection refused"))  // still down, no new event
	m.Record("site", ok(at(9), 120*time.Millisecond))    // back up
	m.Record("nonexistent", ok(at(9), time.Millisecond)) // ignored

	want := []string{"unknown→up", "up→down connection refused", "down→up"}
	var got []string
	for _, e := range events {
		s := string(e.From) + "→" + string(e.To)
		if e.Reason != "" {
			s += " " + e.Reason
		}
		got = append(got, s)
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("events %q, want %q", got, want)
	}
	if events[1].Time != at(4) {
		t.Errorf("went down at %v, want %v", events[1].Time, at(4))
	}
	m.Now = func() time.Time { return at(10) }
	st := m.Snapshot()[0]
	if st.State != Up || len(st.Incidents) != 1 {
		t.Fatalf("snapshot %+v", st)
	}
	in := st.Incidents[0]
	if in.Start != at(4) || in.End != at(9) || in.Reason != "connection refused" {
		t.Errorf("incident %+v", in)
	}
}

func TestFirstResultFailingIsDownImmediately(t *testing.T) {
	m := NewMonitor([]Check{check("site", "https://example.com/")})
	ev := m.Record("site", fail(t0, "no answer within 10s"))
	if ev == nil || ev.From != Unknown || ev.To != Down {
		t.Fatalf("event %+v", ev)
	}
}

func TestFailuresBeforeDown(t *testing.T) {
	c := check("site", "https://example.com/")
	c.FailuresBeforeDown = 3
	m := NewMonitor([]Check{c})
	m.Record("site", ok(t0, time.Millisecond))
	for i := 1; i <= 2; i++ {
		if ev := m.Record("site", fail(t0.Add(time.Duration(i)*time.Minute), "x")); ev != nil {
			t.Fatalf("failure %d already sent %+v", i, ev)
		}
	}
	if ev := m.Record("site", fail(t0.Add(3*time.Minute), "x")); ev == nil || ev.To != Down {
		t.Fatalf("third failure: %+v", ev)
	}
}

// ---- the 24-hour summary ---------------------------------------------------

func TestSnapshotUptimeBarsAndLatency(t *testing.T) {
	m := NewMonitor([]Check{check("api", "https://example.com/"), check("idle", "https://example.org/")})
	now := t0
	m.Now = func() time.Time { return now }
	// One result a minute for 24 hours; the API was down from 10:00 to 10:30.
	for i := 24 * 60; i > 0; i-- {
		at := now.Add(-time.Duration(i)*time.Minute + time.Second)
		if at.Hour() == 10 && at.Minute() < 30 {
			m.Record("api", fail(at, "status 502"))
		} else {
			m.Record("api", ok(at, time.Duration(100+i%100)*time.Millisecond))
		}
	}
	m.Record("api", ok(now.Add(-49*time.Hour), time.Hour)) // too old to count
	st := m.Snapshot()
	api, idle := st[0], st[1]

	if want := 100 * float64(1440-30) / 1440; api.Uptime != want {
		t.Errorf("uptime %.4f, want %.4f", api.Uptime, want)
	}
	if len(api.Bars) != 48 {
		t.Fatalf("%d bars", len(api.Bars))
	}
	classes := ""
	for _, b := range api.Bars {
		classes += b.Class()[:1]
	}
	// Bars start at 12:00 yesterday; 10:00–10:30 is bar 44.
	if want := strings.Repeat("u", 44) + "d" + "uuu"; classes != want {
		t.Errorf("bars %s\nwant %s", classes, want)
	}
	if api.Bars[0].Total != 30 || api.Bars[44].OK != 0 {
		t.Errorf("bar counts %+v %+v", api.Bars[0], api.Bars[44])
	}
	if api.P50 < 140*time.Millisecond || api.P50 > 160*time.Millisecond || api.P95 < 190*time.Millisecond {
		t.Errorf("p50 %v p95 %v", api.P50, api.P95)
	}
	if idle.Uptime != -1 || idle.State != Unknown || idle.Bars[0].Class() != "none" || idle.Last != nil {
		t.Errorf("idle check %+v", idle)
	}
}

func TestPartialBar(t *testing.T) {
	b := Bar{Total: 30, OK: 29}
	if b.Class() != "partial" {
		t.Error(b.Class())
	}
}

func TestPercentile(t *testing.T) {
	ms := func(v ...int) []time.Duration {
		out := make([]time.Duration, len(v))
		for i, x := range v {
			out[i] = time.Duration(x) * time.Millisecond
		}
		return out
	}
	vals := ms(15, 20, 35, 40, 50)
	for p, want := range map[float64]int{0: 15, 30: 20, 40: 20, 50: 35, 100: 50} {
		if got := Percentile(vals, p); got != time.Duration(want)*time.Millisecond {
			t.Errorf("p%v = %v, want %dms", p, got, want)
		}
	}
	if Percentile(nil, 50) != 0 {
		t.Error("empty")
	}
	if vals[0] != 15*time.Millisecond {
		t.Error("Percentile must not reorder its input")
	}
}

func TestOverall(t *testing.T) {
	s := func(states ...State) []CheckStatus {
		out := make([]CheckStatus, len(states))
		for i, st := range states {
			out[i].State = st
		}
		return out
	}
	for _, tc := range []struct {
		states []State
		want   string
	}{
		{[]State{Up, Up}, "All systems operational"},
		{[]State{Up, Down}, "Partial outage"},
		{[]State{Down, Down}, "Major outage"},
		{[]State{Up, Unknown}, "Checking…"},
		{[]State{Down, Unknown}, "Partial outage"},
	} {
		if got, _ := Overall(s(tc.states...)); got != tc.want {
			t.Errorf("%v: %q, want %q", tc.states, got, tc.want)
		}
	}
}

func TestHistoryIsBounded(t *testing.T) {
	m := NewMonitor([]Check{check("x", "https://example.com/")})
	for i := 0; i < historySize+500; i++ {
		m.Record("x", ok(t0.Add(time.Duration(i)*time.Second), time.Millisecond))
	}
	cs := m.byName["x"]
	if len(cs.history) != historySize || !cs.history[0].Time.Equal(t0.Add(500*time.Second)) {
		t.Fatalf("history has %d results starting %v", len(cs.history), cs.history[0].Time)
	}
}

// ---- running for real -------------------------------------------------------

func TestRunChecksOnSchedule(t *testing.T) {
	var mu sync.Mutex
	up := true
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		hits++
		if !up {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
	}))
	defer srv.Close()
	c := check("svc", srv.URL)
	c.Interval = Duration(time.Second)
	c.Timeout = Duration(500 * time.Millisecond)
	c.FailuresBeforeDown = 1
	m := NewMonitor([]Check{c})
	changes := make(chan Event, 10)
	m.OnChange = func(e Event) { changes <- e }

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { m.Run(ctx); close(done) }()
	expect := func(to State) {
		t.Helper()
		select {
		case e := <-changes:
			if e.To != to {
				t.Fatalf("got %+v, want → %s", e, to)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("no change to %s", to)
		}
	}
	expect(Up) // checked immediately at start
	mu.Lock()
	up = false
	mu.Unlock()
	expect(Down)
	mu.Lock()
	up = true
	mu.Unlock()
	expect(Up)
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run didn't stop")
	}
	mu.Lock()
	defer mu.Unlock()
	if hits < 3 {
		t.Errorf("only %d requests", hits)
	}
}

// ---- web pages ---------------------------------------------------------------

func TestStatusPage(t *testing.T) {
	m := NewMonitor([]Check{check("Website", "https://shop.example/"), check("<script>alert(1)</script>", "https://x.example/")})
	m.Now = func() time.Time { return t0 }
	m.Record("Website", ok(t0.Add(-2*time.Minute), 80*time.Millisecond))
	m.Record("<script>alert(1)</script>", fail(t0.Add(-90*time.Second), "no answer within 10s"))
	srv := httptest.NewServer(Handler(m, "Sharma Stores"))
	defer srv.Close()

	body := get(t, srv.URL+"/")
	for _, want := range []string{
		"<title>Sharma Stores: Partial outage</title>",
		`<div class="banner partial">Partial outage</div>`,
		"Operational", "Down", "Uptime <b>100.00%</b>", "Median response <b>80 ms</b>",
		"Last check <b>2 min ago</b>", "no answer within 10s",
		"&lt;script&gt;alert(1)&lt;/script&gt;", // escaped, not executed
		"(ongoing)",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("page is missing %q", want)
		}
	}
	if strings.Contains(body, "<script>alert") {
		t.Error("check name was not escaped")
	}
	if n := strings.Count(body, `<span class="none"`); n != 2*48-2 {
		t.Errorf("%d empty bars, want %d", n, 2*48-2)
	}

	var api struct {
		Overall string `json:"overall"`
		Checks  []struct {
			Name   string  `json:"name"`
			State  string  `json:"state"`
			Uptime float64 `json:"uptime_24h"`
		} `json:"checks"`
	}
	if err := json.Unmarshal([]byte(get(t, srv.URL+"/api/status")), &api); err != nil {
		t.Fatal(err)
	}
	if api.Overall != "Partial outage" || api.Checks[0].State != "up" || api.Checks[1].Uptime != 0 {
		t.Errorf("api %+v", api)
	}
	if strings.TrimSpace(get(t, srv.URL+"/healthz")) != "ok" {
		t.Error("healthz")
	}
	resp, _ := http.Get(srv.URL + "/nope")
	if resp.StatusCode != 404 {
		t.Errorf("unknown path: %d", resp.StatusCode)
	}
}

func TestEmptyStatusPage(t *testing.T) {
	m := NewMonitor([]Check{check("Website", "https://shop.example/")})
	srv := httptest.NewServer(Handler(m, "Status"))
	defer srv.Close()
	body := get(t, srv.URL+"/")
	for _, want := range []string{"Checking…", "No incidents.", "Uptime <b>—</b>"} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q", want)
		}
	}
}

func get(t *testing.T, url string) string {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return string(b)
}

// ---- alerts and saved history ---------------------------------------------

func TestWebhook(t *testing.T) {
	got := make(chan map[string]any, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if r.Header.Get("Content-Type") != "application/json" {
			w.WriteHeader(400)
		}
		got <- body
	}))
	defer srv.Close()
	e := Event{Check: "Payments API", From: Up, To: Down, Time: t0, Reason: "got status 502 Bad Gateway"}
	if err := SendWebhook(context.Background(), http.DefaultClient, srv.URL, e); err != nil {
		t.Fatal(err)
	}
	body := <-got
	if body["text"] != "🔴 Payments API is DOWN: got status 502 Bad Gateway" || body["content"] != body["text"] ||
		body["check"] != "Payments API" || body["to"] != "down" {
		t.Errorf("body %v", body)
	}
	back := Event{Check: "Payments API", From: Down, To: Up}
	if back.Message() != "🟢 Payments API is back UP" {
		t.Error(back.Message())
	}

	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) }))
	defer failing.Close()
	if err := SendWebhook(context.Background(), http.DefaultClient, failing.URL, e); err == nil || !strings.Contains(err.Error(), "500") {
		t.Errorf("error %v", err)
	}
}

func TestHistorySurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.jsonl")
	checks := []Check{check("site", "https://example.com/")}

	m := NewMonitor(checks)
	store, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	m.OnResult = func(name string, r Result) { store.Append(name, r) }
	m.Record("site", ok(t0, 50*time.Millisecond))
	m.Record("site", fail(t0.Add(time.Minute), "boom"))
	m.Record("site", fail(t0.Add(2*time.Minute), "boom"))
	store.Close()
	// A crash in the middle of writing leaves half a line.
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"check":"site","time":"2026-10-24T12:0`)
	f.Close()

	restarted := NewMonitor(append(checks, check("new", "https://new.example/")))
	alerts := 0
	restarted.OnChange = func(Event) { alerts++ }
	n, err := LoadHistory(path, restarted)
	if err != nil || n != 3 {
		t.Fatalf("loaded %d, %v", n, err)
	}
	if alerts != 0 {
		t.Error("replaying history must not send alerts")
	}
	if restarted.OnChange == nil {
		t.Error("OnChange must be restored after loading")
	}
	restarted.Now = func() time.Time { return t0.Add(3 * time.Minute) }
	st := restarted.Snapshot()[0]
	if st.State != Down || len(st.Incidents) != 1 || st.Incidents[0].Start != t0.Add(2*time.Minute) {
		t.Errorf("restored %+v", st)
	}
	if n, err := LoadHistory(filepath.Join(t.TempDir(), "missing.jsonl"), restarted); n != 0 || err != nil {
		t.Errorf("missing file: %d %v", n, err)
	}
}

// ---- config ------------------------------------------------------------------

func TestLoadConfig(t *testing.T) {
	dir := t.TempDir()
	write := func(text string) string {
		p := filepath.Join(dir, "c.json")
		os.WriteFile(p, []byte(text), 0o644)
		return p
	}
	cfg, err := LoadConfig(write(`{"checks":[{"name":"a","url":"https://a.example/","interval":"30s"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	c := cfg.Checks[0]
	if cfg.Listen != ":8080" || cfg.Title != "Status" || time.Duration(c.Interval) != 30*time.Second ||
		time.Duration(c.Timeout) != 10*time.Second || c.FailuresBeforeDown != 2 {
		t.Errorf("defaults %+v %+v", cfg, c)
	}

	for text, want := range map[string]string{
		`{"checks":[]}`: "no checks configured",
		`{"checks":[{"name":"a","url":"ftp://x"}]}`:                                                  "must start with http:// or https://",
		`{"checks":[{"name":"a","url":"https://x.example","intreval":"5s"}]}`:                        `unknown field "intreval"`,
		`{"checks":[{"name":"a","url":"https://x.example","interval":"5 minutes"}]}`:                 "bad duration",
		`{"checks":[{"name":"a","url":"https://x.example","interval":30}]}`:                          "durations are strings",
		`{"checks":[{"name":"a","url":"https://x.example","interval":"5s"}]}`:                        "timeout (10s) is longer than the interval (5s)",
		`{"checks":[{"name":"a","url":"https://x.example"},{"name":"a","url":"https://y.example"}]}`: "duplicate name",
		`{"checks":[{"url":"https://x.example"}]}`:                                                   "missing name",
		`{"checks":[{"name":"a","url":"https://x.example","expect_status":42}]}`:                     "not an HTTP status",
		`{"webhook":"slack","checks":[{"name":"a","url":"https://x.example"}]}`:                      "not an http(s) URL",
	} {
		_, err := LoadConfig(write(text))
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s\n  error %v, want %q", text, err, want)
		}
	}
	// All problems are reported together, not one per run.
	_, err = LoadConfig(write(`{"checks":[{"name":"a","url":"x"},{"name":"b","url":"https://b.example","interval":"1ms"}]}`))
	if err == nil || strings.Count(err.Error(), "\n") < 1 {
		t.Errorf("want several errors, got %v", err)
	}
	if _, err := LoadConfig("upwatch.example.json"); err != nil {
		t.Errorf("the example config must be valid: %v", err)
	}
}
