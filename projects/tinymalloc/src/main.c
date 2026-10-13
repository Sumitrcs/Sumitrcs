/*
 * tinymalloc command line.
 *
 *   tinymalloc demo                   step-by-step picture of a small heap
 *   tinymalloc trace FILE [ARENA]     replay an allocation trace with both
 *                                     fit policies and compare them
 *
 * Trace files have one operation per line ('#' starts a comment):
 *   a ID SIZE    allocate SIZE bytes and call the result ID
 *   r ID SIZE    realloc ID to SIZE bytes
 *   f ID         free ID
 */
#define _POSIX_C_SOURCE 199309L

#include "tinymalloc.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static void step(tm_heap *h, const char *what) {
    printf("\n%s\n", what);
    tm_dump(h, stdout, 48);
}

static int demo(void) {
    static _Alignas(16) unsigned char memory[1024];
    tm_heap *h = tm_create(memory, sizeof memory);
    step(h, "A fresh heap is one big free block:");

    char *a = tm_malloc(h, 100);
    char *b = tm_malloc(h, 200);
    char *c = tm_malloc(h, 100);
    step(h, "a = malloc(100), b = malloc(200), c = malloc(100) split it up:");

    tm_free(h, b);
    step(h, "free(b) leaves a hole between a and c:");

    char *d = tm_malloc(h, 50);
    step(h, "d = malloc(50) reuses part of the hole:");

    tm_free(h, a);
    tm_free(h, d);
    step(h, "free(a), free(d): neighbouring free blocks merge (coalesce):");

    c = tm_realloc(h, c, 300);
    step(h, "c = realloc(c, 300) grows c in place into the free space after it:");

    tm_free(h, c);
    step(h, "free(c): everything merges back into one block:");
    return 0;
}

typedef struct {
    char op;
    long id;
    size_t size;
} trace_op;

static trace_op *load_trace(const char *path, size_t *count, long *max_id) {
    FILE *f = fopen(path, "r");
    if (!f) {
        perror(path);
        return NULL;
    }
    size_t cap = 1024, n = 0;
    trace_op *ops = malloc(cap * sizeof *ops);
    char line[256];
    int lineno = 0;
    *max_id = -1;
    while (ops && fgets(line, sizeof line, f)) {
        lineno++;
        trace_op t = {0};
        char *s = line + strspn(line, " \t");
        if (*s == '#' || *s == '\n' || *s == '\0') {
            continue;
        }
        int ok = (sscanf(s, "%c %ld %zu", &t.op, &t.id, &t.size) == 3 && (t.op == 'a' || t.op == 'r')) ||
                 (sscanf(s, "%c %ld", &t.op, &t.id) == 2 && t.op == 'f');
        if (!ok || t.id < 0) {
            fprintf(stderr, "%s:%d: expected 'a ID SIZE', 'r ID SIZE' or 'f ID'\n", path, lineno);
            free(ops);
            fclose(f);
            return NULL;
        }
        if (n == cap) {
            trace_op *bigger = realloc(ops, (cap *= 2) * sizeof *ops);
            if (!bigger) {
                free(ops);
                ops = NULL;
                break;
            }
            ops = bigger;
        }
        if (t.id > *max_id) {
            *max_id = t.id;
        }
        ops[n++] = t;
    }
    fclose(f);
    *count = n;
    return ops;
}

typedef struct {
    size_t peak_payload;  /* most bytes the program held at once */
    size_t high_water;    /* furthest byte of the arena ever used */
    size_t failed;
    double seconds;
} run_result;

static run_result replay(const trace_op *ops, size_t count, long max_id, size_t arena_size, tm_policy policy) {
    run_result r = {0};
    unsigned char *arena = aligned_alloc(16, (arena_size + 15) / 16 * 16);
    void **ptr = calloc((size_t)max_id + 1, sizeof *ptr);
    size_t *size = calloc((size_t)max_id + 1, sizeof *size);
    if (!arena || !ptr || !size) {
        fprintf(stderr, "out of memory\n");
        exit(2);
    }
    tm_heap *h = tm_create(arena, arena_size);
    tm_set_policy(h, policy);
    size_t live = 0;
    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    for (size_t i = 0; i < count; i++) {
        const trace_op *t = &ops[i];
        void *p = NULL;
        if (t->op == 'f') {
            tm_free(h, ptr[t->id]);
            live -= size[t->id];
            ptr[t->id] = NULL;
            size[t->id] = 0;
            continue;
        }
        p = t->op == 'a' ? tm_malloc(h, t->size) : tm_realloc(h, ptr[t->id], t->size);
        if (!p) {
            r.failed++;
            continue;
        }
        live += t->size - size[t->id];
        ptr[t->id] = p;
        size[t->id] = t->size;
        if (live > r.peak_payload) {
            r.peak_payload = live;
        }
        size_t end = (size_t)((unsigned char *)p - arena) + tm_usable_size(h, p);
        if (end > r.high_water) {
            r.high_water = end;
        }
    }
    clock_gettime(CLOCK_MONOTONIC, &t1);
    r.seconds = (double)(t1.tv_sec - t0.tv_sec) + (double)(t1.tv_nsec - t0.tv_nsec) / 1e9;
    char why[160];
    if (tm_check(h, why, sizeof why) != 0) {
        fprintf(stderr, "heap check failed after trace: %s\n", why);
        exit(2);
    }
    free(arena);
    free(ptr);
    free(size);
    return r;
}

static int trace(const char *path, size_t arena_size) {
    size_t count;
    long max_id;
    trace_op *ops = load_trace(path, &count, &max_id);
    if (!ops) {
        return 2;
    }
    printf("%s: %zu operations, arena %zu KiB\n\n", path, count, arena_size / 1024);
    printf("%-10s %12s %12s %9s %8s %10s\n", "policy", "peak data", "high water", "util", "failed", "ops/sec");
    const char *names[] = {"first-fit", "best-fit"};
    for (int p = TM_FIRST_FIT; p <= TM_BEST_FIT; p++) {
        run_result r = replay(ops, count, max_id, arena_size, (tm_policy)p);
        double util = r.high_water ? 100.0 * (double)r.peak_payload / (double)r.high_water : 0;
        printf("%-10s %12zu %12zu %8.1f%% %8zu %10.0f\n", names[p], r.peak_payload, r.high_water, util, r.failed,
               r.seconds > 0 ? (double)count / r.seconds : 0);
    }
    free(ops);
    return 0;
}

int main(int argc, char **argv) {
    if (argc >= 2 && strcmp(argv[1], "demo") == 0) {
        return demo();
    }
    if (argc >= 3 && strcmp(argv[1], "trace") == 0) {
        size_t arena = argc >= 4 ? (size_t)strtoull(argv[3], NULL, 10) : (size_t)16 << 20;
        return trace(argv[2], arena < 4096 ? 4096 : arena);
    }
    fprintf(stderr, "usage: tinymalloc demo\n       tinymalloc trace FILE [ARENA_BYTES]\n");
    return 2;
}
