// Command itc-recon matches a purchase register with GSTR-2B.
//
//	itc-recon -books purchases.csv -2b gstr2b.json
//	itc-recon -books purchases.csv -2b gstr2b.csv -csv result.csv -tolerance 5
package main

import (
	"flag"
	"fmt"
	"io"
	"os"

	recon "github.com/Sumitrcs/itc-recon"
)

func main() {
	booksPath := flag.String("books", "", "purchase register CSV (GSTIN, invoice no, date, taxable, igst, cgst, sgst, cess)")
	twoBPath := flag.String("2b", "", "GSTR-2B: the JSON from the GST portal, or a CSV")
	csvOut := flag.String("csv", "", "also write every row to this CSV file")
	tolerance := flag.Float64("tolerance", 1, "rupees of difference treated as rounding")
	window := flag.Int("days", 7, "days apart a probable match's dates may be")
	flag.Parse()
	if *booksPath == "" || *twoBPath == "" {
		fmt.Fprintln(os.Stderr, "usage: itc-recon -books purchases.csv -2b gstr2b.json [-csv out.csv] [-tolerance 1] [-days 7]")
		os.Exit(2)
	}

	books, err := load(*booksPath, recon.LoadCSV)
	check(err)
	twoB, err := load(*twoBPath, recon.LoadGSTR2B)
	check(err)
	res := recon.Reconcile(books, twoB, recon.Options{Tolerance: recon.Float(*tolerance), DateWindowDays: *window})
	check(recon.WriteReport(os.Stdout, res))
	if *csvOut != "" {
		f, err := os.Create(*csvOut)
		check(err)
		check(recon.WriteCSV(f, res))
		check(f.Close())
		fmt.Printf("\nAll %d rows written to %s\n", len(res.Rows), *csvOut)
	}
}

func load(path string, parse func(io.Reader) ([]recon.Invoice, error)) ([]recon.Invoice, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	inv, err := parse(f)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return inv, nil
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "itc-recon:", err)
		os.Exit(1)
	}
}
