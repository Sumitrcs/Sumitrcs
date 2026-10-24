package upwatch

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// Result is the outcome of one check.
type Result struct {
	Time    time.Time     `json:"time"`
	OK      bool          `json:"ok"`
	Status  int           `json:"status,omitempty"` // HTTP status, 0 if there was no answer
	Latency time.Duration `json:"latency"`
	Error   string        `json:"error,omitempty"`
}

// Read at most this much of a response when looking for expect_text.
const maxBody = 1 << 20

// Probe requests the check's URL once and decides whether it is up.
func Probe(ctx context.Context, client *http.Client, c Check) Result {
	ctx, cancel := context.WithTimeout(ctx, time.Duration(c.Timeout))
	defer cancel()
	start := time.Now()
	res := Result{Time: start}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.URL, nil)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	req.Header.Set("User-Agent", "upwatch/1.0 (+https://github.com/Sumitrcs/upwatch)")
	resp, err := client.Do(req)
	if err != nil {
		res.Latency = time.Since(start)
		res.Error = explain(err, time.Duration(c.Timeout))
		return res
	}
	defer resp.Body.Close()
	res.Status = resp.StatusCode

	// Reading the body is part of the check: a server that sends headers
	// and then hangs is not really up.
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	res.Latency = time.Since(start)
	if err != nil {
		res.Error = "reading the response: " + explain(err, time.Duration(c.Timeout))
		return res
	}
	switch {
	case c.ExpectStatus != 0 && resp.StatusCode != c.ExpectStatus:
		res.Error = fmt.Sprintf("got status %d, expected %d", resp.StatusCode, c.ExpectStatus)
	case c.ExpectStatus == 0 && resp.StatusCode >= 400:
		res.Error = fmt.Sprintf("got status %d %s", resp.StatusCode, http.StatusText(resp.StatusCode))
	case c.ExpectText != "" && !bytes.Contains(body, []byte(c.ExpectText)):
		res.Error = fmt.Sprintf("the page doesn't contain %q", c.ExpectText)
	default:
		res.OK = true
	}
	return res
}

// explain turns Go's network errors into something a person can act on.
func explain(err error, timeout time.Duration) string {
	var dnsErr *net.DNSError
	var opErr *net.OpError
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return fmt.Sprintf("no answer within %s", timeout)
	case errors.As(err, &dnsErr):
		return fmt.Sprintf("can't find the server %s (DNS)", dnsErr.Name)
	case errors.As(err, &opErr) && opErr.Op == "dial":
		if strings.Contains(opErr.Err.Error(), "refused") {
			return "connection refused (is the server running?)"
		}
		return "can't connect: " + opErr.Err.Error()
	case strings.Contains(err.Error(), "certificate"):
		return "TLS certificate problem: " + err.Error()
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return fmt.Sprintf("no answer within %s", timeout)
	}
	return err.Error()
}
