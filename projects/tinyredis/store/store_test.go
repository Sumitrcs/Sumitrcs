package store

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time      { return c.t }
func (c *clock) add(d time.Duration) { c.t = c.t.Add(d) }
func newStore() (*Store, *clock) {
	c := &clock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	return NewWithClock(c.now), c
}

func TestStringsAndOptions(t *testing.T) {
	s, _ := newStore()
	if !s.Set("k", "v1", SetOptions{}) {
		t.Fatal("plain set failed")
	}
	if s.Set("k", "v2", SetOptions{NX: true}) {
		t.Fatal("NX must not overwrite")
	}
	if s.Set("missing", "x", SetOptions{XX: true}) {
		t.Fatal("XX must not create")
	}
	if v, ok, _ := s.Get("k"); !ok || v != "v1" {
		t.Fatalf("get = %q %v", v, ok)
	}
	if _, ok, _ := s.Get("nope"); ok {
		t.Fatal("missing key found")
	}
}

func TestIncr(t *testing.T) {
	s, _ := newStore()
	for i, want := range []int64{1, 2, 12} {
		delta := []int64{1, 1, 10}[i]
		if n, err := s.IncrBy("c", delta); err != nil || n != want {
			t.Fatalf("incr -> %d %v", n, err)
		}
	}
	s.Set("text", "abc", SetOptions{})
	if _, err := s.IncrBy("text", 1); !errors.Is(err, ErrNotInt) {
		t.Fatalf("want ErrNotInt, got %v", err)
	}
	s.Set("big", "9223372036854775807", SetOptions{})
	if _, err := s.IncrBy("big", 1); err == nil {
		t.Fatal("overflow must be rejected")
	}
}

func TestExpiryLazyAndTTL(t *testing.T) {
	s, c := newStore()
	s.Set("session", "abc", SetOptions{TTL: 10 * time.Second})
	if ttl := s.TTL("session"); ttl != 10*time.Second {
		t.Fatalf("ttl = %v", ttl)
	}
	c.add(9 * time.Second)
	if s.Exists("session") != 1 {
		t.Fatal("expired too early")
	}
	c.add(time.Second)
	if s.Exists("session") != 0 || s.TTL("session") != -2 {
		t.Fatal("key should have expired")
	}
	s.Set("p", "v", SetOptions{TTL: time.Minute})
	if !s.Persist("p") || s.TTL("p") != -1 {
		t.Fatal("persist failed")
	}
	if !s.Expire("p", 0) || s.Exists("p") != 0 {
		t.Fatal("expire 0 must delete")
	}
	s.Set("keep", "1", SetOptions{TTL: time.Minute})
	s.Set("keep", "2", SetOptions{KeepTTL: true})
	if s.TTL("keep") != time.Minute {
		t.Fatal("KEEPTTL lost the expiry")
	}
	s.Set("keep", "3", SetOptions{})
	if s.TTL("keep") != -1 {
		t.Fatal("a plain SET clears the TTL")
	}
}

func TestActiveSweepRemovesExpiredKeys(t *testing.T) {
	s, c := newStore()
	for i := 0; i < 1000; i++ {
		s.Set(string(rune('a'+i%26))+time.Duration(i).String(), "x", SetOptions{TTL: time.Second})
	}
	s.Set("forever", "x", SetOptions{})
	c.add(2 * time.Second)
	if n := s.SweepExpired(20); n != 1000 {
		t.Fatalf("swept %d, want 1000 (sweep repeats while >25%% expired)", n)
	}
	if s.Len() != 1 {
		t.Fatalf("len = %d", s.Len())
	}
}

func TestListsWithNegativeRanges(t *testing.T) {
	s, _ := newStore()
	s.Push("l", false, "b", "c")
	s.Push("l", true, "a")
	if got, _ := s.Range("l", 0, -1); !reflect.DeepEqual(got, []string{"a", "b", "c"}) {
		t.Fatalf("range = %v", got)
	}
	if got, _ := s.Range("l", -2, 10); !reflect.DeepEqual(got, []string{"b", "c"}) {
		t.Fatalf("range = %v", got)
	}
	if got, _ := s.Range("l", 5, 9); len(got) != 0 {
		t.Fatalf("range = %v", got)
	}
	v, _, _ := s.Pop("l", true)
	w, _, _ := s.Pop("l", false)
	if v != "a" || w != "c" {
		t.Fatalf("pops = %s %s", v, w)
	}
	s.Pop("l", true)
	if s.Exists("l") != 0 {
		t.Fatal("empty list should disappear")
	}
}

func TestHashes(t *testing.T) {
	s, _ := newStore()
	if n, _ := s.HSet("user:1", "name", "Sumit", "city", "Delhi"); n != 2 {
		t.Fatalf("added %d", n)
	}
	if n, _ := s.HSet("user:1", "city", "Noida"); n != 0 {
		t.Fatal("updating a field is not an addition")
	}
	if v, ok, _ := s.HGet("user:1", "city"); !ok || v != "Noida" {
		t.Fatalf("hget = %s", v)
	}
	if all, _ := s.HGetAll("user:1"); !reflect.DeepEqual(all, []string{"city", "Noida", "name", "Sumit"}) {
		t.Fatalf("hgetall = %v", all)
	}
	s.HDel("user:1", "city", "name")
	if s.Exists("user:1") != 0 {
		t.Fatal("empty hash should disappear")
	}
}

func TestWrongType(t *testing.T) {
	s, _ := newStore()
	s.Set("str", "x", SetOptions{})
	if _, err := s.Push("str", true, "a"); !errors.Is(err, ErrWrongType) {
		t.Fatal("push on a string must fail")
	}
	if _, err := s.HSet("str", "f", "v"); !errors.Is(err, ErrWrongType) {
		t.Fatal("hset on a string must fail")
	}
	s.Push("list", true, "a")
	if _, _, err := s.Get("list"); !errors.Is(err, ErrWrongType) {
		t.Fatal("get on a list must fail")
	}
	if s.Type("list") != "list" || s.Type("str") != "string" || s.Type("none") != "none" {
		t.Fatal("type")
	}
}

func TestKeysAndGlob(t *testing.T) {
	s, _ := newStore()
	for _, k := range []string{"user:1", "user:2", "user:10", "order/7", "hello"} {
		s.Set(k, "x", SetOptions{})
	}
	if got := s.Keys("user:?"); !reflect.DeepEqual(got, []string{"user:1", "user:2"}) {
		t.Fatalf("keys = %v", got)
	}
	if got := s.Keys("*"); len(got) != 5 {
		t.Fatalf("keys * = %v", got)
	}
	cases := []struct {
		p, s string
		want bool
	}{
		{"*", "a/b/c", true}, // unlike filepath.Match, * crosses "/"
		{"h?llo", "hello", true},
		{"h[ae]llo", "hallo", true},
		{"h[^e]llo", "hello", false},
		{"h[a-c]llo", "hbllo", true},
		{"a*b*c", "axxbyyc", true},
		{"a*b*c", "axxbyy", false},
		{`\*`, "*", true},
		{`\*`, "a", false},
		{"[abc", "[abc", true}, // unterminated class is literal
		{"", "", true},
		{"**", "", true},
	}
	for _, c := range cases {
		if got := Glob(c.p, c.s); got != c.want {
			t.Errorf("Glob(%q, %q) = %v, want %v", c.p, c.s, got, c.want)
		}
	}
}
