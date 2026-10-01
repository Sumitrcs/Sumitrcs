from pathlib import Path

import pytest

from csvql import Database, QueryError, SQLSyntaxError, Table
from csvql.cli import main, render_table

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"


@pytest.fixture
def db():
    d = Database()
    d.load_csv(EXAMPLES / "sales.csv")
    d.load_csv(EXAMPLES / "customers.csv")
    return d


def rows(db, sql):
    return db.query(sql).rows


def test_type_inference(db):
    t = db.table("sales")
    assert isinstance(t.rows[0][0], int)
    assert isinstance(t.rows[0][1], str)
    tbl = Table.from_records("x", [{"a": 1}])
    assert tbl.columns == ["a"]


def test_empty_cells_become_null(tmp_path):
    p = tmp_path / "t.csv"
    p.write_text("a,b\n1,\n,2.5\n")
    d = Database()
    d.load_csv(p)
    assert rows(d, "SELECT a, b FROM t") == [(1, None), (None, 2.5)]
    assert rows(d, "SELECT COUNT(*), COUNT(a), SUM(b) FROM t") == [(2, 1, 2.5)]


def test_select_where_order_limit(db):
    r = rows(db, "SELECT id, amount FROM sales WHERE region = 'North' AND amount >= 10000 ORDER BY amount DESC LIMIT 2")
    assert r == [(1, 45000), (11, 24000)]


def test_offset_and_order_by_position(db):
    r = rows(db, "SELECT product, amount FROM sales ORDER BY 2 DESC LIMIT 2 OFFSET 1")
    assert r == [("Website", 52000), ("Website", 48000)]


def test_group_by_having_with_alias(db):
    r = rows(db, """
        SELECT region, COUNT(*) AS n, SUM(amount) AS total
        FROM sales GROUP BY region HAVING COUNT(*) >= 3 ORDER BY total DESC
    """)
    assert r == [("North", 5, 94999), ("West", 3, 75998)]


def test_aggregates_without_group_by(db):
    r = rows(db, "SELECT COUNT(*), COUNT(DISTINCT region), MIN(amount), MAX(date), AVG(quantity) FROM sales")
    assert r == [(12, 4, 4500, "2026-06-30", 2.3333333333333335)]


def test_count_on_empty_result_returns_zero(db):
    assert rows(db, "SELECT COUNT(*), SUM(amount) FROM sales WHERE amount < 0") == [(0, None)]


def test_inner_join_uses_qualified_names(db):
    r = rows(db, """
        SELECT c.name, SUM(s.amount) AS revenue
        FROM sales s JOIN customers c ON s.customer_id = c.customer_id
        WHERE c.segment = 'Enterprise' GROUP BY c.name ORDER BY revenue DESC
    """)
    assert r == [("Nimbus Health", 150000), ("Southwind Exports", 56500)]


def test_left_join_keeps_unmatched_rows(db):
    r = rows(db, """
        SELECT c.name, COUNT(s.id) AS orders FROM customers c
        LEFT JOIN sales s ON c.customer_id = s.customer_id
        GROUP BY c.name HAVING COUNT(s.id) = 0
    """)
    assert r == [("Zenith Retail", 0)]


def test_non_equi_join_falls_back_to_nested_loop(db):
    r = rows(db, """
        SELECT a.id, b.id FROM sales a JOIN sales b ON a.amount > b.amount * 30
        ORDER BY a.id, b.id
    """)
    assert r == [(7, 4), (7, 10)]


def test_select_star_and_table_star(db):
    res = db.query("SELECT * FROM customers LIMIT 1")
    assert res.columns == ["customer_id", "name", "city", "segment"]
    res = db.query("SELECT c.* FROM sales s JOIN customers c ON s.customer_id = c.customer_id LIMIT 1")
    assert res.columns == ["customer_id", "name", "city", "segment"]


