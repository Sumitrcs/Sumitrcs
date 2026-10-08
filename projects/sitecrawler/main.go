// Command sitecrawler crawls a website politely and reports broken links,
// slow pages and a sitemap.
//
//	sitecrawler -depth 3 -max 500 -c 8 -delay 250ms -sitemap sitemap.xml -jsonl pages.jsonl https://example.com
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"time"

	"github.com/Sumitrcs/sitecrawler/crawler"
)

func main() {
	depth := flag.Int("depth", 3, "maximum link depth from the start page")
	maxPages := flag.Int("max", 500, "maximum number of URLs to fetch (0 = unlimited)")
	conc := flag.Int("c", 8, "concurrent requests")
	delay := flag.Duration("delay", 250*time.Millisecond, "minimum delay between requests to the same host")
	timeout := flag.Duration("timeout", 15*time.Second, "per-request timeout")
	external := flag.Bool("external", false, "also crawl other hosts")
	ignoreRobots := flag.Bool("ignore-robots", false, "do not honour robots.txt (only for sites you own)")
	jsonl := flag.String("jsonl", "", "write one JSON object per page to this file")
	sitemap := flag.String("sitemap", "", "write a sitemap.xml to this file")
	quiet := flag.Bool("q", false, "don't print each page as it is crawled")
	flag.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "usage: sitecrawler [flags] URL...\n\n")
		flag.PrintDefaults()
	}
	flag.Parse()
	if flag.NArg() == 0 {
		flag.Usage()
		os.Exit(2)
	}

	c, err := crawler.New(crawler.Config{
		Start: flag.Args(), MaxDepth: *depth, MaxPages: *maxPages, Concurrency: *conc,
		Delay: *delay, Timeout: *timeout, SameHost: !*external, RespectRobots: !*ignoreRobots,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	var enc *json.Encoder
	if *jsonl != "" {
		f, err := os.Create(*jsonl)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		defer f.Close()
		enc = json.NewEncoder(f)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	report := &crawler.Report{Started: time.Now()}
	c.Run(ctx, func(p crawler.Page) {
		report.Add(p)
		if enc != nil {
			enc.Encode(p)
		}
		if !*quiet {
			status := fmt.Sprint(p.Status)
			switch {
			case p.Blocked:
				status = "BLK"
			case p.Error != "":
				status = "ERR"
			}
			fmt.Printf("%-4s d=%d %6s  %s\n", status, p.Depth, p.Duration.Round(time.Millisecond), p.URL)
		}
	})
	if ctx.Err() != nil {
		fmt.Println("\ninterrupted — partial results below")
	}
	report.Write(os.Stdout)

	if *sitemap != "" {
		f, err := os.Create(*sitemap)
		if err == nil {
			err = report.WriteSitemap(f)
			f.Close()
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Printf("\nsitemap written to %s\n", *sitemap)
	}
	if len(report.Broken()) > 0 {
		os.Exit(1)
	}
}
