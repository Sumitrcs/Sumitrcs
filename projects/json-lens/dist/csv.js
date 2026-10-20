// Built from src/csv.ts by build.mjs. Edit the .ts file, not this one.
// Converts a JSON array of objects (what most APIs return) into CSV that
// Excel and Google Sheets open directly.
//
//   [{"id": 1, "address": {"city": "Pune"}, "tags": ["a", "b"]}]
//   →  id,address.city,tags
//      1,Pune,a; b
//
// Nested objects become dotted column names; arrays of plain values are
// joined with "; "; anything more complex is written as compact JSON.
                                       
import { format } from "./format.js";

export class CsvError extends Error {}

export function toCsv(root      )         {
  let rows        ;
  if (root.kind === "array") rows = root.items;
  else if (root.kind === "object") rows = [root]; // a single record is one row
  else throw new CsvError("CSV needs an array of objects, like [{\"name\": \"Asha\"}, {\"name\": \"Ravi\"}]");
  if (rows.length === 0) throw new CsvError("The array is empty, so there are no rows to write");

  const columns           = [];
  const known = new Set        ();
  const records = rows.map((row) => {
    const cells = new Map                ();
    if (row.kind === "object") flatten(row, "", cells);
    else cells.set("value", cell(row));
    for (const k of cells.keys()) {
      if (!known.has(k)) {
        known.add(k);
        columns.push(k);
      }
    }
    return cells;
  });

  const lines = [columns.map(quote).join(",")];
  for (const cells of records) lines.push(columns.map((c) => quote(cells.get(c) ?? "")).join(","));
  return lines.join("\r\n") + "\r\n"; // RFC 4180 uses CRLF
}

function flatten(n      , prefix        , out                     )       {
  if (n.kind === "object" && n.entries.length > 0) {
    for (const e of n.entries) flatten(e.value, prefix ? `${prefix}.${e.key}` : e.key, out);
  } else {
    out.set(prefix, cell(n));
  }
}

function cell(n      )         {
  switch (n.kind) {
    case "null": return "";
    case "boolean": return String(n.value);
    case "number": return n.raw;
    case "string": return safe(n.value);
    case "array":
      if (n.items.every((i) => i.kind !== "array" && i.kind !== "object")) return n.items.map(cell).join("; ");
      return format(n, { indent: 0 });
    case "object": return format(n, { indent: 0 });
  }
}

// A cell starting with = + - @ is run as a formula by spreadsheet programs,
// which is a known way to attack people who open a CSV ("CSV injection").
// A leading apostrophe makes the spreadsheet treat it as text. Numbers are
// written from their own case above, so -5 is not affected.
function safe(s        )         {
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

// Quote a field if it contains a comma, quote or line break; double any quotes.
export function quote(s        )         {
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
}
