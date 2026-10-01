# csvql

Run real SQL directly against CSV files — no database to install, no import
step. A complete little query engine in **pure Python** (no dependencies):
tokenizer, recursive-descent parser, and an executor with hash joins,
grouping and three-valued NULL logic.

```bash
$ csvql "SELECT c.name, COUNT(*) AS orders, SUM(s.amount) AS revenue
         FROM sales s JOIN customers c ON s.customer_id = c.customer_id
         GROUP BY c.name ORDER BY revenue DESC LIMIT 4" \
         examples/sales.csv examples/customers.csv
┌───────────────────┬────────┬─────────┐
│ name              │ orders │ revenue │
├───────────────────┼────────┼─────────┤
│ Nimbus Health     │      1 │  150000 │
│ Acme Traders      │      3 │   73999 │
│ Southwind Exports │      2 │   56500 │
│ Orbit Labs        │      1 │   48000 │
└───────────────────┴────────┴─────────┘
(4 rows)
```

## Supported SQL

```sql
SELECT [DISTINCT] expr [AS alias], table.*, *
FROM table [alias]
  [INNER | LEFT] JOIN table [alias] ON condition
WHERE condition
GROUP BY expr, ...
HAVING condition
ORDER BY expr | alias | position [ASC | DESC], ...
LIMIT n [OFFSET m]
```

| Category | Supported |
|---|---|
| Operators | `+ - * / %`, `\|\|`, `= != <> < <= > >=`, `AND OR NOT` |
| Predicates | `IN (…)`, `BETWEEN`, `LIKE` (`%`, `_`), `IS [NOT] NULL` |
| Aggregates | `COUNT(*)`, `COUNT(DISTINCT x)`, `SUM`, `AVG`, `MIN`, `MAX` |
| Functions | `UPPER LOWER LENGTH TRIM SUBSTR ABS ROUND COALESCE IFNULL CONCAT YEAR MONTH DAY` |
| Expressions | `CASE WHEN … THEN … ELSE … END` |

## How it works

1. **Load** — each CSV column's type is inferred (int → float → text); empty cells become `NULL`.
2. **Parse** — a hand-written tokenizer and recursive-descent parser build an AST, with
   error messages that include the position in the query.
3. **Join** — equality joins use a **hash join** (build on the right, probe with the left);
   any other `ON` condition falls back to a nested loop. `LEFT JOIN` pads with `NULL`.
4. **Filter / group / having** — SQL's three-valued logic is honoured: `NULL = 1` is
   unknown, so the row is filtered out; `COUNT(col)` skips `NULL`s.
5. **Sort** — stable multi-key sort; `NULL`s sort first; you can order by alias or column position.

## Install & use

```bash
pip install .
csvql "SELECT region, SUM(amount) FROM sales GROUP BY region" examples/sales.csv
csvql -f json "SELECT * FROM c LIMIT 2" c=examples/customers.csv   # name=path aliases
csvql -f csv  "SELECT * FROM sales WHERE amount > 40000" examples/sales.csv > big.csv
```

As a library:

```python
from csvql import Database

db = Database()
db.load_csv("examples/sales.csv")
result = db.query("SELECT product, SUM(amount) AS total FROM sales GROUP BY product ORDER BY total DESC")
for row in result.as_dicts():
    print(row)
```

## Tests

```bash
pip install -e ".[dev]"
pytest
```

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
