// Package recon reconciles a purchase register with GSTR-2B to find which
// input tax credit (ITC) can be claimed, and which bills need follow-up.
//
// Every month, GSTR-2B lists the purchase invoices your suppliers reported.
// You may only claim ITC on invoices that appear there, so the books and
// GSTR-2B have to be matched invoice by invoice. That is fiddly by hand
// because the same bill is often written differently:
//
//	books:   INV/001/24-25   ₹10,000.00 + 18% GST
//	2B:      INV-1/24-25     ₹10,000.00 + 18% GST   (same bill)
package recon

import (
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// Paise is an amount of money in paise. Integers keep sums exact.
type Paise int64

func (p Paise) String() string {
	sign := ""
	if p < 0 {
		sign = "-"
		p = -p
	}
	return fmt.Sprintf("%s%s.%02d", sign, groupIndian(int64(p)/100), int64(p)%100)
}

// groupIndian writes 1234567 as 12,34,567.
func groupIndian(n int64) string {
	s := strconv.FormatInt(n, 10)
	if len(s) <= 3 {
		return s
	}
	head, tail := s[:len(s)-3], s[len(s)-3:]
	var parts []string
	for len(head) > 2 {
		parts = append([]string{head[len(head)-2:]}, parts...)
		head = head[:len(head)-2]
	}
	parts = append([]string{head}, parts...)
	return strings.Join(parts, ",") + "," + tail
}

// ParsePaise reads "1,23,456.78", "₹ 500", "-12.5" or "" (zero).
func ParsePaise(s string) (Paise, error) {
	t := strings.NewReplacer(",", "", "₹", "", " ", "").Replace(strings.TrimSpace(s))
	if t == "" {
		return 0, nil
	}
	neg := strings.HasPrefix(t, "-")
	t = strings.TrimPrefix(t, "-")
	whole, frac, _ := strings.Cut(t, ".")
	if whole == "" {
		whole = "0"
	}
	if len(frac) > 2 || strings.ContainsFunc(whole+frac, func(r rune) bool { return r < '0' || r > '9' }) {
		return 0, fmt.Errorf("not an amount: %q", s)
	}
	rupees, err := strconv.ParseInt(whole, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("not an amount: %q", s)
	}
	paise, _ := strconv.ParseInt((frac + "00")[:2], 10, 64)
	v := Paise(rupees*100 + paise)
	if neg {
		v = -v
	}
	return v, nil
}

// Float converts a JSON number like 1234.5 to paise, rounding to the nearest paisa.
func Float(f float64) Paise {
	if f < 0 {
		return -Float(-f)
	}
	return Paise(f*100 + 0.5)
}

var dateLayouts = []string{"02-01-2006", "02/01/2006", "2006-01-02", "02.01.2006", "2-1-2006", "2/1/2006"}

// ParseDate accepts the formats Indian software exports: 05-08-2026,
// 05/08/2026, 2026-08-05 (day first, never American month first).
func ParseDate(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	for _, layout := range dateLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("not a date: %q (use dd-mm-yyyy)", s)
}

// Invoice is one purchase bill, from either side.
type Invoice struct {
	GSTIN   string // supplier's GSTIN
	Party   string // supplier's name
	Number  string // invoice number as written
	Date    time.Time
	Taxable Paise
	IGST    Paise
	CGST    Paise
	SGST    Paise
	Cess    Paise
	// From GSTR-2B: is ITC available on this invoice? ("N" when, for example,
	// the place of supply rules block it.) Always true for book entries.
	ITCAvailable bool
	Line         int // row in the source file, for reports
}

// Tax is the total GST on the invoice.
func (i Invoice) Tax() Paise { return i.IGST + i.CGST + i.SGST + i.Cess }

// Total is the invoice value.
func (i Invoice) Total() Paise { return i.Taxable + i.Tax() }

// NormalizeNumber reduces an invoice number to what actually identifies it,
// so INV/001/24-25, inv-1/24-25 and INV 0001 / 24-25 all compare equal
// (as INV1.24.25): upper case, spaces and punctuation dropped, and leading
// zeros removed from every run of digits. Two digit runs that were separated
// by punctuation keep a "." between them, so 12/3 and 1/23 stay different.
func NormalizeNumber(s string) string {
	var b strings.Builder
	var digits strings.Builder
	lastWasDigits := false
	flush := func() {
		if digits.Len() == 0 {
			return
		}
		d := strings.TrimLeft(digits.String(), "0")
		if d == "" {
			d = "0"
		}
		if lastWasDigits {
			b.WriteByte('.')
		}
		b.WriteString(d)
		digits.Reset()
		lastWasDigits = true
	}
	for _, r := range strings.ToUpper(s) {
		switch {
		case unicode.IsDigit(r):
			digits.WriteRune(r)
		case unicode.IsLetter(r):
			flush()
			b.WriteRune(r)
			lastWasDigits = false
		default: // spaces and punctuation separate digit runs but are dropped
			flush()
		}
	}
	flush()
	return b.String()
}

const gstinChars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"

// ValidGSTIN checks the 15-character format and the final check character
// (a base-36 checksum over the first 14 characters).
func ValidGSTIN(g string) bool {
	if len(g) != 15 {
		return false
	}
	g = strings.ToUpper(g)
	sum := 0
	for i := 0; i < 14; i++ {
		v := strings.IndexByte(gstinChars, g[i])
		if v < 0 {
			return false
		}
		p := v * (1 + i%2) // weights 1, 2, 1, 2, ...
		sum += p/36 + p%36
	}
	if g[0] < '0' || g[0] > '9' || g[1] < '0' || g[1] > '9' {
		return false // state code
	}
	return g[14] == gstinChars[(36-sum%36)%36]
}