def test_predicates(db):
    assert rows(db, "SELECT COUNT(*) FROM sales WHERE product IN ('Website', 'Hosting')") == [(5,)]
    assert rows(db, "SELECT COUNT(*) FROM sales WHERE product NOT IN ('Website')") == [(9,)]
    assert rows(db, "SELECT COUNT(*) FROM sales WHERE amount BETWEEN 9000 AND 12000") == [(3,)]
    assert rows(db, "SELECT COUNT(*) FROM sales WHERE product LIKE '%Pack%'") == [(3,)]
    assert rows(db, "SELECT COUNT(*) FROM sales WHERE product NOT LIKE 'W_bsite'") == [(9,)]
    assert rows(db, "SELECT COUNT(*) FROM customers WHERE NOT (city = 'Delhi' OR city = 'Pune')") == [(5,)]


def test_null_three_valued_logic():
    d = Database()
    d.register(Table("t", ["x"], [[1], [None], [3]]))
    assert rows(d, "SELECT COUNT(*) FROM t WHERE x != 1") == [(1,)]  # NULL row excluded
    assert rows(d, "SELECT COUNT(*) FROM t WHERE x IS NULL") == [(1,)]
    assert rows(d, "SELECT x FROM t ORDER BY x") == [(None,), (1,), (3,)]
    assert rows(d, "SELECT NULL AND FALSE, NULL OR TRUE, NULL AND TRUE") == [(False, True, None)]


def test_case_and_scalar_functions(db):
    r = rows(db, """
        SELECT UPPER(product), CASE WHEN amount >= 40000 THEN 'large' WHEN amount >= 10000 THEN 'medium' ELSE 'small' END AS size
        FROM sales WHERE id IN (1, 3, 8) ORDER BY id
    """)
    assert r == [("WEBSITE", "large"), ("LOGO DESIGN", "small"), ("SEO PACKAGE", "medium")]
    assert rows(db, "SELECT ROUND(2.5), ROUND(-2.5), ROUND(1.005, 2), 7 / 2, 7.0 / 2, 1 / 0") == [(3, -3, 1.01, 3, 3.5, None)]
    assert rows(db, "SELECT COALESCE(NULL, NULL, 'x'), LENGTH('abc'), SUBSTR('csvql', 2, 3), 'a' || 'b'") == [("x", 3, "svq", "ab")]
    assert rows(db, "SELECT DISTINCT YEAR(date) FROM sales") == [(2026,)]


def test_distinct(db):
    assert len(rows(db, "SELECT DISTINCT region FROM sales")) == 4


def test_errors(db):
    with pytest.raises(QueryError, match="Unknown table"):
        db.query("SELECT * FROM nope")
    with pytest.raises(QueryError, match="Unknown column"):
        db.query("SELECT nope FROM sales")
    with pytest.raises(QueryError, match="ambiguous"):
        db.query("SELECT customer_id FROM sales s JOIN customers c ON s.customer_id = c.customer_id")
    with pytest.raises(QueryError, match="not allowed in WHERE"):
        db.query("SELECT region FROM sales WHERE SUM(amount) > 1")
    with pytest.raises(SQLSyntaxError, match="Expected FROM|found"):
        db.query("SELECT FROM sales")
    with pytest.raises(SQLSyntaxError, match="position"):
        db.query("SELECT id FROM sales WHERE id = = 1")


def test_cli_table_output(capsys):
    code = main(["SELECT region, COUNT(*) AS n FROM sales GROUP BY region ORDER BY n DESC LIMIT 1", str(EXAMPLES / "sales.csv")])
    out = capsys.readouterr().out
    assert code == 0
    assert "North" in out and "(1 row)" in out


def test_cli_json_and_named_table(capsys):
    code = main(["-f", "json", "SELECT name FROM c WHERE city = 'Delhi'", f"c={EXAMPLES / 'customers.csv'}"])
    assert code == 0
    assert '"name": "Acme Traders"' in capsys.readouterr().out


def test_cli_reports_errors(capsys):
    assert main(["SELECT * FROM missing", str(EXAMPLES / "sales.csv")]) == 1
    assert "Unknown table" in capsys.readouterr().err


def test_render_table_alignment():
    out = render_table(["name", "n"], [("a", 1), ("bbb", 10)])
    assert "│ a    │  1 │" in out
