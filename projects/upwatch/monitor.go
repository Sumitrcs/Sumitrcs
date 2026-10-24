package upwatch

import (
	"context"
	"log"
	"net/http"
	"sort"
	"sync"
	"time"
)

// State of a check, as shown on the status page.
type State string

const (
	Unknown State = "unknown" // no results yet
	Up      State = "up"
	Down    State = "down"
)

// Event is sent when a check changes state.
type Event struct {
	Check  string    `json:"check"`
	From   State     `json:"from"`
	To     State     `json:"to"`
	Time   time.Time `json:"time"`
	Reason string    `json:"reason,omitempty"` // the error that made it go down
}

// Incident is a period during which a check was down.
type Incident struct {
	Start  time.Time `json:"start"`
	End    time.Time `json:"end,omitzero"` // zero while still ongoing
	Reason string    `json:"reason"`
}

// How many results to keep per check: two days at one check a minute.
const historySize = 2 * 24 * 60

type checkState struct {
	cfg       Check
	history   []Result // oldest first, at most historySize
	state     State
	failures  int // failures in a row
	incidents []Incident
}

// Monitor runs the checks and remembers their results. It is safe to use
// from several goroutines: each check runs in its own, and the web server
// reads snapshots from others.
type Monitor struct {
	mu     sync.Mutex
	checks []*checkState
	byName map[string]*checkState

	Client   *http.Client
	Now      func() time.Time     // the clock, replaceable in tests
	OnChange func(Event)          // called when a check goes down or comes back up
	OnResult func(string, Result) // called after every result (used to save history)
}

func NewMonitor(checks []Check) *Monitor {
	m := &Monitor{
		byName: map[string]*checkState{},
		Client: &http.Client{
			// Don't follow redirects forever; 5 is plenty for a health check.
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= 5 {
					return http.ErrUseLastResponse
				}
				return nil
			},
		},
		Now: time.Now,
	}
	for _, c := range checks {
		cs := &checkState{cfg: c, state: Unknown}
		m.checks = append(m.checks, cs)
		m.byName[c.Name] = cs
	}
	return m
}

// Has reports whether a check with this name is configured.
func (m *Monitor) Has(name string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.byName[name] != nil
}

// Record adds a result for a check and updates its state. It returns the
// state change, if there was one.
func (m *Monitor) Record(name string, r Result) *Event {
	m.mu.Lock()
	cs := m.byName[name]
	if cs == nil {
		m.mu.Unlock()
		return nil
	}
	cs.history = append(cs.history, r)
	if len(cs.history) > historySize {
		// Drop the oldest results. Copying keeps the slice from growing forever.
		cs.history = append(cs.history[:0], cs.history[len(cs.history)-historySize:]...)
	}
	var ev *Event
	if r.OK {
		cs.failures = 0
		if cs.state != Up {
			ev = &Event{Check: name, From: cs.state, To: Up, Time: r.Time}
			if cs.state == Down {
				cs.incidents[len(cs.incidents)-1].End = r.Time
			}
			cs.state = Up
		}
	} else {
		cs.failures++
		// Down after N failures in a row. When we know nothing yet (just
		// started), one failure is enough to say it isn't up.
		if cs.state != Down && (cs.failures >= cs.cfg.FailuresBeforeDown || cs.state == Unknown) {
			ev = &Event{Check: name, From: cs.state, To: Down, Time: r.Time, Reason: r.Error}
			cs.state = Down
			cs.incidents = append(cs.incidents, Incident{Start: r.Time, Reason: r.Error})
		}
	}
	onChange, onResult := m.OnChange, m.OnResult
	m.mu.Unlock()
	if onResult != nil {
		onResult(name, r)
	}
	if ev != nil && onChange != nil {
		onChange(*ev)
	}
	return ev
}

// Run checks every URL on its own schedule until ctx is cancelled.
func (m *Monitor) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for _, cs := range m.checks {
		wg.Add(1)
		go func(c Check) {
			defer wg.Done()
			ticker := time.NewTicker(time.Duration(c.Interval))
			defer ticker.Stop()
			for {
				r := Probe(ctx, m.Client, c)
				if ctx.Err() != nil {
					return // shutting down: this result is not real
				}
				m.Record(c.Name, r)
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
			}
		}(cs.cfg)
	}
	wg.Wait()
}

