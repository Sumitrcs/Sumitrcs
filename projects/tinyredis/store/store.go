// Package store holds the in-memory data: strings, lists and hashes, each
// key with an optional expiry time.
//
// Expired keys are removed two ways, just like real Redis:
//   - lazily, when someone touches the key, and
//   - actively, by a background sweep that samples keys with a TTL.
package store

import (
	"errors"
	"sort"
	"strconv"
	"sync"
	"time"
)

var (
	ErrWrongType = errors.New("WRONGTYPE Operation against a key holding the wrong kind of value")
	ErrNotInt    = errors.New("ERR value is not an integer or out of range")
)

type kind int

const (
	kindString kind = iota
	kindList
	kindHash
)

type entry struct {
	kind  kind
	str   string
	list  []string
	hash  map[string]string
	expAt time.Time // zero = no expiry
}

type Store struct {
	mu       sync.Mutex
	data     map[string]*entry
	expiring map[string]struct{} // keys that have a TTL, for the active sweep
	now      func() time.Time
}

func New() *Store { return NewWithClock(time.Now) }

// NewWithClock lets tests control time.
func NewWithClock(now func() time.Time) *Store {
	return &Store{data: map[string]*entry{}, expiring: map[string]struct{}{}, now: now}
}

// get returns the live entry for key, deleting it first if it has expired.
// Callers must hold s.mu.
func (s *Store) get(key string) *entry {
	e, ok := s.data[key]
	if !ok {
		return nil
	}
	if !e.expAt.IsZero() && !s.now().Before(e.expAt) {
		s.remove(key)
		return nil
	}
	return e
}

func (s *Store) remove(key string) {
	delete(s.data, key)
	delete(s.expiring, key)
}

func (s *Store) typed(key string, k kind) (*entry, error) {
	e := s.get(key)
	if e != nil && e.kind != k {
		return nil, ErrWrongType
	}
	return e, nil
}

// ---- strings ----------------------------------------------------------------

type SetOptions struct {
	TTL     time.Duration // 0 = no expiry
	NX, XX  bool          // only set if the key does not / does exist
	KeepTTL bool
}

// Set returns false when NX/XX prevented the write.
func (s *Store) Set(key, value string, o SetOptions) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	old := s.get(key)
	if (o.NX && old != nil) || (o.XX && old == nil) {
		return false
	}
	e := &entry{kind: kindString, str: value}
	if o.KeepTTL && old != nil {
		e.expAt = old.expAt
	}
	s.data[key] = e
	s.setExpiry(key, e, o.TTL)
	return true
}

func (s *Store) setExpiry(key string, e *entry, ttl time.Duration) {
	if ttl > 0 {
		e.expAt = s.now().Add(ttl)
	}
	if e.expAt.IsZero() {
		delete(s.expiring, key)
	} else {
		s.expiring[key] = struct{}{}
	}
}

func (s *Store) Get(key string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, err := s.typed(key, kindString)
	if err != nil || e == nil {
		return "", false, err
	}
	return e.str, true, nil
}

// IncrBy adds delta to an integer stored as a string, creating it as 0 first.
func (s *Store) IncrBy(key string, delta int64) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, err := s.typed(key, kindString)
	if err != nil {
		return 0, err
	}
	var n int64
	if e != nil {
		if n, err = strconv.ParseInt(e.str, 10, 64); err != nil {
			return 0, ErrNotInt
		}
	} else {
		e = &entry{kind: kindString}
		s.data[key] = e
	}
	if (delta > 0 && n > (1<<63-1)-delta) || (delta < 0 && n < (-1<<63)-delta) {
		return 0, errors.New("ERR increment or decrement would overflow")
	}
	n += delta
	e.str = strconv.FormatInt(n, 10)
	return n, nil
}

// ---- generic keys --------------------------------------------------------------

func (s *Store) Del(keys ...string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, k := range keys {
		if s.get(k) != nil {
			s.remove(k)
			n++
		}
	}
	return n
}

func (s *Store) Exists(keys ...string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, k := range keys {
		if s.get(k) != nil {
			n++
		}
	}
	return n
}

func (s *Store) Type(key string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.get(key)
	if e == nil {
		return "none"
	}
	return [...]string{"string", "list", "hash"}[e.kind]
}

// Expire sets a TTL. Returns false if the key doesn't exist. A non-positive
// TTL deletes the key immediately, as in Redis.
func (s *Store) Expire(key string, ttl time.Duration) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.get(key)
	if e == nil {
		return false
	}
	if ttl <= 0 {
		s.remove(key)
		return true
	}
	s.setExpiry(key, e, ttl)
	return true
}

// TTL returns the remaining time to live: -2 if the key is missing, -1 if it has no expiry.
func (s *Store) TTL(key string) time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.get(key)
	switch {
	case e == nil:
		return -2
	case e.expAt.IsZero():
		return -1
	}
	return e.expAt.Sub(s.now())
}

