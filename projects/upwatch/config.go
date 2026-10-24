// Package upwatch checks that websites and APIs are up, keeps a history of
// the results, and serves a status page like the ones big services use to
// tell their users what's working.
package upwatch

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"
)

// Duration is a time.Duration written as "30s" or "5m" in the config file.
type Duration time.Duration

func (d *Duration) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return fmt.Errorf(`durations are strings like "30s" or "5m", got %s`, b)
	}
	v, err := time.ParseDuration(s)
	if err != nil {
		return fmt.Errorf("bad duration %q: use a number and a unit, like 30s or 5m", s)
	}
	*d = Duration(v)
	return nil
}

func (d Duration) MarshalJSON() ([]byte, error) { return json.Marshal(time.Duration(d).String()) }

// Check describes one thing to watch.
type Check struct {
	Name string `json:"name"`
	URL  string `json:"url"`
	// How often to check (default 60s) and how long to wait for an answer
	// (default 10s).
	Interval Duration `json:"interval"`
	Timeout  Duration `json:"timeout"`
	// The status code that means "up". 0 accepts any 2xx or 3xx.
	ExpectStatus int `json:"expect_status"`
	// If set, the response body must contain this text. Catches pages that
	// return 200 but show an error message.
	ExpectText string `json:"expect_text"`
	// How many failures in a row before the check is marked down
	// (default 2), so one dropped packet doesn't wake anyone up.
	FailuresBeforeDown int `json:"failures_before_down"`
}

type Config struct {
	Title    string  `json:"title"`
	Listen   string  `json:"listen"`    // address for the status page, e.g. ":8080"
	DataFile string  `json:"data_file"` // history is appended here, and read back on start
	Webhook  string  `json:"webhook"`   // POSTed to when a check goes down or comes back
	Checks   []Check `json:"checks"`
}

// LoadConfig reads and validates a JSON config file.
func LoadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields() // a typo like "intreval" should be an error, not silently ignored
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if err := c.Validate(); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return &c, nil
}

// Validate fills in defaults and reports every problem at once.
func (c *Config) Validate() error {
	if c.Title == "" {
		c.Title = "Status"
	}
	if c.Listen == "" {
		c.Listen = ":8080"
	}
	var errs []error
	if len(c.Checks) == 0 {
		errs = append(errs, errors.New("no checks configured"))
	}
	if c.Webhook != "" {
		if u, err := url.Parse(c.Webhook); err != nil || (u.Scheme != "http" && u.Scheme != "https") {
			errs = append(errs, fmt.Errorf("webhook %q is not an http(s) URL", c.Webhook))
		}
	}
	seen := map[string]bool{}
	for i := range c.Checks {
		ch := &c.Checks[i]
		where := fmt.Sprintf("check %d (%s)", i+1, ch.Name)
		if ch.Name == "" {
			errs = append(errs, fmt.Errorf("check %d: missing name", i+1))
		} else if seen[ch.Name] {
			errs = append(errs, fmt.Errorf("%s: duplicate name", where))
		}
		seen[ch.Name] = true
		if u, err := url.Parse(ch.URL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			errs = append(errs, fmt.Errorf("%s: url %q must start with http:// or https://", where, ch.URL))
		}
		if ch.Interval == 0 {
			ch.Interval = Duration(time.Minute)
		}
		if ch.Timeout == 0 {
			ch.Timeout = Duration(10 * time.Second)
		}
		if time.Duration(ch.Interval) < time.Second {
			errs = append(errs, fmt.Errorf("%s: interval must be at least 1s", where))
		}
		if ch.Timeout > ch.Interval {
			errs = append(errs, fmt.Errorf("%s: timeout (%s) is longer than the interval (%s)", where,
				time.Duration(ch.Timeout), time.Duration(ch.Interval)))
		}
		if ch.ExpectStatus != 0 && (ch.ExpectStatus < 100 || ch.ExpectStatus > 599) {
			errs = append(errs, fmt.Errorf("%s: expect_status %d is not an HTTP status", where, ch.ExpectStatus))
		}
		if ch.FailuresBeforeDown == 0 {
			ch.FailuresBeforeDown = 2
		}
		if ch.FailuresBeforeDown < 0 {
			errs = append(errs, fmt.Errorf("%s: failures_before_down can't be negative", where))
		}
	}
	return errors.Join(errs...)
}
