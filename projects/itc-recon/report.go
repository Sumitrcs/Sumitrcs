package recon

import (
	"encoding/csv"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"
)

// WriteReport prints a summary, the supplier follow-up list and every row
// that needs attention (matched rows are only counted, not listed).
func WriteReport(w io.Writer, res Result) error {
	s := res.Summary
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', tabwriter.AlignRight)
	fmt.Fprintln(w, "ITC reconciliation: purchase register vs GSTR-2B")
	fmt.Fprintln(w)
	fmt.Fprintf(tw, "ITC in your books\t₹%s\t\n", s.BooksITC)
	fmt.Fprintf(tw, "ITC reported in GSTR-2B\t₹%s\t\n", s.TwoBITC)
	fmt.Fprintf(tw, "Claimable now\t₹%s\t\n", s.Claimable)
	fmt.Fprintf(tw, "At risk (follow up)\t₹%s\t\n", s.AtRisk)
	fmt.Fprintf(tw, "In 2B, not in books\t₹%s\t\n", s.NotInBooks)
	tw.Flush()
	fmt.Fprintln(w)
	fmt.Fprintf(w, "%d matched, %d probable, %d amount mismatch, %d only in books, %d only in 2B\n",
		s.Counts[Matched], s.Counts[Probable], s.Counts[Mismatch], s.Counts[OnlyInBooks], s.Counts[OnlyIn2B])

	if len(res.FollowUp) > 0 {
		fmt.Fprintln(w, "\nSuppliers to follow up (ITC at risk):")
		for _, sup := range res.FollowUp {
			fmt.Fprintf(w, "  %-15s  %-28s %2d bill%s  ₹%s\n", sup.GSTIN, trim(sup.Party, 28), sup.Rows, plural(sup.Rows), sup.AtRisk)
		}
	}

	for _, st := range []Status{Probable, Mismatch, OnlyInBooks, OnlyIn2B} {
		var rows []Row
		for _, r := range res.Rows {
			if r.Status == st {
				rows = append(rows, r)
			}
		}
		if len(rows) == 0 {
			continue
		}
		fmt.Fprintf(w, "\n%s (%d):\n", strings.ToUpper(st.String()[:1])+st.String()[1:], len(rows))
		for _, r := range rows {
			inv := r.invoice()
			fmt.Fprintf(w, "  %-15s  %-16s %s  tax ₹%s\n      %s\n", inv.GSTIN, inv.Number, inv.Date.Format("02-01-2006"), inv.Tax(), r.Note)
		}
	}
	if len(res.Duplicates) > 0 {
		fmt.Fprintln(w, "\nEntered twice in your books (only one can be claimed):")
		for _, d := range res.Duplicates {
			fmt.Fprintf(w, "  line %d: %s %s\n", d.Line, d.GSTIN, d.Number)
		}
	}
	if len(res.InvalidGSTINs) > 0 {
		fmt.Fprintln(w, "\nInvalid GSTINs in your books (typing mistake?):")
		for _, d := range res.InvalidGSTINs {
			fmt.Fprintf(w, "  line %d: %q (%s)\n", d.Line, d.GSTIN, d.Party)
		}
	}
	return nil
}

// WriteCSV writes every row with both sides' figures, for Excel.
func WriteCSV(w io.Writer, res Result) error {
	cw := csv.NewWriter(w)
	cw.Write([]string{"status", "gstin", "party", "books_invoice", "books_date", "books_taxable", "books_tax",
		"2b_invoice", "2b_date", "2b_taxable", "2b_tax", "itc_available", "claimable", "note"})
	side := func(inv *Invoice) []string {
		if inv == nil {
			return []string{"", "", "", ""}
		}
		return []string{inv.Number, inv.Date.Format("02-01-2006"), plain(inv.Taxable), plain(inv.Tax())}
	}
	for _, r := range res.Rows {
		inv := r.invoice()
		itc := ""
		if r.TwoB != nil {
			itc = map[bool]string{true: "Y", false: "N"}[r.TwoB.ITCAvailable]
		}
		row := append([]string{r.Status.String(), inv.GSTIN, inv.Party}, side(r.Books)...)
		row = append(row, side(r.TwoB)...)
		row = append(row, itc, plain(r.Claimable()), r.Note)
		cw.Write(row)
	}
	cw.Flush()
	return cw.Error()
}

// plain is an amount without grouping commas, so spreadsheets read it as a number.
func plain(p Paise) string { return strings.ReplaceAll(p.String(), ",", "") }

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func trim(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}