func (s *Store) Persist(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.get(key)
	if e == nil || e.expAt.IsZero() {
		return false
	}
	e.expAt = time.Time{}
	delete(s.expiring, key)
	return true
}

// Keys returns live keys matching a glob pattern (*, ?, [abc]), sorted.
func (s *Store) Keys(pattern string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for k := range s.data {
		if s.get(k) == nil {
			continue
		}
		if Glob(pattern, k) {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

func (s *Store) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.data)
}

func (s *Store) Flush() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data = map[string]*entry{}
	s.expiring = map[string]struct{}{}
}

// SweepExpired samples up to `sample` keys that have a TTL and deletes the
// expired ones. Like Redis, it repeats while more than 25% of the sample was
// expired, so a burst of expiring keys is cleaned up quickly without ever
// scanning the whole keyspace at once. Returns the number removed.
func (s *Store) SweepExpired(sample int) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	removed := 0
	for {
		if len(s.expiring) == 0 {
			return removed
		}
		checked, expired := 0, 0
		now := s.now()
		for k := range s.expiring { // Go map iteration order is random: a free sample
			if checked == sample {
				break
			}
			checked++
			if e := s.data[k]; e != nil && !now.Before(e.expAt) {
				s.remove(k)
				expired++
			}
		}
		removed += expired
		if expired*4 <= checked {
			return removed
		}
	}
}

// ---- lists ----------------------------------------------------------------------

func (s *Store) Push(key string, left bool, values ...string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, err := s.typed(key, kindList)
	if err != nil {
		return 0, err
	}
	if e == nil {
		e = &entry{kind: kindList}
		s.data[key] = e
	}
	for _, v := range values {
		if left {
			e.list = append([]string{v}, e.list...)
		} else {
			e.list = append(e.list, v)
		}
	}
	return len(e.list), nil
}

func (s *Store) Pop(key string, left bool) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, err := s.typed(key, kindList)
	if err != nil || e == nil {
		return "", false, err
	}
	var v string
	if left {
		v, e.list = e.list[0], e.list[1:]
	} else {
		v, e.list = e.list[len(e.list)-1], e.list[:len(e.list)-1]
	}
	if len(e.list) == 0 {
		s.remove(key) // empty lists don't exist in Redis
	}
	return v, true, nil
}

// Range implements LRANGE, including negative indices counted from the end.
func (s *Store) Range(key string, start, stop int) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, err := s.typed(key, kindList)
	if err != nil || e == nil {
		return []string{}, err
	}
	n := len(e.list)
	if start < 0 {
		start = max(n+start, 0)
	}
	if stop < 0 {
		stop = n + stop
	}
	stop = min(stop, n-1)
	if start > stop {
		return []string{}, nil
	}
	return append([]string(nil), e.list[start:stop+1]...), nil
}

func (s *Store) LLen(key string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, err := s.typed(key, kindList)
	if err != nil || e == nil {
		return 0, err
	}
	return len(e.list), nil
}

// ---- hashes -----------------------------------------------------------------------

// HSet sets field/value pairs and returns how many fields were new.
func (s *Store) HSet(key string, pairs ...string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, err := s.typed(key, kindHash)
	if err != nil {
		return 0, err
	}
	if e == nil {
		e = &entry{kind: kindHash, hash: map[string]string{}}
		s.data[key] = e
	}
	added := 0
	for i := 0; i+1 < len(pairs); i += 2 {
		if _, ok := e.hash[pairs[i]]; !ok {
			added++
		}
		e.hash[pairs[i]] = pairs[i+1]
	}
	return added, nil
}

func (s *Store) HGet(key, field string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, err := s.typed(key, kindHash)
	if err != nil || e == nil {
		return "", false, err
	}
	v, ok := e.hash[field]
	return v, ok, nil
}

func (s *Store) HDel(key string, fields ...string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, err := s.typed(key, kindHash)
	if err != nil || e == nil {
		return 0, err
	}
	n := 0
	for _, f := range fields {
		if _, ok := e.hash[f]; ok {
			delete(e.hash, f)
			n++
		}
	}
	if len(e.hash) == 0 {
		s.remove(key)
	}
	return n, nil
}

// HGetAll returns field, value, field, value … sorted by field for stable output.
func (s *Store) HGetAll(key string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, err := s.typed(key, kindHash)
	if err != nil || e == nil {
		return []string{}, err
	}
	fields := make([]string, 0, len(e.hash))
	for f := range e.hash {
		fields = append(fields, f)
	}
	sort.Strings(fields)
	out := make([]string, 0, 2*len(fields))
	for _, f := range fields {
		out = append(out, f, e.hash[f])
	}
	return out, nil
}
