/*
 * N-queens as exact cover with secondary columns: every rank and file must
 * hold exactly one queen (primary), each diagonal at most one (secondary).
 */
#include "queens.h"

#include "dlx.h"

long queens_count(int n, long *nodes) {
    int diag = 2 * n - 1;
    dlx_t *d = dlx_new(2 * n, 2 * diag);
    if (!d) return -1;
    for (int r = 0; r < n; r++)
        for (int c = 0; c < n; c++) {
            int cols[4] = {r, n + c, 2 * n + r + c, 2 * n + diag + (r - c + n - 1)};
            dlx_add_row(d, r * n + c, cols, 4);
        }
    long found = dlx_solve(d, 0, NULL, NULL);
    if (nodes) *nodes = dlx_nodes(d);
    dlx_free(d);
    return found;
}
