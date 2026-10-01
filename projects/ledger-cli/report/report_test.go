package report

import (
	"bytes"
	"os"
	"strings"
	"testing"

	"github.com/Sumitrcs/ledger-cli/journal"
)

func loadSample(t *testing.T) *journal.Journal {
	t.Helper()
	f, err := os.Open("../examples/books.journal")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	j, err := journal.Parse(f)
	if err != nil {
		t.Fatal(err)
	}
	return j
}

func TestTrialBalanceTallies(t *testing.T) {
	_, dr, cr := Trial(loadSample(t).Transactions)
	if dr != cr || dr == 0 {
		t.Fatalf("debit %s != credit %s", dr, cr)
	}
}

func TestIncomeStatement(t *testing.T) {
	s := IncomeStatement(loadSample(t).Transactions)
	if s.Income.String() != "60,000.00" || s.Expenses.String() != "23,889.50" || s.NetProfit.String() != "36,110.50" {
		t.Fatalf("got %+v", s)
	}
}

func TestBalanceSheetTallies(t *testing.T) {
	var buf bytes.Buffer
	if err := PrintBalanceSheet(&buf, loadSample(t).Transactions); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), "Retained earnings") {
		t.Fatal("missing retained earnings line")
	}
}

func TestBalanceTreeCollapsesChains(t *testing.T) {
	var buf bytes.Buffer
	Balance(&buf, loadSample(t).Transactions, "Liabilities")
	out := buf.String()
	if !strings.Contains(out, "GST:Output") {
		t.Fatalf("expected collapsed GST:Output line:\n%s", out)
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "-15,050.50") {
		t.Fatalf("unexpected total:\n%s", out)
	}
}

func TestRegisterRunningTotal(t *testing.T) {
	var buf bytes.Buffer
	Register(&buf, loadSample(t).Transactions, "Assets:Bank")
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if !strings.HasSuffix(lines[len(lines)-1], "2,46,801.00") {
		t.Fatalf("last line: %q", lines[len(lines)-1])
	}
}
