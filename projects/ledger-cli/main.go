// Command ledger is a plain-text double-entry accounting tool.
//
//	ledger -f books.journal balance [prefix]
//	ledger -f books.journal register [prefix]
//	ledger -f books.journal trial
//	ledger -f books.journal pnl --from 2026-04-01 --to 2027-03-31
//	ledger -f books.journal bs
//	ledger -f books.journal check
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/Sumitrcs/ledger-cli/journal"
	"github.com/Sumitrcs/ledger-cli/report"
)

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "ledger:", err)
		os.Exit(1)
	}
}

func run(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("ledger", flag.ContinueOnError)
	file := fs.String("f", os.Getenv("LEDGER_FILE"), "journal file (or set LEDGER_FILE)")
	fromS := fs.String("from", "", "start date YYYY-MM-DD (inclusive)")
	toS := fs.String("to", "", "end date YYYY-MM-DD (inclusive)")
	fs.Usage = func() {
		fmt.Fprintln(fs.Output(), "usage: ledger -f FILE [--from DATE] [--to DATE] balance|register|trial|pnl|bs|check [account-prefix]")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	rest := fs.Args()
	if len(rest) == 0 {
		fs.Usage()
		return errors.New("missing command")
	}
	// Allow flags after the command too: "ledger -f x pnl --from 2026-04-01"
	cmd := rest[0]
	if err := fs.Parse(rest[1:]); err != nil {
		return err
	}
	prefix := fs.Arg(0)

	if *file == "" {
		return errors.New("no journal file: pass -f or set LEDGER_FILE")
	}
	f, err := os.Open(*file)
	if err != nil {
		return err
	}
	defer f.Close()

	j, err := journal.Parse(f)
	if err != nil {
		return err
	}

	from, err := parseDate(*fromS)
	if err != nil {
		return err
	}
	to, err := parseDate(*toS)
	if err != nil {
		return err
	}
	txns := j.Filter(from, to)

	switch cmd {
	case "balance", "bal":
		report.Balance(out, txns, prefix)
	case "register", "reg":
		report.Register(out, txns, prefix)
	case "trial":
		report.PrintTrial(out, txns)
	case "pnl", "is":
		report.PrintIncomeStatement(out, txns)
	case "bs":
		// Balance sheet is a point-in-time view: ignore --from.
		return report.PrintBalanceSheet(out, j.Filter(time.Time{}, to))
	case "check":
		fmt.Fprintf(out, "OK: %d transactions, %d accounts, all balanced\n", len(j.Transactions), len(j.Accounts()))
	default:
		return fmt.Errorf("unknown command %q", cmd)
	}
	return nil
}

func parseDate(s string) (time.Time, error) {
	if s == "" {
		return time.Time{}, nil
	}
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		return t, fmt.Errorf("bad date %q, want YYYY-MM-DD", s)
	}
	return t, nil
}
