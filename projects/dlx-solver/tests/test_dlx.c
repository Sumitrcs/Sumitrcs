#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "../src/dlx.h"
#include "../src/queens.h"
#include "../src/sudoku.h"

static int collect(const int *rows, int count, void *ctx) {
    int *mask = ctx;
    int m = 0;
    for (int i = 0; i < count; i++) m |= 1 << rows[i];
    *mask = m;
    return 0;
}

/* Knuth's example from the paper: unique solution is rows {0, 3, 4} (A, D, E). */
static void test_knuth_example(void) {
    dlx_t *d = dlx_new(7, 0);
    int r0[] = {2, 4, 5}, r1[] = {0, 3, 6}, r2[] = {1, 2, 5}, r3[] = {0, 3}, r4[] = {1, 6}, r5[] = {3, 4, 6};
    dlx_add_row(d, 0, r0, 3);
    dlx_add_row(d, 1, r1, 3);
    dlx_add_row(d, 2, r2, 3);
    dlx_add_row(d, 3, r3, 2);
    dlx_add_row(d, 4, r4, 2);
    dlx_add_row(d, 5, r5, 3);
    int mask = 0;
    assert(dlx_solve(d, 0, collect, &mask) == 1);
    assert(mask == ((1 << 0) | (1 << 3) | (1 << 4)));
    /* The matrix must be fully restored after search: solving again gives the same answer. */
    assert(dlx_solve(d, 0, NULL, NULL) == 1);
    dlx_free(d);
}

static void test_invalid_input(void) {
    dlx_t *d = dlx_new(3, 0);
    int bad[] = {5};
    int ok[] = {0, 1};
    assert(dlx_add_row(d, 0, bad, 1) == -1);
    assert(dlx_add_row(d, 0, ok, 2) == 0);
    assert(dlx_add_row(d, 0, ok, 2) == -1); /* duplicate id */
    assert(dlx_select_row(d, 99) == -1);
    assert(dlx_select_row(d, 0) == 0);
    assert(dlx_select_row(d, 0) == -1); /* already covered */
    dlx_free(d);
}

static void test_queens(void) {
    long expect[] = {1, 0, 0, 2, 10, 4, 40, 92, 352, 724};
    for (int n = 1; n <= 10; n++) assert(queens_count(n, NULL) == expect[n - 1]);
}

static void test_sudoku(void) {
    /* "AI Escargot" — a famously hard puzzle. */
    const char *hard = "1....7.9..3..2...8..96..5....53..9...1..8...26....4...3......1..4......7..7...3..";
    sudoku_t p, s;
    assert(sudoku_parse(hard, &p) == 0 && p.n == 9);
    assert(sudoku_solve(&p, &s, 2, NULL) == 1);
    assert(sudoku_is_valid_solution(&s));
    for (int i = 0; i < 81; i++) assert(p.cells[i] == 0 || p.cells[i] == s.cells[i]);

    /* Removing clues from a solved grid creates multiple solutions. */
    sudoku_t few = s;
    for (int i = 0; i < 81; i += 1)
        if (i % 3) few.cells[i] = 0;
    assert(sudoku_solve(&few, &s, 2, NULL) == 2);

    /* Contradictory clues: two 5s in the first row. */
    assert(sudoku_parse("55" "...............................................................................", &p) == 0);
    assert(sudoku_solve(&p, &s, 2, NULL) == 0);

    /* Empty 4x4 has 288 solutions. */
    assert(sudoku_parse("................", &p) == 0 && p.n == 4);
    assert(sudoku_solve(&p, &s, 0, NULL) == 288);

    assert(sudoku_parse("12345", &p) == -1);
    assert(sudoku_parse("x...............", &p) == -1);
}

static void test_format(void) {
    sudoku_t p;
    char buf[1024];
    assert(sudoku_parse("1234341221434321", &p) == 0);
    sudoku_format(&p, buf, 0);
    assert(strcmp(buf, "1234341221434321") == 0);
    sudoku_format(&p, buf, 1);
    assert(strncmp(buf, "1 2 | 3 4\n3 4 | 1 2\n", 20) == 0);
}

int main(void) {
    test_knuth_example();
    test_invalid_input();
    test_queens();
    test_sudoku();
    test_format();
    puts("all tests passed");
    return 0;
}