// ---- what the status page shows ---------------------------------------

// Bar is one slice of time in the uptime strip.
type Bar struct {
	Start, End time.Time
	Total, OK  int
}

func (b Bar) Class() string {
	switch {
	case b.Total == 0:
		return "none"
	case b.OK == b.Total:
		return "up"
	case b.OK == 0:
		return "down"
	default:
		return "partial"
	}
}

type CheckStatus struct {
	Name      string        `json:"name"`
	URL       string        `json:"url"`
	State     State         `json:"state"`
	Uptime    float64       `json:"uptime_24h"` // percent, or -1 with no data
	P50       time.Duration `json:"-"`
	P95       time.Duration `json:"-"`
	P50ms     int64         `json:"latency_p50_ms"` // median response time
	P95ms     int64         `json:"latency_p95_ms"` // 95% of responses were at least this fast
	Last      *Result       `json:"last,omitempty"`
	Bars      []Bar         `json:"-"`
	Incidents []Incident    `json:"incidents"` // newest first, at most 5
}

const (
	window   = 24 * time.Hour
	barCount = 48 // half an hour each
)

// Snapshot summarises every check for the last 24 hours.
func (m *Monitor) Snapshot() []CheckStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.Now()
	since := now.Add(-window)
	out := make([]CheckStatus, 0, len(m.checks))
	for _, cs := range m.checks {
		st := CheckStatus{Name: cs.cfg.Name, URL: cs.cfg.URL, State: cs.state, Uptime: -1}
		if n := len(cs.history); n > 0 {
			last := cs.history[n-1]
			st.Last = &last
		}
		step := window / barCount
		st.Bars = make([]Bar, barCount)
		for i := range st.Bars {
			st.Bars[i].Start = since.Add(time.Duration(i) * step)
			st.Bars[i].End = st.Bars[i].Start.Add(step)
		}
		var latencies []time.Duration
		total, ok := 0, 0
		for _, r := range cs.history {
			if r.Time.Before(since) || r.Time.After(now) {
				continue
			}
			total++
			i := int(r.Time.Sub(since) / step)
			if i >= barCount {
				i = barCount - 1
			}
			st.Bars[i].Total++
			if r.OK {
				ok++
				st.Bars[i].OK++
				latencies = append(latencies, r.Latency)
			}
		}
		if total > 0 {
			st.Uptime = 100 * float64(ok) / float64(total)
		}
		st.P50 = Percentile(latencies, 50)
		st.P95 = Percentile(latencies, 95)
		st.P50ms, st.P95ms = st.P50.Milliseconds(), st.P95.Milliseconds()
		for i := len(cs.incidents) - 1; i >= 0 && len(st.Incidents) < 5; i-- {
			st.Incidents = append(st.Incidents, cs.incidents[i])
		}
		out = append(out, st)
	}
	return out
}

// Percentile uses the nearest-rank method: the smallest value that at least
// p percent of the values are less than or equal to. 0 for no values.
func Percentile(values []time.Duration, p float64) time.Duration {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]time.Duration(nil), values...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	rank := int(p/100*float64(len(sorted)) + 0.999999) // ceil
	if rank < 1 {
		rank = 1
	}
	if rank > len(sorted) {
		rank = len(sorted)
	}
	return sorted[rank-1]
}

// Overall is the one-line summary at the top of the status page.
func Overall(checks []CheckStatus) (text, class string) {
	up, down := 0, 0
	for _, c := range checks {
		switch c.State {
		case Up:
			up++
		case Down:
			down++
		}
	}
	switch {
	case down == 0 && up == len(checks):
		return "All systems operational", "up"
	case down == len(checks):
		return "Major outage", "down"
	case down > 0:
		return "Partial outage", "partial"
	default:
		return "Checking…", "none"
	}
}

// LogChanges is a ready-made OnChange that writes state changes to the log.
func LogChanges(e Event) {
	if e.To == Down {
		log.Printf("DOWN  %s: %s", e.Check, e.Reason)
	} else {
		log.Printf("UP    %s", e.Check)
	}
}
