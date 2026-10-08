/*
 * Dancing Links (Knuth, "Dancing Links", 2000).
 *
 * Every 1 in the sparse matrix is a node in two circular doubly-linked
 * lists: its row and its column. Covering a column unlinks it and every
 * row that intersects it; uncovering relinks them in exactly the reverse
 * order. Because a removed node still remembers its neighbours,
 *     x->left->right = x->right   (remove)
 *     x->left->right = x          (restore)
 * backtracking costs O(1) per node with no copying.
 *
 * Nodes live in one growable array and link by index, which keeps the
 * structure cache-friendly and trivially freed.
 */
#include "dlx.h"

#include <stdlib.h>
#include <string.h>

typedef struct {
    int left, right, up, down;
    int col;    /* column header index */
    int row_id; /* user row id (-1 for headers) */
} node_t;

struct dlx {
    node_t *n;
    int count, cap;
    int *size;    /* number of 1s per column */
    char *covered; /* column currently covered? */
    int ncols, primary;
    int *row_first; /* first node of each row id, -1 if none */
    int rows_cap;
    int *solution, depth, preselected;
    long nodes, found, limit;
    dlx_visit_fn visit;
    void *ctx;
    int stop;
};

#define ROOT 0

static int new_node(dlx_t *d) {
    if (d->count == d->cap) {
        int cap = d->cap * 2;
        node_t *grown = realloc(d->n, sizeof(node_t) * (size_t)cap);
        if (!grown) return -1;
        d->n = grown;
        d->cap = cap;
    }
    return d->count++;
}

dlx_t *dlx_new(int primary, int secondary) {
    dlx_t *d = calloc(1, sizeof *d);
    if (!d) return NULL;
    d->ncols = primary + secondary;
    d->primary = primary;
    d->cap = 64 + d->ncols * 4;
    d->n = malloc(sizeof(node_t) * (size_t)d->cap);
    d->size = calloc((size_t)d->ncols + 1, sizeof(int));
    d->covered = calloc((size_t)d->ncols + 1, 1);
    d->solution = malloc(sizeof(int) * ((size_t)d->ncols + 1));
    if (!d->n || !d->size || !d->covered || !d->solution) {
        dlx_free(d);
        return NULL;
    }
    /* Node 0 is the root; nodes 1..ncols are column headers. Only primary
     * columns are linked into the root's list, so the search never needs to
     * cover secondary ones — they just get covered as a side effect. */
    for (int i = 0; i <= d->ncols; i++) {
        int x = new_node(d);
        d->n[x] = (node_t){.left = x, .right = x, .up = x, .down = x, .col = x, .row_id = -1};
    }
    for (int c = 1; c <= primary; c++) {
        int last = d->n[ROOT].left;
        d->n[c].left = last;
        d->n[c].right = ROOT;
        d->n[last].right = c;
        d->n[ROOT].left = c;
    }
    return d;
}

void dlx_free(dlx_t *d) {
    if (!d) return;
    free(d->n);
    free(d->size);
    free(d->covered);
    free(d->solution);
    free(d->row_first);
    free(d);
}

int dlx_add_row(dlx_t *d, int row_id, const int *cols, int ncols) {
    if (row_id < 0 || ncols <= 0) return -1;
    if (row_id >= d->rows_cap) {
        int cap = d->rows_cap ? d->rows_cap : 64;
        while (cap <= row_id) cap *= 2;
        int *grown = realloc(d->row_first, sizeof(int) * (size_t)cap);
        if (!grown) return -1;
        for (int i = d->rows_cap; i < cap; i++) grown[i] = -1;
        d->row_first = grown;
        d->rows_cap = cap;
    }
    if (d->row_first[row_id] != -1) return -1; /* duplicate id */

    int first = -1;
    for (int i = 0; i < ncols; i++) {
        if (cols[i] < 0 || cols[i] >= d->ncols) return -1;
        int c = cols[i] + 1;
        int x = new_node(d);
        if (x < 0) return -1;
        node_t *n = d->n;
        /* insert at the bottom of column c */
        n[x].col = c;
        n[x].row_id = row_id;
        n[x].down = c;
        n[x].up = n[c].up;
        n[n[c].up].down = x;
        n[c].up = x;
        d->size[c]++;
        /* insert at the end of the row */
        if (first < 0) {
            first = x;
            n[x].left = n[x].right = x;
        } else {
            n[x].right = first;
            n[x].left = n[first].left;
            n[n[first].left].right = x;
            n[first].left = x;
        }
    }
    d->row_first[row_id] = first;
    return 0;
}

static void cover(dlx_t *d, int c) {
    node_t *n = d->n;
    d->covered[c] = 1;
    n[n[c].right].left = n[c].left;
    n[n[c].left].right = n[c].right;
    for (int i = n[c].down; i != c; i = n[i].down) {
        for (int j = n[i].right; j != i; j = n[j].right) {
            n[n[j].down].up = n[j].up;
            n[n[j].up].down = n[j].down;
            d->size[n[j].col]--;
        }
    }
}

static void uncover(dlx_t *d, int c) {
    node_t *n = d->n;
    for (int i = n[c].up; i != c; i = n[i].up) {
        for (int j = n[i].left; j != i; j = n[j].left) {
            d->size[n[j].col]++;
            n[n[j].down].up = j;
            n[n[j].up].down = j;
        }
    }
    n[n[c].right].left = c;
    n[n[c].left].right = c;
    d->covered[c] = 0;
}

int dlx_select_row(dlx_t *d, int row_id) {
    if (row_id < 0 || row_id >= d->rows_cap || d->row_first[row_id] < 0) return -1;
    int r = d->row_first[row_id], j = r;
    /* A row is still available iff none of its columns has been covered. */
    do {
        if (d->covered[d->n[j].col]) return -1;
        j = d->n[j].right;
    } while (j != r);
    do {
        cover(d, d->n[j].col);
        j = d->n[j].right;
    } while (j != r);
    d->solution[d->depth++] = row_id;
    d->preselected = d->depth;
    return 0;
}

static void search(dlx_t *d) {
    node_t *n = d->n;
    d->nodes++;
    if (n[ROOT].right == ROOT) {
        d->found++;
        if (d->visit && d->visit(d->solution, d->depth, d->ctx)) d->stop = 1;
        if (d->limit > 0 && d->found >= d->limit) d->stop = 1;
        return;
    }
    /* Knuth's S heuristic: branch on the column with the fewest candidates. */
    int c = n[ROOT].right, best = d->size[c];
    for (int j = n[c].right; j != ROOT; j = n[j].right) {
        if (d->size[j] < best) {
            best = d->size[j];
            c = j;
            if (best <= 1) break;
        }
    }
    if (best == 0) return; /* dead end */

    cover(d, c);
    for (int r = n[c].down; r != c && !d->stop; r = n[r].down) {
        d->solution[d->depth++] = n[r].row_id;
        for (int j = n[r].right; j != r; j = n[j].right) cover(d, n[j].col);
        search(d);
        for (int j = n[r].left; j != r; j = n[j].left) uncover(d, n[j].col);
        d->depth--;
    }
    uncover(d, c);
}

long dlx_solve(dlx_t *d, long limit, dlx_visit_fn visit, void *ctx) {
    d->limit = limit;
    d->visit = visit;
    d->ctx = ctx;
    d->found = 0;
    d->nodes = 0;
    d->stop = 0;
    d->depth = d->preselected;
    search(d);
    return d->found;
}

long dlx_nodes(const dlx_t *d) { return d->nodes; }
