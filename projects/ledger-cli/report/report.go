// Package report renders accounting statements from a parsed journal.
package report

import (
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/Sumitrcs/ledger-cli/journal"
)

// node is one level in the account hierarchy.
type node struct {
	name     string
	own      journal.Amount
	total    journal.Amount
	children map[string]*node
}

func newNode(name string) *node { return &node{name: name, children: map[string]*node{}} }

func buildTree(balances map[string]journal.Amount, keep func(string) bool) *node {
	root := newNode("")
	for acct, amt := range balances {
		if amt == 0 || !keep(acct) {
			continue
		}
		n := root
		n.total += amt
		for _, seg := range strings.Split(acct, ":") {
			child, ok := n.children[seg]
			if !ok {
				child = newNode(seg)
				n.children[seg] = child
			}
			child.total += amt
			n = child
		}
		n.own += amt
	}
	return root
}

func sortedChildren(n *node) []*node {
	out := make([]*node, 0, len(n.children))
	for _, c := range n.children {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}

func printTree(w io.Writer, n *node, depth int, sign journal.Amount) {
	for _, c := range sortedChildren(n) {
		// Collapse single-child chains with no own balance: Assets:Bank:HDFC on one line.
		label := c.name
		cur := c
		for len(cur.children) == 1 && cur.own == 0 {
			only := sortedChildren(cur)[0]
			label += ":" + only.name
			cur = only
		}
		fmt.Fprintf(w, "%18s  %s%s\n", (cur.total * sign).String(), strings.Repeat("  ", depth), label)
		printTree(w, cur, depth+1, sign)
	}
}

// Balance prints a hierarchical balance report for accounts matching prefix.
func Balance(w io.Writer, txns []journal.Transaction, prefix string) {
	bal := journal.Balances(txns)
	tree := buildTree(bal, func(a string) bool { return prefix == "" || strings.HasPrefix(a, prefix) })
	printTree(w, tree, 0, 1)
	fmt.Fprintln(w, strings.Repeat("-", 18))
	fmt.Fprintf(w, "%18s\n", tree.total.String())
}

// Register lists every posting to accounts matching prefix with a running total.
func Register(w io.Writer, txns []journal.Transaction, prefix string) {
	var running journal.Amount
	for _, t := range txns {
		for _, p := range t.Postings {
			if prefix != "" && !strings.HasPrefix(p.Account, prefix) {
				continue
			}
			running += p.Amount
			fmt.Fprintf(w, "%s  %-24.24s %-28.28s %14s %16s\n",
				t.Date.Format("2006-01-02"), t.Payee, p.Account, p.Amount.String(), running.String())
		}
	}
}

// TrialRow is one account line of a trial balance.
type TrialRow struct {
	Account string
	Debit   journal.Amount
	Credit  journal.Amount
}

// Trial computes a trial balance. Debits and credits always match for a valid journal.
func Trial(txns []journal.Transaction) (rows []TrialRow, debit, credit journal.Amount) {
	bal := journal.Balances(txns)
	accts := make([]string, 0, len(bal))
	for a := range bal {
		accts = append(accts, a)
	}
	sort.Strings(accts)
	for _, a := range accts {
		v := bal[a]
		switch {
		case v > 0:
			rows = append(rows, TrialRow{a, v, 0})
			debit += v
		case v < 0:
			rows = append(rows, TrialRow{a, 0, -v})
			credit += -v
		}
	}
	return rows, debit, credit
}

func PrintTrial(w io.Writer, txns []journal.Transaction) {
	rows, dr, cr := Trial(txns)
	fmt.Fprintf(w, "%-36s %16s %16s\n", "Account", "Debit", "Credit")
	fmt.Fprintln(w, strings.Repeat("=", 70))
	for _, r := range rows {
		d, c := "", ""
		if r.Debit != 0 {
			d = r.Debit.String()
		}
		if r.Credit != 0 {
			c = r.Credit.String()
		}
		fmt.Fprintf(w, "%-36.36s %16s %16s\n", r.Account, d, c)
	}
	fmt.Fprintln(w, strings.Repeat("-", 70))
	fmt.Fprintf(w, "%-36s %16s %16s\n", "Total", dr.String(), cr.String())
}

// Statement holds income-statement figures. Income is shown as a positive number.
type Statement struct {
	Income, Expenses, NetProfit journal.Amount
}

func IncomeStatement(txns []journal.Transaction) Statement {
	var s Statement
	for a, v := range journal.Balances(txns) {
		switch journal.Root(a) {
		case "Income":
			s.Income += -v
		case "Expenses":
			s.Expenses += v
		}
	}
	s.NetProfit = s.Income - s.Expenses
	return s
}

func PrintIncomeStatement(w io.Writer, txns []journal.Transaction) {
	bal := journal.Balances(txns)
	fmt.Fprintln(w, "INCOME")
	printTree(w, buildTree(bal, func(a string) bool { return journal.Root(a) == "Income" }), 1, -1)
	fmt.Fprintln(w, "EXPENSES")
	printTree(w, buildTree(bal, func(a string) bool { return journal.Root(a) == "Expenses" }), 1, 1)
	s := IncomeStatement(txns)
	fmt.Fprintln(w, strings.Repeat("-", 40))
	label := "Net profit"
	if s.NetProfit < 0 {
		label = "Net loss"
	}
	fmt.Fprintf(w, "%18s  %s\n", s.NetProfit.String(), label)
}

// PrintBalanceSheet shows Assets = Liabilities + Equity, with current-period
// profit rolled into equity as retained earnings.
func PrintBalanceSheet(w io.Writer, txns []journal.Transaction) error {
	bal := journal.Balances(txns)
	var assets, liabilities, equity journal.Amount
	for a, v := range bal {
		switch journal.Root(a) {
		case "Assets":
			assets += v
		case "Liabilities":
			liabilities += -v
		case "Equity":
			equity += -v
		}
	}
	profit := IncomeStatement(txns).NetProfit

	fmt.Fprintln(w, "ASSETS")
	printTree(w, buildTree(bal, func(a string) bool { return journal.Root(a) == "Assets" }), 1, 1)
	fmt.Fprintf(w, "%18s  Total assets\n\n", assets.String())
	fmt.Fprintln(w, "LIABILITIES")
	printTree(w, buildTree(bal, func(a string) bool { return journal.Root(a) == "Liabilities" }), 1, -1)
	fmt.Fprintln(w, "EQUITY")
	printTree(w, buildTree(bal, func(a string) bool { return journal.Root(a) == "Equity" }), 1, -1)
	fmt.Fprintf(w, "%18s    Retained earnings (current period)\n", profit.String())
	total := liabilities + equity + profit
	fmt.Fprintf(w, "%18s  Total liabilities + equity\n", total.String())

	if total != assets {
		return fmt.Errorf("balance sheet does not tally: assets %s vs liabilities+equity %s", assets, total)
	}
	return nil
}
