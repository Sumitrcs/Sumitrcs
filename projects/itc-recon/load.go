package recon

import (
	"bufio"
	"bytes"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// Column names accepted in CSV files, case-insensitive. Exports from Tally,
// Busy and Excel templates use all sorts of headings, so each field has a
// few aliases.
var columnAliases = map[string][]string{
	"gstin":   {"gstin", "supplier gstin", "gstin of supplier", "ctin", "gstin/uin"},
	"party":   {"party", "supplier", "supplier name", "trade name", "name", "trdnm", "party name"},
	"number":  {"invoice", "invoice no", "invoice no.", "invoice number", "bill no", "bill no.", "inum", "voucher no", "doc no"},
	"date":    {"date", "invoice date", "bill date", "dt"},
	"taxable": {"taxable", "taxable value", "taxable amount", "txval"},
	"igst":    {"igst", "integrated tax", "igst amount"},
	"cgst":    {"cgst", "central tax", "cgst amount"},
	"sgst":    {"sgst", "state tax", "sgst/utgst", "sgst amount", "utgst"},
	"cess":    {"cess", "cess amount"},
	"itc":     {"itc available", "itcavl", "itc availability"},
}

// LoadCSV reads invoices from a CSV file with a header row. Required columns:
// GSTIN, invoice number, date and taxable value; tax columns may be omitted.
func LoadCSV(r io.Reader) ([]Invoice, error) {
	cr := csv.NewReader(bufio.NewReader(r))
	cr.FieldsPerRecord = -1
	cr.TrimLeadingSpace = true
	header, err := cr.Read()
	if err != nil {
		return nil, fmt.Errorf("reading header: %w", err)
	}
	col := map[string]int{}
	for i, h := range header {
		h = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(h, "\ufeff")))
		for field, aliases := range columnAliases {
			for _, a := range aliases {
				if h == a {
					if _, dup := col[field]; !dup {
						col[field] = i
					}
				}
			}
		}
	}
	for _, need := range []string{"gstin", "number", "date", "taxable"} {
		if _, ok := col[need]; !ok {
			return nil, fmt.Errorf("missing a %q column (found: %s)", need, strings.Join(header, ", "))
		}
	}

	var out []Invoice
	for line := 2; ; line++ {
		rec, err := cr.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("line %d: %w", line, err)
		}
		get := func(field string) string {
			if i, ok := col[field]; ok && i < len(rec) {
				return strings.TrimSpace(rec[i])
			}
			return ""
		}
		if strings.Join(rec, "") == "" {
			continue
		}
		inv := Invoice{
			GSTIN:        strings.ToUpper(get("gstin")),
			Party:        get("party"),
			Number:       get("number"),
			ITCAvailable: !strings.EqualFold(get("itc"), "N") && !strings.EqualFold(get("itc"), "No"),
			Line:         line,
		}
		if inv.Date, err = ParseDate(get("date")); err != nil {
			return nil, fmt.Errorf("line %d: %w", line, err)
		}
		for _, f := range []struct {
			name string
			dst  *Paise
		}{{"taxable", &inv.Taxable}, {"igst", &inv.IGST}, {"cgst", &inv.CGST}, {"sgst", &inv.SGST}, {"cess", &inv.Cess}} {
			if *f.dst, err = ParsePaise(get(f.name)); err != nil {
				return nil, fmt.Errorf("line %d, %s: %w", line, f.name, err)
			}
		}
		if inv.Number == "" {
			return nil, fmt.Errorf("line %d: empty invoice number", line)
		}
		out = append(out, inv)
	}
	return out, nil
}

// The parts of the GST portal's GSTR-2B JSON download we need: the B2B
// invoices, grouped by supplier. Amounts are either per item (one row per
// tax rate) or totals on the invoice itself; both are handled.
type gstr2bFile struct {
	Data    *gstr2bData `json:"data"`
	DocData *docData    `json:"docdata"` // some tools save without the "data" wrapper
}

type gstr2bData struct {
	DocData docData `json:"docdata"`
}

type docData struct {
	B2B []struct {
		CTIN string    `json:"ctin"`
		Name string    `json:"trdnm"`
		Invs []invJSON `json:"inv"`
	} `json:"b2b"`
}

type amounts struct {
	Taxable float64 `json:"txval"`
	IGST    float64 `json:"igst"`
	CGST    float64 `json:"cgst"`
	SGST    float64 `json:"sgst"`
	Cess    float64 `json:"cess"`
}

type invJSON struct {
	Number string `json:"inum"`
	Date   string `json:"dt"`
	ITC    string `json:"itcavl"`
	amounts
	Items []amounts `json:"items"`
}

// LoadGSTR2B reads GSTR-2B either as the portal's JSON or as CSV.
func LoadGSTR2B(r io.Reader) ([]Invoice, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}
	trimmed := bytes.TrimLeft(data, " \t\r\n\ufeff")
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return LoadCSV(bytes.NewReader(data))
	}
	var f gstr2bFile
	if err := json.Unmarshal(trimmed, &f); err != nil {
		return nil, fmt.Errorf("GSTR-2B JSON: %w", err)
	}
	doc := f.DocData
	if f.Data != nil {
		doc = &f.Data.DocData
	}
	if doc == nil {
		return nil, fmt.Errorf("GSTR-2B JSON: no data.docdata section found")
	}
	var out []Invoice
	n := 0
	for _, sup := range doc.B2B {
		for _, iv := range sup.Invs {
			n++
			total := iv.amounts
			if len(iv.Items) > 0 {
				total = amounts{}
				for _, it := range iv.Items {
					total.Taxable += it.Taxable
					total.IGST += it.IGST
					total.CGST += it.CGST
					total.SGST += it.SGST
					total.Cess += it.Cess
				}
			}
			d, err := ParseDate(iv.Date)
			if err != nil {
				return nil, fmt.Errorf("GSTR-2B invoice %s of %s: %w", iv.Number, sup.CTIN, err)
			}
			out = append(out, Invoice{
				GSTIN: strings.ToUpper(sup.CTIN), Party: sup.Name, Number: iv.Number, Date: d,
				Taxable: Float(total.Taxable), IGST: Float(total.IGST), CGST: Float(total.CGST),
				SGST: Float(total.SGST), Cess: Float(total.Cess),
				ITCAvailable: !strings.EqualFold(iv.ITC, "N"), Line: n,
			})
		}
	}
	return out, nil
}
