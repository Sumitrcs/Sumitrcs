#ifndef SUDOKU_H
#define SUDOKU_H

/*
 * Generalised sudoku of size N = box*box (box 2..5 → 4x4 … 25x25).
 * Cells are 0 for empty, 1..N for digits, row-major.
 */
typedef struct {
    int box;
    int n;
    int cells[625];
} sudoku_t;

/* Parses "53..7...." style text ('.', '0' or '_' = empty; digits then A-P for N>9). */
int sudoku_parse(const char *text, sudoku_t *out);
void sudoku_format(const sudoku_t *s, char *buf, int pretty);

/* Fills `solution`; returns number of solutions found up to `limit` (2 checks uniqueness). */
long sudoku_solve(const sudoku_t *puzzle, sudoku_t *solution, long limit, long *nodes);

int sudoku_is_valid_solution(const sudoku_t *s);

#endif
