// Command tinyredis is a small Redis-compatible server.
//
//	tinyredis -addr :6380 -aof appendonly.aof
//	redis-cli -p 6380 SET greeting "namaste"
package main

import (
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/Sumitrcs/tinyredis/server"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:6380", "address to listen on")
	aof := flag.String("aof", "appendonly.aof", "append-only file (empty to disable persistence)")
	always := flag.Bool("fsync-always", false, "fsync after every write instead of once per second")
	flag.Parse()

	logger := log.New(os.Stderr, "tinyredis ", log.LstdFlags)
	srv, err := server.New(server.Config{Addr: *addr, AOFPath: *aof, FsyncEvery: *always, Logger: logger})
	if err != nil {
		logger.Fatal(err)
	}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	select {
	case err := <-errc:
		logger.Fatal(err)
	case <-sig:
	}
	// Close flushes the AOF; main must not return before it finishes.
	logger.Print("shutting down")
	if err := srv.Close(); err != nil {
		logger.Fatal(err)
	}
}
