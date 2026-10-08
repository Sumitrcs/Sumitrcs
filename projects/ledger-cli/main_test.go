package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestRunCommands(t *testing.T) {
	for _, cmd := range [][]string{
		{"check"}, {"balance"}, {"balance", "Expenses"}, {"register", "Assets"},
		{"trial"}, {"pnl", "--from", "2026-04-01", "--to", "2026-04-30"}, {"bs"},
	} {
		var out bytes.Buffer
		args := append([]string{"-f", "examples/books.journal"}, cmd...)
		if err := run(args, &out); err != nil {
			t.Errorf("%v: %v", cmd, err)
		}
		if out.Len() == 0 {
			t.Errorf("%v: no output", cmd)
		}
	}
}

func TestDateFilter(t *testing.T) {
	var out bytes.Buffer
	if err := run([]string{"-f", "examples/books.journal", "--to", "2026-04-04", "pnl"}, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "-18,000.00  Net loss") {
		t.Fatalf("expected only rent before 04-05:\n%s", out.String())
	}
}

func TestUnknownCommand(t *testing.T) {
	if err := run([]string{"-f", "examples/books.journal", "nope"}, &bytes.Buffer{}); err == nil {
		t.Fatal("expected error")
	}
}
