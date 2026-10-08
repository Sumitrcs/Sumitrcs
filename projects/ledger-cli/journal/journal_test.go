package journal

import (
	"strings"
	"testing"
)

func TestParseAmount(t *testing.T) {
	cases := map[string]Amount{
		"0":            0,
		"12":           1200,
		"12.5":         1250,
		"-1,23,456.78": -12345678,
		"₹ 99.99":      9999,
		"INR 10":       1000,
		"+3.05":        305,
	}
	for in, want := range cases {
		got, err := ParseAmount(in)
		if err != nil || got != want {
			t.Errorf("ParseAmount(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "abc", "1.234", "1.", "--5"} {
		if _, err := ParseAmount(bad); err == nil {
			t.Errorf("ParseAmount(%q) should fail", bad)
		}
	}
}

func TestAmountString(t *testing.T) {
	cases := map[Amount]string{
		0:          "0.00",
		5:          "0.05",
		99999:      "999.99",
		100000:     "1,000.00",
		12345678:   "1,23,456.78",
		-123456789: "-12,34,567.89",
	}
	for in, want := range cases {
		if got := in.String(); got != want {
			t.Errorf("%d.String() = %q; want %q", int64(in), got, want)
		}
	}
}

func TestParseInfersMissingAmount(t *testing.T) {
	j, err := Parse(strings.NewReader(`
2026-04-01 * Salary
    Assets:Bank      50,000
    Income:Salary
`))
	if err != nil {
		t.Fatal(err)
	}
	p := j.Transactions[0].Postings[1]
	if !p.Inferred || p.Amount != -5000000 {
		t.Fatalf("inferred posting = %+v", p)
	}
}

func TestParseRejectsUnbalanced(t *testing.T) {
	_, err := Parse(strings.NewReader(`
2026-04-01 Oops
    Assets:Bank      100
    Income:Salary   -99
`))
	if err == nil || !strings.Contains(err.Error(), "off by 1.00") {
		t.Fatalf("want unbalanced error, got %v", err)
	}
}

func TestParseErrorsHaveLineNumbers(t *testing.T) {
	_, err := Parse(strings.NewReader("2026-04-01 ok\n    Assets:Bank  1\n    Expenses:X\n\n2026-13-01 bad\n    Assets:Bank 1\n"))
	pe, ok := err.(*ParseError)
	if !ok || pe.Line != 5 {
		t.Fatalf("want ParseError on line 5, got %v", err)
	}
}

func TestBalanceAssertions(t *testing.T) {
	ok := `
2026-04-01 Open
    Assets:Bank   1,000
    Equity:Open
2026-04-02 Spend
    Expenses:Food   250
    Assets:Bank     = 750
`
	j, err := Parse(strings.NewReader(ok))
	if err != nil {
		t.Fatal(err)
	}
	if got := Balances(j.Transactions)["Assets:Bank"]; got != 75000 {
		t.Fatalf("bank = %s", got)
	}
	bad := strings.Replace(ok, "= 750", "-250 = 700", 1)
	if _, err := Parse(strings.NewReader(bad)); err == nil || !strings.Contains(err.Error(), "assertion failed") {
		t.Fatalf("want assertion failure, got %v", err)
	}
}

func TestTransactionsSortedByDateStable(t *testing.T) {
	j, err := Parse(strings.NewReader(`
2026-04-05 B
    Assets:A  1
    Equity:E
2026-04-01 A
    Assets:A  1
    Equity:E
2026-04-05 C
    Assets:A  1
    Equity:E
`))
	if err != nil {
		t.Fatal(err)
	}
	var order string
	for _, tx := range j.Transactions {
		order += tx.Payee
	}
	if order != "ABC" {
		t.Fatalf("order = %s", order)
	}
}

func TestDeclaredAccountsAreEnforced(t *testing.T) {
	_, err := Parse(strings.NewReader(`account Assets:Bank
account Equity:Open

2026-04-01 Typo
    Assets:Bnak   10
    Equity:Open
`))
	if err == nil || !strings.Contains(err.Error(), "undeclared account Assets:Bnak") {
		t.Fatalf("want undeclared account error, got %v", err)
	}
}

func TestRejectsBadRootAndDoubleInference(t *testing.T) {
	if _, err := Parse(strings.NewReader("2026-04-01 x\n    Stuff:Here  1\n    Equity:E\n")); err == nil {
		t.Error("expected invalid root error")
	}
	if _, err := Parse(strings.NewReader("2026-04-01 x\n    Assets:A\n    Equity:E\n")); err == nil {
		t.Error("expected double inference error")
	}
}
