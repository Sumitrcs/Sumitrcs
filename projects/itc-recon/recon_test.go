package recon

import (
	"bytes"
	"flag"
	"os"
	"strings"
	"testing"
	"time"
)

var update = flag.Bool("update", false, "rewrite testdata/report.golden")

func TestPaise(t *testing.T) {
	for in, want := range map[string]Paise{
		"1,23,456.78": 12345678, "₹ 500": 50000, "-12.5": -1250, "": 0, "0.05": 5, ".5": 50, "7": 700,
	} {
		got, err := ParsePaise(in)
		if err != nil || got != want {
			t.Errorf("ParsePaise(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	for _, bad := range []string{"12.345", "abc", "1.2.3", "12a"} {
		if _, err := ParsePaise(bad); err == nil {
			t.Errorf("ParsePaise(%q) should fail", bad)
		}
	}
	for p, want := range map[Paise]string{0: "0.00", 5: "0.05", 12345678: "1,23,456.78", 100000000: "10,00,000.00", -150000: "-1,500.00"} {
		if got := p.String(); got != want {
			t.Errorf("%d.String() = %q, want %q", p, got, want)
		}
	}
	if Float(0.1+0.2) != 30 || Float(18.995) != 1900 || Float(-2.5) != -250 {
		t.Error("Float rounding")
	}
}

func TestDates(t *testing.T) {
	want := time.Date(2026, 8, 5, 0, 0, 0, 0, time.UTC)
	for _, s := range []string{"05-08-2026", "05/08/2026", "2026-08-05", "05.08.2026", "5-8-2026", " 5/8/2026 "} {
		if got, err := ParseDate(s); err != nil || !got.Equal(want) {
			t.Errorf("ParseDate(%q) = %v, %v", s, got, err)
		}
	}
	if _, err := ParseDate("08/32/2026"); err == nil {
		t.Error("day 32 should fail")
	}
}

func TestNormalizeNumber(t *testing.T) {
	same := [][]string{
		{"INV/001/24-25", "inv-1/24-25", "INV 0001 / 24-25", "INV1-24/25"},
		{"SST/102/26-27", "SST-0102/26-27"},
		{"0", "000"},
	}
	for _, group := range same {
		for _, s := range group[1:] {
			if NormalizeNumber(s) != NormalizeNumber(group[0]) {
				t.Errorf("%q and %q should normalise the same (%q vs %q)", s, group[0], NormalizeNumber(s), NormalizeNumber(group[0]))
			}
		}
	}
	if NormalizeNumber("12/3") == NormalizeNumber("1/23") || NormalizeNumber("INV/10") == NormalizeNumber("INV/1/0") {
		t.Error("separators between digits must keep runs apart")
	}
	if got := NormalizeNumber("INV/001/24-25"); got != "INV1.24.25" {
		t.Errorf("got %q", got)
	}
	if NormalizeNumber("A-101") == NormalizeNumber("A-1010") {
		t.Error("trailing zeros are significant")
	}
}

func TestGSTIN(t *testing.T) {
	for _, ok := range []string{"27AAPFU0939F1ZV", "27AABCS1234A1Z1", "29aagck5678b1za"} {
		if !ValidGSTIN(ok) {
			t.Errorf("%s should be valid", ok)
		}
	}
	for _, bad := range []string{"27AAPFU0939F1ZW", "33AABCT7890E1Z8", "27AAPFU0939F1Z", "AAAPFU0939F1ZV1", ""} {
		if ValidGSTIN(bad) {
			t.Errorf("%s should be invalid", bad)
		}
	}
}

func TestLevenshtein(t *testing.T) {
	for _, c := range []struct {
		a, b string
		d    int
	}{{"", "", 0}, {"KPC7790", "KPC779O", 1}, {"kitten", "sitting", 3}, {"abc", "", 3}, {"नमस्ते", "नमस्त", 1}} {
		if got := Levenshtein(c.a, c.b); got != c.d {
			t.Errorf("Levenshtein(%q, %q) = %d, want %d", c.a, c.b, got, c.d)
		}
	}
}

func TestLoadCSV(t *testing.T) {
	in := "\ufeffBill No.,Supplier GSTIN,Bill Date,Taxable Amount,Integrated Tax,ITC Available\n" +
		"A/1,27aabcs1234a1z1,01/08/2026,\"1,000.50\",180.09,N\n\n"
	inv, err := LoadCSV(strings.NewReader(in))
	if err != nil || len(inv) != 1 {
		t.Fatalf("LoadCSV: %v %v", inv, err)
	}
	got := inv[0]
	if got.GSTIN != "27AABCS1234A1Z1" || got.Number != "A/1" || got.Taxable != 100050 || got.IGST != 18009 || got.ITCAvailable || got.Line != 2 {
		t.Errorf("unexpected invoice %+v", got)
	}
	if _, err := LoadCSV(strings.NewReader("gstin,date\n")); err == nil || !strings.Contains(err.Error(), `missing a "number" column`) {
		t.Errorf("missing column error: %v", err)
	}
	if _, err := LoadCSV(strings.NewReader("gstin,invoice,date,taxable\nX,1,01-01-2026,abc\n")); err == nil || !strings.Contains(err.Error(), "line 2, taxable") {
		t.Errorf("bad amount error: %v", err)
	}
}

func TestLoadGSTR2B(t *testing.T) {
	f, err := os.Open("testdata/gstr2b.json")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	inv, err := LoadGSTR2B(f)
	if err != nil {
		t.Fatal(err)
	}
	if len(inv) != 7 {
		t.Fatalf("got %d invoices", len(inv))
	}
	// Items are summed; invoice-level amounts are used when there are no items.
	if inv[0].Tax() != 1800000 || inv[1].Taxable != 5000000 || inv[1].Tax() != 900000 {
		t.Errorf("amounts: %+v %+v", inv[0], inv[1])
	}
	if inv[5].ITCAvailable || !inv[0].ITCAvailable || inv[0].Party != "SHREE STEEL TRADERS" {
		t.Errorf("flags/names: %+v", inv[5])
	}
	// Without the "data" wrapper, and as CSV.
	bare := `{"docdata":{"b2b":[{"ctin":"27AABCS1234A1Z1","inv":[{"inum":"X1","dt":"01-08-2026","txval":100,"igst":18}]}]}}`
	if inv, err := LoadGSTR2B(strings.NewReader(bare)); err != nil || len(inv) != 1 || inv[0].Tax() != 1800 {
		t.Errorf("bare JSON: %v %v", inv, err)
	}
	if inv, err := LoadGSTR2B(strings.NewReader("gstin,invoice,date,taxable,igst\n27AABCS1234A1Z1,X1,01-08-2026,100,18\n")); err != nil || len(inv) != 1 {
		t.Errorf("CSV 2B: %v %v", inv, err)
	}
	if _, err := LoadGSTR2B(strings.NewReader(`{"something":"else"}`)); err == nil {
		t.Error("JSON without docdata should fail")
	}
}

func demo(t *testing.T) Result {
	t.Helper()
	bf, _ := os.Open("testdata/purchases.csv")
	defer bf.Close()
	books, err := LoadCSV(bf)
	if err != nil {
		t.Fatal(err)
	}
	tf, _ := os.Open("testdata/gstr2b.json")
	defer tf.Close()
	twoB, err := LoadGSTR2B(tf)
	if err != nil {
		t.Fatal(err)
	}
	return Reconcile(books, twoB, Options{})
}

func TestReconcileDemo(t *testing.T) {
	res := demo(t)
	s := res.Summary
	if s.BooksITC != 7440000 || s.TwoBITC != 4698000 || s.Claimable != 3324000 || s.AtRisk != 4116000 || s.NotInBooks != 294000 {
		t.Errorf("summary: %+v", s)
	}
	if s.BooksITC != s.Claimable+s.AtRisk {
		t.Error("books ITC must split exactly into claimable + at risk")
	}
	want := map[Status]int{Matched: 3, Probable: 1, Mismatch: 1, OnlyInBooks: 4, OnlyIn2B: 2}
	for st, n := range want {
		if s.Counts[st] != n {
			t.Errorf("%s: %d, want %d", st, s.Counts[st], n)
		}
	}
	if len(res.Duplicates) != 1 || len(res.InvalidGSTINs) != 1 || res.InvalidGSTINs[0].Line != 9 {
		t.Errorf("duplicates %v invalid %v", res.Duplicates, res.InvalidGSTINs)
	}
	var follow []string
	for _, f := range res.FollowUp {
		follow = append(follow, f.Party)
	}
	if strings.Join(follow, ", ") != "Mehta Chemicals, Raj Electricals, Karnataka Packaging Co" {
		t.Errorf("follow-up list: %v (own mistakes must not be on it)", follow)
	}
}

func inv(gstin, num, date string, taxable, igst Paise) Invoice {
	d, _ := ParseDate(date)
	return Invoice{GSTIN: gstin, Number: num, Date: d, Taxable: taxable, IGST: igst, ITCAvailable: true}
}

const g = "27AABCS1234A1Z1"

func TestTolerance(t *testing.T) {
	books := []Invoice{inv(g, "A1", "01-08-2026", 100000, 18000), inv(g, "A2", "01-08-2026", 100000, 18000)}
	twoB := []Invoice{inv(g, "A1", "01-08-2026", 100080, 18000), inv(g, "A2", "01-08-2026", 100000, 18250)}
	res := Reconcile(books, twoB, Options{})
	if res.Summary.Counts[Matched] != 1 || res.Summary.Counts[Mismatch] != 1 {
		t.Fatalf("80 paise is rounding, ₹2.50 is a mismatch: %+v", res.Summary.Counts)
	}
	res = Reconcile(books, twoB, Options{Tolerance: 500})
	if res.Summary.Counts[Matched] != 2 {
		t.Error("with ₹5 tolerance both match")
	}
}

func TestProbableNeedsCloseDatesAndNumbers(t *testing.T) {
	books := []Invoice{
		inv(g, "KPC-7790", "20-08-2026", 18000, 3240),
		inv(g, "KPC-8000", "20-08-2026", 5000, 900),
		inv(g, "Z-1", "01-08-2026", 7000, 1260),
	}
	twoB := []Invoice{
		inv(g, "KPC-779O", "21-08-2026", 18000, 3240), // letter O for zero: probable
		inv(g, "XYZ-123", "20-08-2026", 5000, 900),    // same amount, unrelated number: no
		inv(g, "Z-2", "20-08-2026", 7000, 1260),       // 19 days apart: no
	}
	res := Reconcile(books, twoB, Options{})
	if res.Summary.Counts[Probable] != 1 || res.Summary.Counts[OnlyInBooks] != 2 {
		t.Errorf("counts %+v", res.Summary.Counts)
	}
}

func TestProbablePrefersTheClosestCandidate(t *testing.T) {
	books := []Invoice{inv(g, "B-100", "10-08-2026", 1000, 180)}
	twoB := []Invoice{inv(g, "B-10", "10-08-2026", 1000, 180), inv(g, "B-1OO", "10-08-2026", 1000, 180), inv(g, "B-101", "11-08-2026", 1000, 180)}
	res := Reconcile(books, twoB, Options{})
	for _, r := range res.Rows {
		if r.Status == Probable && r.TwoB.Number != "B-10" && r.TwoB.Number != "B-101" {
			t.Errorf("paired with %s", r.TwoB.Number)
		}
	}
}

func TestReportGolden(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteReport(&buf, demo(t)); err != nil {
		t.Fatal(err)
	}
	if *update {
		os.WriteFile("testdata/report.golden", buf.Bytes(), 0o644)
	}
	want, err := os.ReadFile("testdata/report.golden")
	if err != nil {
		t.Fatal(err)
	}
	if buf.String() != string(want) {
		t.Errorf("report changed (run go test -update to accept):\n%s", buf.String())
	}
}

func TestCSVExport(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteCSV(&buf, demo(t)); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 12 || !strings.HasPrefix(lines[0], "status,gstin,party,books_invoice") {
		t.Fatalf("%d lines: %s", len(lines), lines[0])
	}
	if !strings.Contains(buf.String(), "probable,29AAGCK5678B1ZA,Karnataka Packaging Co,KPC-7790,20-08-2026,18000.00,3240.00,KPC-779O,21-08-2026,18000.00,3240.00,Y,3240.00") {
		t.Error("probable row not as expected")
	}
}
