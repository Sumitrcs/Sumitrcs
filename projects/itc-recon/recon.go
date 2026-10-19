package recon

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// Status of one row of the reconciliation.
type Status int

const (
	Matched     Status = iota // same invoice, same amounts
	Probable                  // same supplier and amounts, invoice number written differently
	Mismatch                  // same invoice number, different amounts
	OnlyInBooks               // supplier hasn't reported it: ITC at risk, follow up
	OnlyIn2B                  // reported by supplier but not in your books
)

func (s Status) String() string {
	return [...]string{"matched", "probable", "amount mismatch", "only in books", "only in 2B"}[s]
}

type Options struct {
	// Differences up to this much are rounding, not a mismatch (default ₹1).
	Tolerance Paise
	// A probable match's dates may be this many days apart (default 7).
	DateWindowDays int
}

// Row pairs a book entry with its GSTR-2B entry (either may be nil).
type Row struct {
	Status Status
	Books  *Invoice
	TwoB   *Invoice
	Note   string
	// The problem is in your own records (a bill entered twice, a mistyped
	// GSTIN), so the supplier isn't put on the follow-up list.
	FixInBooks bool
}

// Claimable is the ITC this row supports: the lower of the two tax amounts,
// and only if GSTR-2B says ITC is available.
func (r Row) Claimable() Paise {
	if r.Books == nil || r.TwoB == nil || !r.TwoB.ITCAvailable {
		return 0
	}
	return min(r.Books.Tax(), r.TwoB.Tax())
}

type Summary struct {
	BooksITC      Paise // tax on all purchase bills
	TwoBITC       Paise // tax on everything suppliers reported
	Claimable     Paise
	AtRisk        Paise // in books but not claimable (missing, short, or blocked)
	NotInBooks    Paise // in 2B but not recorded
	Counts        map[Status]int
	BlockedInTwoB int
}

type Supplier struct {
	GSTIN, Party string
	Rows         int
	AtRisk       Paise
}

type Result struct {
	Rows          []Row
	Summary       Summary
	InvalidGSTINs []Invoice // book entries whose GSTIN fails the checksum
	Duplicates    []Invoice // the same supplier + invoice number twice in the books
	FollowUp      []Supplier
}

func key(inv *Invoice) string { return inv.GSTIN + "|" + NormalizeNumber(inv.Number) }

func abs(p Paise) Paise {
	if p < 0 {
		return -p
	}
	return p
}

// Reconcile matches the purchase register (books) against GSTR-2B.
func Reconcile(books, twoB []Invoice, opt Options) Result {
	if opt.Tolerance == 0 {
		opt.Tolerance = 100
	}
	if opt.DateWindowDays == 0 {
		opt.DateWindowDays = 7
	}
	var res Result
	usedBooks := make([]bool, len(books))
	usedTwoB := make([]bool, len(twoB))

	firstLine := map[string]int{}
	duplicateOf := map[int]int{} // book index → line of the first entry
	for i := range books {
		if !ValidGSTIN(books[i].GSTIN) {
			res.InvalidGSTINs = append(res.InvalidGSTINs, books[i])
		}
		k := key(&books[i])
		if line, ok := firstLine[k]; ok {
			res.Duplicates = append(res.Duplicates, books[i])
			duplicateOf[i] = line
		} else {
			firstLine[k] = books[i].Line
		}
	}

	// Pass 1: same supplier and the same invoice number (after normalising).
	byKey := map[string][]int{}
	for j := range twoB {
		byKey[key(&twoB[j])] = append(byKey[key(&twoB[j])], j)
	}
	for i := range books {
		for _, j := range byKey[key(&books[i])] {
			if usedTwoB[j] {
				continue
			}
			usedBooks[i], usedTwoB[j] = true, true
			res.Rows = append(res.Rows, compare(&books[i], &twoB[j], opt))
			break
		}
	}

	// Pass 2: same supplier, same amounts, close dates, and an invoice number
	// only a typo or two away. Best candidates (fewest edits, closest dates) first.
	type cand struct {
		i, j, score int
	}
	var cands []cand
	for i := range books {
		if usedBooks[i] {
			continue
		}
		a := NormalizeNumber(books[i].Number)
		for j := range twoB {
			if usedTwoB[j] || twoB[j].GSTIN != books[i].GSTIN {
				continue
			}
			if abs(books[i].Taxable-twoB[j].Taxable) > opt.Tolerance || abs(books[i].Tax()-twoB[j].Tax()) > opt.Tolerance {
				continue
			}
			days := int(books[i].Date.Sub(twoB[j].Date).Abs() / (24 * time.Hour))
			if days > opt.DateWindowDays {
				continue
			}
			b := NormalizeNumber(twoB[j].Number)
			edits := Levenshtein(a, b)
			if edits > 2 && !strings.Contains(a, b) && !strings.Contains(b, a) {
				continue
			}
			cands = append(cands, cand{i, j, edits*100 + days})
		}
	}
	sort.Slice(cands, func(x, y int) bool {
		if cands[x].score != cands[y].score {
			return cands[x].score < cands[y].score
		}
		return cands[x].i < cands[y].i
	})
	for _, c := range cands {
		if usedBooks[c.i] || usedTwoB[c.j] {
			continue
		}
		usedBooks[c.i], usedTwoB[c.j] = true, true
		row := compare(&books[c.i], &twoB[c.j], opt)
		row.Status = Probable
		row.Note = "invoice number differs: " + books[c.i].Number + " vs " + twoB[c.j].Number
		if !twoB[c.j].ITCAvailable {
			row.Note += "; ITC not available as per 2B"
		}
		res.Rows = append(res.Rows, row)
	}

	// What's left is missing on one side.
	for i := range books {
		if usedBooks[i] {
			continue
		}
		row := Row{Status: OnlyInBooks, Books: &books[i], Note: "not in GSTR-2B: ask the supplier to file"}
		if line, dup := duplicateOf[i]; dup {
			row.FixInBooks = true
			row.Note = fmt.Sprintf("entered twice: same bill as line %d of your books", line)
		} else if j := typoGSTIN(&books[i], twoB, usedTwoB); j >= 0 {
			row.FixInBooks = true
			row.Note = fmt.Sprintf("GSTIN looks mistyped: 2B has the same bill under %s", twoB[j].GSTIN)
		}
		res.Rows = append(res.Rows, row)
	}
	for j := range twoB {
		if !usedTwoB[j] {
			res.Rows = append(res.Rows, Row{Status: OnlyIn2B, TwoB: &twoB[j], Note: "not in your books: record it, or check it's really yours"})
		}
	}
	summarise(&res, books, twoB)
	return res
}

