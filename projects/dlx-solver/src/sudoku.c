/*
 * Sudoku as exact cover. For an N×N grid there are N³ candidate rows
 * ("digit d in cell r,c") and 4N² constraint columns:
 *   cell (r,c) is filled · row r has d · column c has d · box b has d
 */
#include "sudoku.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>

#include "dlx.h"

static int digit_value(char ch) {
    if (ch >= '1' && ch <= '9') return ch - '0';
    if (ch >= 'A' && ch <= 'P') return ch - 'A' + 10;
    if (ch >= 'a' && ch <= 'p') return ch - 'a' + 10;
    return -1;
}

static char digit_char(int v) { return v == 0 ? '.' : v < 10 ? (char)('0' + v) : (char)('A' + v - 10); }

int sudoku_parse(const char *text, sudoku_t *out) {
    int vals[625], count = 0;
    for (const char *p = text; *p && count < 625; p++) {
        if (*p == '.' || *p == '0' || *p == '_') {
            vals[count++] = 0;
        } else if (digit_value(*p) > 0) {
            vals[count++] = digit_value(*p);
        } else if (!isspace((unsigned char)*p) && *p != '|' && *p != '-' && *p != '+') {
            return -1;
        }
    }
    for (int box = 2; box <= 5; box++) {
        if (box * box * box * box == count) {
            out->box = box;
            out->n = box * box;
            for (int i = 0; i < count; i++) {
                if (vals[i] > out->n) return -1;
                out->cells[i] = vals[i];
            }
            return 0;
        }
    }
    return -1;
}

void sudoku_format(const sudoku_t *s, char *buf, int pretty) {
    int n = s->n, b = s->box, k = 0;
    for (int r = 0; r < n; r++) {
        if (pretty && r && r % b == 0) {
            for (int c = 0; c < n + b - 1; c++) buf[k++] = c % (b + 1) == b ? '+' : '-', buf[k++] = '-';
            k--;
            buf[k++] = '\n';
        }
        for (int c = 0; c < n; c++) {
            if (pretty && c && c % b == 0) buf[k++] = '|', buf[k++] = ' ';
            buf[k++] = digit_char(s->cells[r * n + c]);
            if (pretty) buf[k++] = ' ';
        }
        if (pretty) {
            k--;
            buf[k++] = '\n';
        }
    }
    buf[k] = '\0';
}

typedef struct {
    sudoku_t *out;
    int n;
} ctx_t;

static int record(const int *rows, int count, void *p) {
    ctx_t *ctx = p;
    int n = ctx->n;
    for (int i = 0; i < count; i++) {
        int id = rows[i];
        ctx->out->cells[id / n] = id % n + 1; /* id = cell * n + (digit - 1) */
    }
    return 0;
}

long sudoku_solve(const sudoku_t *puzzle, sudoku_t *solution, long limit, long *nodes) {
    int n = puzzle->n, b = puzzle->box, nn = n * n;
    dlx_t *d = dlx_new(4 * nn, 0);
    if (!d) return -1;
    for (int r = 0; r < n; r++)
        for (int c = 0; c < n; c++)
            for (int v = 0; v < n; v++) {
                int box = (r / b) * b + c / b;
                int cols[4] = {r * n + c, nn + r * n + v, 2 * nn + c * n + v, 3 * nn + box * n + v};
                dlx_add_row(d, (r * n + c) * n + v, cols, 4);
            }

    *solution = *puzzle;
    for (int i = 0; i < nn; i++) {
        if (puzzle->cells[i] && dlx_select_row(d, i * n + puzzle->cells[i] - 1) != 0) {
            dlx_free(d);
            return 0; /* clues contradict each other */
        }
    }
    ctx_t ctx = {solution, n};
    /* Record only the first solution; later ones are just counted. */
    long found = dlx_solve(d, 1, record, &ctx);
    if (found && limit != 1) found = dlx_solve(d, limit, NULL, NULL);
    if (nodes) *nodes = dlx_nodes(d);
    dlx_free(d);
    return found;
}

int sudoku_is_valid_solution(const sudoku_t *s) {
    int n = s->n, b = s->box;
    for (int i = 0; i < n; i++) {
        int row[26] = {0}, col[26] = {0}, box[26] = {0};
        for (int j = 0; j < n; j++) {
            int rv = s->cells[i * n + j], cv = s->cells[j * n + i];
            int bv = s->cells[((i / b) * b + j / b) * n + (i % b) * b + j % b];
            if (rv < 1 || rv > n || row[rv]++ || col[cv]++ || box[bv]++) return 0;
        }
    }
    return 1;
}
