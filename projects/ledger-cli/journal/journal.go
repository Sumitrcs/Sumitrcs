// Package journal parses plain-text double-entry journals.
//
// A journal looks like:
//
//	2026-04-01 * Opening balance
//	    Assets:Bank:HDFC        50,000.00
//	    Equity:Opening
//
//	2026-04-03 Office rent  ; April
//	    Expenses:Rent           18,000
//	    Assets:Bank:HDFC        = 32,000   ; balance assertion
//
// Every transaction must balance to zero. One posting per transaction may
// omit its amount; it is inferred.
package journal

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

type Posting struct {
	Account   string
	Amount    Amount
	Inferred  bool
	Assertion *Amount // expected running balance after this posting
	Comment   string
}

type Transaction struct {
	Date      time.Time
	Cleared   bool
	Payee     string
	Comment   string
	Postings  []Posting
	Line      int
	Narration string
}

type Journal struct {
	Transactions []Transaction
	// Declared accounts via "account Name" directives. Empty means any account is allowed.
	Declared map[string]bool
}

// RootTypes are the five top-level account classes.
var RootTypes = []string{"Assets", "Liabilities", "Equity", "Income", "Expenses"}

// Root returns the first segment of an account name.
func Root(account string) string {
	root, _, _ := strings.Cut(account, ":")
	return root
}

// Balances returns the closing balance of every account touched by txns.
func Balances(txns []Transaction) map[string]Amount {
	out := map[string]Amount{}
	for _, t := range txns {
		for _, p := range t.Postings {
			out[p.Account] += p.Amount
		}
	}
	return out
}

// Filter returns transactions dated within [from, to]. Zero values are open bounds.
func (j *Journal) Filter(from, to time.Time) []Transaction {
	var out []Transaction
	for _, t := range j.Transactions {
		if !from.IsZero() && t.Date.Before(from) {
			continue
		}
		if !to.IsZero() && t.Date.After(to) {
			continue
		}
		out = append(out, t)
	}
	return out
}

// Accounts returns every account name in sorted order.
func (j *Journal) Accounts() []string {
	seen := map[string]bool{}
	for _, t := range j.Transactions {
		for _, p := range t.Postings {
			seen[p.Account] = true
		}
	}
	names := make([]string, 0, len(seen))
	for n := range seen {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// ParseError points at the offending line.
type ParseError struct {
	Line int
	Msg  string
}

func (e *ParseError) Error() string { return fmt.Sprintf("line %d: %s", e.Line, e.Msg) }
