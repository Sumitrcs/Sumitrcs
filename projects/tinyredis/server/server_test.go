package server

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Sumitrcs/tinyredis/resp"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) Add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func start(t *testing.T, cfg Config) *Server {
	t.Helper()
	cfg.Addr = "127.0.0.1:0"
	s, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Listen(); err != nil {
		t.Fatal(err)
	}
	go s.Serve()
	t.Cleanup(func() { s.Close() })
	return s
}

// client is a tiny RESP client that returns replies in redis-cli style text.
type client struct {
	c net.Conn
	r *bufio.Reader
}

func dial(t *testing.T, s *Server) *client {
	t.Helper()
	c, err := net.Dial("tcp", s.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return &client{c, bufio.NewReader(c)}
}

func (cl *client) send(args ...string) { cl.c.Write(resp.EncodeCommand(args)) }

func (cl *client) reply() string {
	line, _ := cl.r.ReadString('\n')
	line = strings.TrimRight(line, "\r\n")
	switch line[0] {
	case '+', '-', ':':
		return line
	case '$':
		var n int
		fmt.Sscanf(line[1:], "%d", &n)
		if n < 0 {
			return "(nil)"
		}
		buf := make([]byte, n+2)
		_, _ = ioReadFull(cl.r, buf)
		return string(buf[:n])
	case '*':
		var n int
		fmt.Sscanf(line[1:], "%d", &n)
		items := make([]string, n)
		for i := range items {
			items[i] = cl.reply()
		}
		return "[" + strings.Join(items, " ") + "]"
	}
	return "?" + line
}

func ioReadFull(r *bufio.Reader, buf []byte) (int, error) {
	n := 0
	for n < len(buf) {
		m, err := r.Read(buf[n:])
		n += m
		if err != nil {
			return n, err
		}
	}
	return n, nil
}

func (cl *client) do(args ...string) string {
	cl.send(args...)
	return cl.reply()
}

func TestCommands(t *testing.T) {
	c := dial(t, start(t, Config{}))
	cases := [][2]string{
		{"PING", "+PONG"},
		{"PING hello", "hello"},
		{"ECHO namaste", "namaste"},
		{"SET name Sumit", "+OK"},
		{"GET name", "Sumit"},
		{"SET name Other NX", "(nil)"},
		{"SET newkey v XX", "(nil)"},
		{"GET missing", "(nil)"},
		{"INCR hits", ":1"},
		{"INCRBY hits 41", ":42"},
		{"DECRBY hits 2", ":40"},
		{"INCR name", "-ERR value is not an integer or out of range"},
		{"RPUSH q a b c", ":3"},
		{"LPUSH q z", ":4"},
		{"LRANGE q 0 -1", "[z a b c]"},
		{"LPOP q", "z"},
		{"LLEN q", ":3"},
		{"HSET h f1 v1 f2 v2", ":2"},
		{"HGET h f2", "v2"},
		{"HGETALL h", "[f1 v1 f2 v2]"},
		{"HDEL h f1 nope", ":1"},
		{"TYPE q", "+list"},
		{"GET q", "-WRONGTYPE Operation against a key holding the wrong kind of value"},
		{"EXISTS name q nope", ":2"},
		{"KEYS *", "[h hits name q]"},
		{"DEL name hits nope", ":2"},
		{"DBSIZE", ":2"},
		{"NOPE", "-ERR unknown command 'NOPE'"},
		{"GET", "-ERR wrong number of arguments for 'get' command"},
		{"SET k v EX", "-ERR syntax error"},
		{"SET k v EX -5", "-ERR invalid expire time in 'set' command"},
		{"FLUSHALL", "+OK"},
		{"DBSIZE", ":0"},
	}
	for _, tc := range cases {
		if got := c.do(strings.Fields(tc[0])...); got != tc[1] {
			t.Errorf("%s => %q, want %q", tc[0], got, tc[1])
		}
	}
}

func TestExpiryWithFakeClock(t *testing.T) {
	clk := &fakeClock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	c := dial(t, start(t, Config{Now: clk.Now}))
	c.do("SET", "otp", "123456", "EX", "30")
	if got := c.do("TTL", "otp"); got != ":30" {
		t.Fatalf("TTL = %s", got)
	}
	clk.Add(29500 * time.Millisecond)
	if got := c.do("PTTL", "otp"); got != ":500" {
		t.Fatalf("PTTL = %s", got)
	}
	clk.Add(time.Second)
	if got := c.do("GET", "otp"); got != "(nil)" {
		t.Fatalf("expired key still readable: %s", got)
	}
	c.do("SET", "k", "v")
	if c.do("EXPIRE", "k", "10") != ":1" || c.do("PERSIST", "k") != ":1" || c.do("TTL", "k") != ":-1" {
		t.Fatal("EXPIRE/PERSIST")
	}
	if c.do("TTL", "missing") != ":-2" || c.do("EXPIRE", "missing", "5") != ":0" {
		t.Fatal("missing key TTL semantics")
	}
}

func TestPipeliningAndInlineCommands(t *testing.T) {
	c := dial(t, start(t, Config{}))
	// Many commands in one write, replies must come back in order.
	var batch []byte
	for i := 0; i < 100; i++ {
		batch = append(batch, resp.EncodeCommand([]string{"INCR", "n"})...)
	}
	c.c.Write(batch)
	for i := 1; i <= 100; i++ {
		if got := c.reply(); got != fmt.Sprintf(":%d", i) {
			t.Fatalf("reply %d = %s", i, got)
		}
	}
	// Inline commands, as typed into telnet or nc
	c.c.Write([]byte("SET greeting hello\r\nGET greeting\r\n"))
	if c.reply() != "+OK" || c.reply() != "hello" {
		t.Fatal("inline commands")
	}
}

func TestConcurrentClientsIncrementExactly(t *testing.T) {
	s := start(t, Config{})
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c := dial(t, s)
			for j := 0; j < 100; j++ {
				c.do("INCR", "counter")
			}
		}()
	}
	wg.Wait()
	if got := dial(t, s).do("GET", "counter"); got != "2000" {
		t.Fatalf("counter = %s", got)
	}
}

