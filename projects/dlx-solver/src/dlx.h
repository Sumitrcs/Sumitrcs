/*
 * dlx.h — Knuth's Algorithm X with Dancing Links.
 *
 * Solves exact cover: given a matrix of 0/1, choose rows so that every
 * primary column has exactly one 1 and every secondary column at most one.
 */
#ifndef DLX_H
#define DLX_H

#include <stddef.h>

typedef struct dlx dlx_t;

/* Called for every solution; `rows` holds the chosen row ids. Return non-zero to stop. */
typedef int (*dlx_visit_fn)(const int *rows, int count, void *ctx);

/* Creates a matrix with `primary` primary columns followed by `secondary` secondary columns. */
dlx_t *dlx_new(int primary, int secondary);
void dlx_free(dlx_t *d);

/* Adds a row covering the given column indexes (0-based). Returns 0 on success. */
int dlx_add_row(dlx_t *d, int row_id, const int *cols, int ncols);

/* Pre-selects a row (e.g. a sudoku clue). Returns -1 if it conflicts with an earlier choice. */
int dlx_select_row(dlx_t *d, int row_id);

/*
 * Searches for solutions, calling `visit` for each (may be NULL).
 * Stops after `limit` solutions when limit > 0. Returns the number found.
 */
long dlx_solve(dlx_t *d, long limit, dlx_visit_fn visit, void *ctx);

/* Search nodes visited during the last dlx_solve (a measure of effort). */
long dlx_nodes(const dlx_t *d);

#endif