// typoGSTIN finds an unmatched 2B invoice with the same number and amounts
// whose GSTIN is one or two characters away: almost certainly a typing slip
// in the books. Returns its index, or -1.
func typoGSTIN(b *Invoice, twoB []Invoice, used []bool) int {
	for j := range twoB {
		t := &twoB[j]
		if !used[j] && NormalizeNumber(t.Number) == NormalizeNumber(b.Number) && t.Taxable == b.Taxable &&
			t.GSTIN != b.GSTIN && Levenshtein(t.GSTIN, b.GSTIN) <= 2 {
			return j
		}
	}
	return -1
}

// compare decides between Matched and Mismatch for two invoices with the same key.
func compare(b, t *Invoice, opt Options) Row {
	row := Row{Status: Matched, Books: b, TwoB: t}
	var diffs []string
	if d := t.Taxable - b.Taxable; abs(d) > opt.Tolerance {
		diffs = append(diffs, "taxable "+signed(d))
	}
	if d := t.Tax() - b.Tax(); abs(d) > opt.Tolerance {
		diffs = append(diffs, "tax "+signed(d))
	}
	if len(diffs) > 0 {
		row.Status = Mismatch
		row.Note = "2B differs from books: " + strings.Join(diffs, ", ")
	}
	if !t.ITCAvailable {
		if row.Note != "" {
			row.Note += "; "
		}
		row.Note += "ITC not available as per 2B"
	}
	return row
}

func signed(p Paise) string {
	if p > 0 {
		return "+" + p.String()
	}
	return p.String()
}

func summarise(res *Result, books, twoB []Invoice) {
	s := &res.Summary
	s.Counts = map[Status]int{}
	for _, b := range books {
		s.BooksITC += b.Tax()
	}
	for _, t := range twoB {
		s.TwoBITC += t.Tax()
		if !t.ITCAvailable {
			s.BlockedInTwoB++
		}
	}
	suppliers := map[string]*Supplier{}
	for _, r := range res.Rows {
		s.Counts[r.Status]++
		s.Claimable += r.Claimable()
		if r.Books != nil {
			risk := r.Books.Tax() - r.Claimable()
			s.AtRisk += risk
			if risk > 0 && !r.FixInBooks {
				sup := suppliers[r.Books.GSTIN]
				if sup == nil {
					sup = &Supplier{GSTIN: r.Books.GSTIN, Party: r.Books.Party}
					suppliers[r.Books.GSTIN] = sup
				}
				sup.Rows++
				sup.AtRisk += risk
			}
		} else {
			s.NotInBooks += r.TwoB.Tax()
		}
	}
	for _, sup := range suppliers {
		res.FollowUp = append(res.FollowUp, *sup)
	}
	sort.Slice(res.FollowUp, func(i, j int) bool {
		if res.FollowUp[i].AtRisk != res.FollowUp[j].AtRisk {
			return res.FollowUp[i].AtRisk > res.FollowUp[j].AtRisk
		}
		return res.FollowUp[i].GSTIN < res.FollowUp[j].GSTIN
	})
	// Rows in a stable, readable order: by status, then supplier, then number.
	sort.SliceStable(res.Rows, func(i, j int) bool {
		a, b := res.Rows[i], res.Rows[j]
		if a.Status != b.Status {
			return a.Status < b.Status
		}
		ia, ib := a.invoice(), b.invoice()
		if ia.GSTIN != ib.GSTIN {
			return ia.GSTIN < ib.GSTIN
		}
		return ia.Number < ib.Number
	})
}

func (r Row) invoice() *Invoice {
	if r.Books != nil {
		return r.Books
	}
	return r.TwoB
}

// Levenshtein is the number of single-character edits (insert, delete,
// replace) needed to turn a into b. Computed with one rolling row.
func Levenshtein(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	prev := make([]int, len(rb)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ra); i++ {
		cur := make([]int, len(rb)+1)
		cur[0] = i
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev = cur
	}
	return prev[len(rb)]
}
