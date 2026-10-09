// Package server accepts TCP connections, runs commands against the store
// and keeps an append-only file (AOF) so data survives restarts.
package server

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/Sumitrcs/tinyredis/resp"
	"github.com/Sumitrcs/tinyredis/store"
)

type Config struct {
	Addr       string
	AOFPath    string // empty disables persistence
	FsyncEvery bool   // fsync after every write (slow, safest); otherwise once per second
	Logger     *log.Logger
	Now        func() time.Time
}

type Server struct {
	cfg   Config
	store *store.Store
	now   func() time.Time

	aofMu  sync.Mutex
	aof    *os.File
	aofBuf *bufio.Writer

	ln   net.Listener
	quit chan struct{}
	once sync.Once
}

func New(cfg Config) (*Server, error) {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = log.New(io.Discard, "", 0)
	}
	s := &Server{cfg: cfg, store: store.NewWithClock(cfg.Now), now: cfg.Now, quit: make(chan struct{})}
	if cfg.AOFPath != "" {
		n, err := s.replayAOF()
		if err != nil {
			return nil, fmt.Errorf("loading %s: %w", cfg.AOFPath, err)
		}
		cfg.Logger.Printf("loaded %d commands from %s", n, cfg.AOFPath)
		f, err := os.OpenFile(cfg.AOFPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			return nil, err
		}
		s.aof, s.aofBuf = f, bufio.NewWriter(f)
	}
	return s, nil
}

// replayAOF re-executes every logged command. A torn last command (power cut
// mid-write) is ignored, the same way Redis' "aof-load-truncated" works.
func (s *Server) replayAOF() (int, error) {
	f, err := os.Open(s.cfg.AOFPath)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	defer f.Close()
	r := resp.NewReader(f)
	discard := resp.NewWriter(io.Discard)
	n := 0
	for {
		args, err := r.ReadCommand()
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return n, nil
		}
		if err != nil {
			return n, err
		}
		if _, err := s.exec(args, discard, false); err != nil {
			return n, fmt.Errorf("command %d (%s): %w", n+1, args[0], err)
		}
		n++
	}
}

// ListenAndServe blocks until Close is called.
func (s *Server) ListenAndServe() error {
	if err := s.Listen(); err != nil {
		return err
	}
	return s.Serve()
}

// Listen binds the address. Splitting it from Serve lets callers learn the
// real port (with Addr ":0") before connections are accepted.
func (s *Server) Listen() error {
	ln, err := net.Listen("tcp", s.cfg.Addr)
	if err != nil {
		return err
	}
	s.ln = ln
	return nil
}

// Serve accepts connections on the listener opened by Listen.
func (s *Server) Serve() error {
	ln := s.ln
	s.cfg.Logger.Printf("tinyredis ready on %s", ln.Addr())
	go s.background()
	for {
		c, err := ln.Accept()
		if err != nil {
			select {
			case <-s.quit:
				return nil
			default:
				return err
			}
		}
		go s.handle(c)
	}
}

// background runs the active expiry sweep (10× per second, like Redis'
// default hz) and flushes the AOF once per second.
func (s *Server) background() {
	sweep := time.NewTicker(100 * time.Millisecond)
	flush := time.NewTicker(time.Second)
	defer sweep.Stop()
	defer flush.Stop()
	for {
		select {
		case <-s.quit:
			return
		case <-sweep.C:
			s.store.SweepExpired(20)
		case <-flush.C:
			s.syncAOF()
		}
	}
}

func (s *Server) handle(c net.Conn) {
	defer c.Close()
	r := resp.NewReader(c)
	w := resp.NewWriter(c)
	for {
		args, err := r.ReadCommand()
		if err != nil {
			if errors.Is(err, resp.ErrProtocol) {
				w.Error("ERR " + err.Error())
				w.Flush()
			}
			return
		}
		if len(args) == 0 {
			continue
		}
		if strings.EqualFold(args[0], "QUIT") {
			w.Simple("OK")
			w.Flush()
			return
		}
		if _, err := s.exec(args, w, true); err != nil {
			w.Error(err.Error())
		}
		// Pipelining: only hit the network once all queued commands are answered.
		if r.Buffered() == 0 {
			if err := w.Flush(); err != nil {
				return
			}
		}
	}
}

// exec runs one command, writing the reply to w. persist=false is used while
// replaying the AOF so replayed commands are not logged a second time.
func (s *Server) exec(args []string, w *resp.Writer, persist bool) (bool, error) {
	name := strings.ToUpper(args[0])
	cmd, ok := commands[name]
	if !ok {
		return false, fmt.Errorf("ERR unknown command '%s'", args[0])
	}
	if (cmd.arity > 0 && len(args) != cmd.arity) || (cmd.arity < 0 && len(args) < -cmd.arity) {
		return false, fmt.Errorf("ERR wrong number of arguments for '%s' command", strings.ToLower(name))
	}
	args[0] = name
	logged, err := cmd.run(s, args, w)
	if err != nil {
		return false, err
	}
	if persist && cmd.write && len(logged) > 0 {
		s.appendAOF(logged)
	}
	return true, nil
}

func (s *Server) appendAOF(cmds [][]string) {
	if s.aof == nil {
		return
	}
	s.aofMu.Lock()
	defer s.aofMu.Unlock()
	for _, c := range cmds {
		s.aofBuf.Write(resp.EncodeCommand(c))
	}
	if s.cfg.FsyncEvery {
		s.aofBuf.Flush()
		s.aof.Sync()
	}
}

func (s *Server) syncAOF() {
	if s.aof == nil {
		return
	}
	s.aofMu.Lock()
	defer s.aofMu.Unlock()
	s.aofBuf.Flush()
	s.aof.Sync()
}

func (s *Server) Addr() net.Addr { return s.ln.Addr() }

// Close stops accepting connections and flushes the AOF to disk.
func (s *Server) Close() error {
	s.once.Do(func() {
		close(s.quit)
		if s.ln != nil {
			s.ln.Close()
		}
	})
	s.syncAOF()
	if s.aof != nil {
		return s.aof.Close()
	}
	return nil
}