func TestAOFReplayRestoresDataAndDeadlines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "appendonly.aof")
	clk := &fakeClock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}

	s1, err := New(Config{Addr: "127.0.0.1:0", AOFPath: path, Now: clk.Now})
	if err != nil || s1.Listen() != nil {
		t.Fatal(err)
	}
	go s1.Serve()
	c := dial(t, s1)
	c.do("SET", "session", "abc", "EX", "60")
	c.do("INCRBY", "visits", "7")
	c.do("RPUSH", "jobs", "a", "b")
	c.do("LPOP", "jobs")
	c.do("HSET", "user", "name", "Sumit")
	c.do("DEL", "nothing") // deleting nothing is not logged
	s1.Close()

	// 40 seconds later the server restarts: the session must have 20s left, not 60s.
	clk.Add(40 * time.Second)
	c2 := dial(t, start(t, Config{AOFPath: path, Now: clk.Now}))
	checks := [][2]string{
		{"GET visits", "7"},
		{"LRANGE jobs 0 -1", "[b]"},
		{"HGET user name", "Sumit"},
		{"TTL session", ":20"},
	}
	for _, tc := range checks {
		if got := c2.do(strings.Fields(tc[0])...); got != tc[1] {
			t.Errorf("after restart %s => %s, want %s", tc[0], got, tc[1])
		}
	}
}

func TestAOFWithTornTailStillLoads(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a.aof")
	good := resp.EncodeCommand([]string{"SET", "k", "v"})
	torn := resp.EncodeCommand([]string{"SET", "k2", "v2"})
	os.WriteFile(path, append(good, torn[:len(torn)-4]...), 0o644)
	c := dial(t, start(t, Config{AOFPath: path}))
	if got := c.do("GET", "k"); got != "v" {
		t.Fatalf("GET k = %s", got)
	}
	if got := c.do("GET", "k2"); got != "(nil)" {
		t.Fatalf("torn command should be dropped, got %s", got)
	}
}

func TestWorksWithRealRedisCLI(t *testing.T) {
	cli, err := exec.LookPath("redis-cli")
	if err != nil {
		t.Skip("redis-cli not installed")
	}
	s := start(t, Config{})
	_, port, _ := net.SplitHostPort(s.Addr().String())
	run := func(args ...string) string {
		out, err := exec.Command(cli, append([]string{"-p", port}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("redis-cli %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	if got := run("SET", "lang", "Go"); got != "OK" {
		t.Fatalf("SET = %q", got)
	}
	if got := run("GET", "lang"); got != "Go" {
		t.Fatalf("GET = %q", got)
	}
	run("RPUSH", "l", "1", "2", "3")
	if got := run("LRANGE", "l", "0", "-1"); got != "1\n2\n3" {
		t.Fatalf("LRANGE = %q", got)
	}
}
