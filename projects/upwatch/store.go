package upwatch

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"sync"
)

// Store saves results as JSON Lines: one small JSON object per line,
// appended as they happen. Appending is cheap and crash-friendly: a crash
// can at worst cut off the last line, which Load skips.
type Store struct {
	mu   sync.Mutex
	file *os.File
}

type storedResult struct {
	Check string `json:"check"`
	Result
}

func OpenStore(path string) (*Store, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	return &Store{file: f}, nil
}

func (s *Store) Append(check string, r Result) error {
	line, err := json.Marshal(storedResult{check, r})
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err = s.file.Write(append(line, '\n'))
	return err
}

func (s *Store) Close() error { return s.file.Close() }

// LoadHistory replays a saved history into the monitor, so the status page
// and incident list survive a restart. Results for checks that are no
// longer configured are ignored. Returns the number of results loaded.
func LoadHistory(path string, m *Monitor) (int, error) {
	f, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	defer f.Close()
	onChange, onResult := m.OnChange, m.OnResult
	m.OnChange, m.OnResult = nil, nil // replaying old results must not send alerts again
	defer func() { m.OnChange, m.OnResult = onChange, onResult }()

	n, line := 0, 0
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line++
		var sr storedResult
		if err := json.Unmarshal(sc.Bytes(), &sr); err != nil {
			continue // a line cut off by a crash
		}
		if m.Has(sr.Check) {
			m.Record(sr.Check, sr.Result)
			n++
		}
	}
	if err := sc.Err(); err != nil {
		return n, fmt.Errorf("%s line %d: %w", path, line, err)
	}
	return n, nil
}
