/*
 * dlx — exact-cover solver CLI.
 *
 *   dlx sudoku [--pretty] < puzzles.txt     one puzzle per line (81 / 256 chars)
 *   dlx queens N
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "queens.h"
#include "sudoku.h"

static double now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1e3 + ts.tv_nsec / 1e6;
}

static int run_sudoku(int pretty) {
    char line[4096], out[2048];
    int count = 0, failures = 0;
    double total = 0;
    while (fgets(line, sizeof line, stdin)) {
        if (line[0] == '#' || strspn(line, " \t\r\n") == strlen(line)) continue;
        sudoku_t p, s;
        if (sudoku_parse(line, &p) != 0) {
            fprintf(stderr, "skipping malformed puzzle: %.40s…\n", line);
            failures++;
            continue;
        }
        long nodes = 0;
        double t = now_ms();
        long found = sudoku_solve(&p, &s, 2, &nodes);
        double ms = now_ms() - t;
        total += ms;
        count++;
        if (found == 0) {
            printf("no solution\n");
            failures++;
            continue;
        }
        sudoku_format(&s, out, pretty);
        printf("%s%s", out, pretty ? "" : "\n");
        fprintf(stderr, "#%d %s, %ld search nodes, %.2f ms\n", count, found > 1 ? "MULTIPLE solutions" : "unique", nodes, ms);
        if (pretty) printf("\n");
    }
    fprintf(stderr, "solved %d puzzle(s) in %.1f ms (avg %.3f ms)\n", count, total, count ? total / count : 0);
    return failures ? 1 : 0;
}

int main(int argc, char **argv) {
    if (argc >= 2 && strcmp(argv[1], "sudoku") == 0) {
        return run_sudoku(argc >= 3 && strcmp(argv[2], "--pretty") == 0);
    }
    if (argc == 3 && strcmp(argv[1], "queens") == 0) {
        int n = atoi(argv[2]);
        if (n < 1 || n > 16) {
            fprintf(stderr, "N must be between 1 and 16\n");
            return 2;
        }
        long nodes;
        double t = now_ms();
        long sols = queens_count(n, &nodes);
        printf("%d-queens: %ld solutions (%ld nodes, %.1f ms)\n", n, sols, nodes, now_ms() - t);
        return 0;
    }
    fprintf(stderr, "usage:\n  %s sudoku [--pretty] < puzzles.txt\n  %s queens N\n", argv[0], argv[0]);
    return 2;
}
