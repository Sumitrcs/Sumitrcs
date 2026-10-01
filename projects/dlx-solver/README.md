# dlx-solver

**Knuth's Algorithm X with Dancing Links**, implemented in portable C11 with
no dependencies, plus two classic applications built on top of it: a
**Sudoku solver** (4×4 up to 25×25) and an **N-Queens** counter.

```
$ ./build/dlx sudoku --pretty < puzzles/hard.txt      # "AI Escargot"
1 6 2 | 8 5 7 | 4 9 3
5 3 4 | 1 2 9 | 6 7 8
7 8 9 | 6 4 3 | 5 2 1
------+-------+------
4 7 5 | 3 1 2 | 9 8 6
9 1 3 | 5 8 6 | 7 4 2
6 2 8 | 7 9 4 | 1 3 5
------+-------+------
3 5 6 | 4 7 8 | 2 1 9
2 4 1 | 9 3 5 | 8 6 7
8 9 7 | 2 6 1 | 3 5 4

#1 unique, 1520 search nodes, 0.55 ms
```

```
$ ./build/dlx queens 12
12-queens: 14200 solutions (339305 nodes, 56.4 ms)
```

## Why Dancing Links

Many puzzles reduce to **exact cover**: pick rows of a 0/1 matrix so every
column is covered exactly once. Algorithm X searches this by always branching
on the column with the fewest options. Dancing Links makes backtracking
almost free: each 1 is a node in a circular doubly-linked row list and column
list, and

```c
x->left->right = x->right;  x->right->left = x->left;   // remove
x->left->right = x;         x->right->left = x;         // restore — x still knows its neighbours
```

so undoing a choice is just relinking in reverse order — no copying.

## Modelling

| Problem | Rows (choices) | Columns (constraints) |
|---|---|---|
| Sudoku N×N | N³ — "digit d in cell (r,c)" | 4N² — each cell filled; each row/column/box has each digit once |
| N-Queens | N² — "queen on (r,c)" | 2N primary (ranks, files) + 2(2N−1) **secondary** (diagonals, at most one) |

## Features

- Generic exact-cover API in `src/dlx.h` — usable for pentominoes, scheduling, set partitioning
- Primary **and secondary** columns
- Pre-selected rows (puzzle clues) with conflict detection
- Solution callbacks, solution limits (`limit = 2` proves uniqueness), search-node counter
- Index-based node pool: one allocation that grows, cache-friendly, trivially freed
- Sudoku parser accepts `.`, `0`, `_` for blanks, ignores `|`, `-`, `+` and whitespace; digits `1-9` then `A-P` for larger grids

## Build & run

```bash
make                 # builds ./build/dlx
make test            # unit tests
make sanitize        # same tests under AddressSanitizer + UBSan
make bench
./build/dlx sudoku < puzzles/hard.txt
```

## Tests

- Knuth's example matrix from the original paper (and that the matrix is fully restored after search)
- N-Queens counts for N = 1…10 against the known sequence (1, 0, 0, 2, 10, 4, 40, 92, 352, 724)
- A famously hard Sudoku solves uniquely; removing clues yields multiple solutions; contradictory clues yield none
- Empty 4×4 Sudoku has exactly **288** solutions
- Input validation and formatting

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
