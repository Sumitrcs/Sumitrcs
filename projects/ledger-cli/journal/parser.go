package journal

import (
	"bufio"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"
	"time"
)

var (
	headerRe  = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})\s+(?:([*!])\s+)?(.*)$`)
	accountRe = regexp.MustCompile(`^[A-Z][\w-]*(:[\w-]+)*$`)
	// Two or more spaces (or a tab) separate an account from its amount.
	postingSplit = regexp.MustCompile(`\s{2,}|\t`)
)

// Parse reads a journal, validates every transaction and checks balance assertions.
func Parse(r io.Reader) (*Journal, error) {
	j := &Journal{Declared: map[string]bool{}}
	sc := bufio.NewScanner(r)
	var cur *Transaction
	lineNo := 0

	flush := func() error {
		if cur == nil {
			return nil
		}
		if err := finalize(cur); err != nil {
			return err
		}
		j.Transactions = append(j.Transactions, *cur)
		cur = nil
		return nil
	}

	for sc.Scan() {
		lineNo++
		raw := sc.Text()
		line := strings.TrimRight(raw, " \t")
		trimmed := strings.TrimSpace(line)

		switch {
		case trimmed == "" || strings.HasPrefix(trimmed, ";") || strings.HasPrefix(trimmed, "#"):
			if trimmed == "" {
				if err := flush(); err != nil {
					return nil, err
				}
			}
			continue

		case strings.HasPrefix(line, "account "):
			if err := flush(); err != nil {
				return nil, err
			}
			name := strings.TrimSpace(strings.TrimPrefix(line, "account "))
			if !accountRe.MatchString(name) {
				return nil, &ParseError{lineNo, "invalid account name " + name}
			}
			j.Declared[name] = true

		case line[0] != ' ' && line[0] != '\t':
			if err := flush(); err != nil {
				return nil, err
			}
			m := headerRe.FindStringSubmatch(line)
			if m == nil {
				return nil, &ParseError{lineNo, "expected 'YYYY-MM-DD [*|!] payee'"}
			}
			date, err := time.Parse("2006-01-02", m[1])
			if err != nil {
				return nil, &ParseError{lineNo, "invalid date " + m[1]}
			}
			payee, comment := splitComment(m[3])
			cur = &Transaction{Date: date, Cleared: m[2] == "*", Payee: payee, Comment: comment, Line: lineNo}

		default:
			if cur == nil {
				return nil, &ParseError{lineNo, "posting outside of a transaction"}
			}
			p, err := parsePosting(trimmed)
			if err != nil {
				return nil, &ParseError{lineNo, err.Error()}
			}
			if len(j.Declared) > 0 && !j.Declared[p.Account] {
				return nil, &ParseError{lineNo, "undeclared account " + p.Account}
			}
			cur.Postings = append(cur.Postings, p)
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if err := flush(); err != nil {
		return nil, err
	}

	// Stable sort keeps same-day transactions in file order.
	sort.SliceStable(j.Transactions, func(a, b int) bool {
		return j.Transactions[a].Date.Before(j.Transactions[b].Date)
	})
	return j, checkAssertions(j)
}

func splitComment(s string) (string, string) {
	body, comment, _ := strings.Cut(s, ";")
	return strings.TrimSpace(body), strings.TrimSpace(comment)
}

func parsePosting(s string) (Posting, error) {
	body, comment := splitComment(s)
	parts := postingSplit.Split(body, 2)
	p := Posting{Account: strings.TrimSpace(parts[0]), Comment: comment}
	if !accountRe.MatchString(p.Account) {
		return p, fmt.Errorf("invalid account %q (use Type:Sub:Sub)", p.Account)
	}
	if !isRoot(Root(p.Account)) {
		return p, fmt.Errorf("account %q must start with one of %s", p.Account, strings.Join(RootTypes, ", "))
	}
	if len(parts) == 1 {
		p.Inferred = true
		return p, nil
	}

	amountPart := strings.TrimSpace(parts[1])
	amt, assertion, hasAssert := strings.Cut(amountPart, "=")
	amt = strings.TrimSpace(amt)
	if hasAssert {
		v, err := ParseAmount(assertion)
		if err != nil {
			return p, err
		}
		p.Assertion = &v
	}
	if amt == "" {
		// "Account  = 500": amount is inferred from the other postings and
		// the resulting balance is asserted.
		p.Inferred = true
		return p, nil
	}
	v, err := ParseAmount(amt)
	if err != nil {
		return p, err
	}
	p.Amount = v
	return p, nil
}

func isRoot(r string) bool {
	for _, t := range RootTypes {
		if t == r {
			return true
		}
	}
	return false
}

func finalize(t *Transaction) error {
	if len(t.Postings) < 2 {
		return &ParseError{t.Line, "a transaction needs at least two postings"}
	}
	var sum Amount
	inferred := -1
	for i, p := range t.Postings {
		if p.Inferred {
			if inferred >= 0 {
				return &ParseError{t.Line, "only one posting may omit its amount"}
			}
			inferred = i
			continue
		}
		sum += p.Amount
	}
	if inferred >= 0 {
		t.Postings[inferred].Amount = -sum
		return nil
	}
	if sum != 0 {
		return &ParseError{t.Line, "transaction does not balance: off by " + sum.String()}
	}
	return nil
}

func checkAssertions(j *Journal) error {
	running := map[string]Amount{}
	for _, t := range j.Transactions {
		for _, p := range t.Postings {
			running[p.Account] += p.Amount
			if p.Assertion != nil && running[p.Account] != *p.Assertion {
				return &ParseError{t.Line, "balance assertion failed for " + p.Account +
					": expected " + p.Assertion.String() + ", actual " + running[p.Account].String()}
			}
		}
	}
	return nil
}
