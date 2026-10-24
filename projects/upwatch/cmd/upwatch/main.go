// Command upwatch monitors websites and serves a status page.
//
//	upwatch -config upwatch.json          watch forever and serve the status page
//	upwatch -config upwatch.json -once    check everything once and exit (for cron or CI)
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/Sumitrcs/upwatch"
)

func main() {
	configPath := flag.String("config", "upwatch.json", "config file")
	listen := flag.String("listen", "", "address for the status page (overrides the config), e.g. :8080")
	once := flag.Bool("once", false, "check everything once, print the results and exit (status 1 if anything is down)")
	flag.Parse()

	cfg, err := upwatch.LoadConfig(*configPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "upwatch:", err)
		os.Exit(2)
	}
	if *listen != "" {
		cfg.Listen = *listen
	}
	if *once {
		os.Exit(checkOnce(cfg))
	}
	if err := serve(cfg); err != nil {
		log.Fatal(err)
	}
}

func checkOnce(cfg *upwatch.Config) int {
	m := upwatch.NewMonitor(cfg.Checks)
	results := make([]upwatch.Result, len(cfg.Checks))
	done := make(chan struct{})
	for i, c := range cfg.Checks {
		go func() {
			results[i] = upwatch.Probe(context.Background(), m.Client, c)
			done <- struct{}{}
		}()
	}
	for range cfg.Checks {
		<-done
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	failed := 0
	for i, c := range cfg.Checks {
		r := results[i]
		state, detail := "UP", fmt.Sprintf("%d", r.Status)
		if !r.OK {
			state, detail = "DOWN", r.Error
			failed++
		}
		fmt.Fprintf(w, "%s\t%s\t%d ms\t%s\n", state, c.Name, r.Latency.Milliseconds(), detail)
	}
	w.Flush()
	if failed > 0 {
		return 1
	}
	return 0
}

func serve(cfg *upwatch.Config) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	m := upwatch.NewMonitor(cfg.Checks)
	if cfg.DataFile != "" {
		n, err := upwatch.LoadHistory(cfg.DataFile, m)
		if err != nil {
			return err
		}
		log.Printf("loaded %d earlier results from %s", n, cfg.DataFile)
		store, err := upwatch.OpenStore(cfg.DataFile)
		if err != nil {
			return err
		}
		defer store.Close()
		m.OnResult = func(name string, r upwatch.Result) {
			if err := store.Append(name, r); err != nil {
				log.Printf("saving a result: %v", err)
			}
		}
	}
	m.OnChange = func(e upwatch.Event) {
		upwatch.LogChanges(e)
		if cfg.Webhook != "" {
			go func() {
				if err := upwatch.SendWebhook(ctx, m.Client, cfg.Webhook, e); err != nil {
					log.Printf("webhook: %v", err)
				}
			}()
		}
	}

	srv := &http.Server{Addr: cfg.Listen, Handler: upwatch.Handler(m, cfg.Title), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(shutdown)
	}()
	go m.Run(ctx)
	host := cfg.Listen
	if strings.HasPrefix(host, ":") {
		host = "localhost" + host
	}
	log.Printf("watching %d checks; status page on http://%s/", len(cfg.Checks), host)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	log.Print("stopped")
	return nil
}
