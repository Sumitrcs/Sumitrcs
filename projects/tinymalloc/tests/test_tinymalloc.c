#include "../src/tinymalloc.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures;
static int checks;

#define CHECK(cond) do { \
    checks++; \
    if (!(cond)) { failures++; fprintf(stderr, "%s:%d: CHECK(%s) failed\n", __FILE__, __LINE__, #cond); } \
} while (0)

#define CHECK_HEAP(h) do { \
    char why_[160]; \
    int ok_ = tm_check((h), why_, sizeof why_) == 0; \
    checks++; \
    if (!ok_) { failures++; fprintf(stderr, "%s:%d: heap check failed: %s\n", __FILE__, __LINE__, why_); } \
} while (0)

static _Alignas(16) unsigned char arena[1 << 20];

static tm_heap *fresh(size_t size) {
    memset(arena, 0xAB, sizeof arena); /* garbage, like real memory */
    return tm_create(arena, size);
}

/* Error handler for tests: remember the last message instead of aborting. */
static char last_error[128];
static void record_error(const char *message, void *ptr) {
    (void)ptr;
    snprintf(last_error, sizeof last_error, "%s", message);
}

static void test_create(void) {
    CHECK(tm_create(arena, 64) == NULL);
    CHECK(tm_create(NULL, 4096) == NULL);
    tm_heap *h = fresh(4096);
    CHECK(h != NULL);
    tm_stats s = tm_get_stats(h);
    CHECK(s.blocks == 1 && s.free_blocks == 1 && s.used_bytes == 0);
    CHECK(s.heap_bytes > 3900 && s.heap_bytes % 16 == 0);
    CHECK_HEAP(h);

    /* Works with an arena that starts at an odd address too. */
    h = tm_create(arena + 3, 4096);
    void *p = tm_malloc(h, 10);
    CHECK(p && (uintptr_t)p % 16 == 0);
    CHECK_HEAP(h);
}

static void test_alignment_and_usable_size(void) {
    tm_heap *h = fresh(sizeof arena);
    for (size_t n = 1; n <= 300; n++) {
        char *p = tm_malloc(h, n);
        CHECK(p != NULL);
        CHECK((uintptr_t)p % TM_ALIGN == 0);
        CHECK(tm_usable_size(h, p) >= n);
        CHECK(tm_usable_size(h, p) < n + 32);
        memset(p, 0x5A, n); /* must not damage the heap */
    }
    CHECK_HEAP(h);
}

static void test_edge_cases(void) {
    tm_heap *h = fresh(4096);
    CHECK(tm_malloc(h, 0) == NULL);
    CHECK(tm_malloc(h, SIZE_MAX) == NULL);
    CHECK(tm_malloc(h, SIZE_MAX - 8) == NULL);
    CHECK(tm_malloc(h, 1 << 20) == NULL); /* bigger than the arena */
    tm_free(h, NULL);                     /* allowed, does nothing */
    CHECK_HEAP(h);

    /* Fill the heap completely, then one more byte fails cleanly. */
    void *ptrs[200];
    int n = 0;
    while (n < 200 && (ptrs[n] = tm_malloc(h, 100)) != NULL) {
        n++;
    }
    CHECK(n > 10 && n < 200);
    CHECK(tm_get_stats(h).largest_free < 100); /* that's why the next one failed */
    CHECK_HEAP(h);
    for (int i = 0; i < n; i++) {
        tm_free(h, ptrs[i]);
    }
    CHECK(tm_get_stats(h).free_blocks == 1);
}

static void test_split_and_coalesce(void) {
    tm_heap *h = fresh(4096);
    size_t whole = tm_get_stats(h).heap_bytes;
    char *a = tm_malloc(h, 100), *b = tm_malloc(h, 100), *c = tm_malloc(h, 100);
    CHECK(tm_get_stats(h).blocks == 4); /* a, b, c, and the rest */
    CHECK(b == a + 128 && c == b + 128);  /* 100 + 16 bytes of tags → 128-byte blocks */

    tm_free(h, b); /* neighbours both used: no merge */
    CHECK(tm_get_stats(h).free_blocks == 2);
    tm_free(h, a); /* merges with b on its right */
    CHECK(tm_get_stats(h).free_blocks == 2);
    CHECK_HEAP(h);
    tm_free(h, c); /* merges left (a+b) and right (the rest): one block again */
    tm_stats s = tm_get_stats(h);
    CHECK(s.blocks == 1 && s.free_bytes == whole && s.used_bytes == 0);
    CHECK_HEAP(h);
}

static void test_freed_memory_is_reused(void) {
    tm_heap *h = fresh(4096);
    void *a = tm_malloc(h, 200);
    tm_malloc(h, 10); /* keeps a's block from merging with the rest */
    tm_free(h, a);
    CHECK(tm_malloc(h, 200) == a);
    CHECK_HEAP(h);
}

static void test_first_fit_vs_best_fit(void) {
    for (int policy = TM_FIRST_FIT; policy <= TM_BEST_FIT; policy++) {
        tm_heap *h = fresh(8192);
        tm_set_policy(h, (tm_policy)policy);
        char *small = tm_malloc(h, 64);
        tm_malloc(h, 16);
        char *big = tm_malloc(h, 1024);
        tm_malloc(h, 16);
        tm_free(h, small); /* list: small */
        tm_free(h, big);   /* list: big, small  (newest first) */
        char *p = tm_malloc(h, 48);
        /* First fit takes the first block that fits (the big one); best fit
         * takes the one that wastes least (the small one). */
        CHECK(p == (policy == TM_FIRST_FIT ? big : small));
        CHECK_HEAP(h);
    }
}

static void test_realloc(void) {
    tm_heap *h = fresh(8192);
    CHECK(tm_realloc(h, NULL, 0) == NULL);

    char *p = tm_realloc(h, NULL, 40); /* NULL → malloc */
    CHECK(p != NULL);
    for (int i = 0; i < 40; i++) p[i] = (char)i;

    /* Next block is the free rest of the heap: grows in place. */
    char *q = tm_realloc(h, p, 400);
    CHECK(q == p);
    CHECK(memcmp(q, "\0\1\2\3\4\5\6\7", 8) == 0);

    /* Shrinking keeps the pointer and gives the tail back. */
    size_t free_before = tm_get_stats(h).free_bytes;
    CHECK(tm_realloc(h, q, 50) == q);
    CHECK(tm_get_stats(h).free_bytes > free_before);
    CHECK_HEAP(h);

    /* Blocked on the right: must move, and keep the contents. */
    char *wall = tm_malloc(h, 16);
    char *moved = tm_realloc(h, q, 500);
    CHECK(moved != q && moved != NULL);
    for (int i = 0; i < 40; i++) CHECK(moved[i] == (char)i);
    CHECK_HEAP(h);

    /* Failure leaves the old block untouched. */
    CHECK(tm_realloc(h, moved, 1 << 20) == NULL);
    CHECK(moved[39] == 39);
    CHECK(tm_usable_size(h, moved) >= 500);

    /* realloc(p, 0) frees. */
    CHECK(tm_realloc(h, moved, 0) == NULL);
    tm_free(h, wall);
    CHECK(tm_get_stats(h).used_bytes == 0);
    CHECK_HEAP(h);
}

static void test_calloc(void) {
    tm_heap *h = fresh(8192);
    unsigned char *p = tm_malloc(h, 256);
    memset(p, 0xFF, 256);
    tm_free(h, p);
    unsigned char *z = tm_calloc(h, 64, 4); /* reuses the dirty block */
    CHECK(z != NULL);
    int all_zero = 1;
    for (int i = 0; i < 256; i++) all_zero &= z[i] == 0;
    CHECK(all_zero);
    CHECK(tm_calloc(h, SIZE_MAX / 2, 3) == NULL); /* count × size overflows */
    CHECK_HEAP(h);
}

static void test_misuse_is_reported(void) {
    tm_heap *h = fresh(4096);
    tm_set_error_handler(h, record_error);
    char *p = tm_malloc(h, 32);
    tm_malloc(h, 32);

    tm_free(h, p);
    last_error[0] = 0;
    tm_free(h, p);
    CHECK(strcmp(last_error, "tm_free(): double free or pointer to a free block") == 0);

    char *q = tm_malloc(h, 64);
    last_error[0] = 0;
    tm_free(h, q + 16);
    CHECK(strstr(last_error, "tm_free()") != NULL);

    int on_stack;
    last_error[0] = 0;
    tm_free(h, &on_stack);
    CHECK(strcmp(last_error, "tm_free(): pointer was not returned by tm_malloc") == 0);

    last_error[0] = 0;
    CHECK(tm_realloc(h, &on_stack, 10) == NULL);
    CHECK(strcmp(last_error, "tm_realloc(): pointer was not returned by tm_malloc") == 0);
    CHECK_HEAP(h); /* misuse was caught before it could damage anything */
}

static void test_checker_catches_overflow(void) {
    tm_heap *h = fresh(4096);
    char *p = tm_malloc(h, 24);
    tm_malloc(h, 24);
    CHECK_HEAP(h);
    memset(p, 'x', tm_usable_size(h, p) + 4); /* a classic buffer overflow */
    char why[160];
    CHECK(tm_check(h, why, sizeof why) == -1);
    CHECK(strstr(why, "header and footer differ") != NULL);
}

static void test_stats_and_dump(void) {
    tm_heap *h = fresh(4096);
    void *a = tm_malloc(h, 1000), *b = tm_malloc(h, 1000);
    tm_stats s = tm_get_stats(h);
    CHECK(s.used_bytes == 2 * 1024);
    CHECK(s.peak_used == 2 * 1024);
    tm_free(h, a);
    s = tm_get_stats(h);
    CHECK(s.used_bytes == 1024 && s.peak_used == 2 * 1024);
    CHECK(s.free_blocks == 2);

    FILE *out = tmpfile();
    tm_dump(h, out, 16);
    rewind(out);
    char text[512] = {0};
    size_t n = fread(text, 1, sizeof text - 1, out);
    fclose(out);
    CHECK(n > 0);
    CHECK(strstr(text, "  +0       free     1024 bytes\n") != NULL);
    CHECK(strstr(text, "  +1024    used     1024 bytes\n") != NULL);
    CHECK(strstr(text, "largest request possible 1952") != NULL);
    CHECK(strstr(text, "[....####") != NULL);
    tm_free(h, b);
}

/* Thousands of random operations against a shadow copy of what every block
 * should contain. Any overlap, lost data or broken invariant shows up. */
static uint64_t rng = 88172645463325252ULL;
static uint64_t next_random(void) {
    rng ^= rng << 13;
    rng ^= rng >> 7;
    rng ^= rng << 17;
    return rng;
}

#define SLOTS 600

static int verify(const unsigned char *p, size_t n, unsigned char fill) {
    for (size_t i = 0; i < n; i++) {
        if (p[i] != (unsigned char)(fill + i)) return 0;
    }
    return 1;
}

static void fill_block(unsigned char *p, size_t n, unsigned char fill) {
    for (size_t i = 0; i < n; i++) p[i] = (unsigned char)(fill + i);
}

static int cmp_ptr(const void *a, const void *b) {
    uintptr_t x = *(const uintptr_t *)a, y = *(const uintptr_t *)b;
    return x < y ? -1 : x > y;
}

static void test_random_stress(void) {
    for (int policy = TM_FIRST_FIT; policy <= TM_BEST_FIT; policy++) {
        tm_heap *h = fresh(sizeof arena);
        tm_set_policy(h, (tm_policy)policy);
        unsigned char *ptr[SLOTS] = {0};
        size_t size[SLOTS] = {0};
        unsigned char fill[SLOTS] = {0};
        int bad_data = 0, ops = 0, out_of_memory = 0;

        for (int step = 0; step < 100000; step++) {
            int i = (int)(next_random() % SLOTS);
            /* Mostly small sizes, sometimes large, like real programs. */
            size_t n = next_random() % 8 == 0 ? 1 + next_random() % 8000 : 1 + next_random() % 200;
            ops++;
            if (!ptr[i]) {
                ptr[i] = next_random() % 4 ? tm_malloc(h, n) : tm_calloc(h, 1, n);
                if (!ptr[i]) { out_of_memory++; continue; }
                size[i] = n;
                fill[i] = (unsigned char)next_random();
                fill_block(ptr[i], n, fill[i]);
            } else if (next_random() % 3 == 0) {
                if (!verify(ptr[i], size[i], fill[i])) bad_data++;
                unsigned char *q = tm_realloc(h, ptr[i], n);
                if (!q) { out_of_memory++; continue; }
                size_t kept = size[i] < n ? size[i] : n;
                if (!verify(q, kept, fill[i])) bad_data++;
                ptr[i] = q;
                size[i] = n;
                fill_block(q, n, fill[i]);
            } else {
                if (!verify(ptr[i], size[i], fill[i])) bad_data++;
                tm_free(h, ptr[i]);
                ptr[i] = NULL;
            }
            if (step % 2000 == 0) {
                CHECK_HEAP(h);
                /* No two live blocks may overlap. */
                uintptr_t starts[SLOTS];
                int live = 0;
                for (int k = 0; k < SLOTS; k++) {
                    if (ptr[k]) starts[live++] = (uintptr_t)ptr[k];
                }
                qsort(starts, (size_t)live, sizeof starts[0], cmp_ptr);
                for (int k = 1; k < live; k++) {
                    void *prev = (void *)starts[k - 1];
                    CHECK(starts[k - 1] + tm_usable_size(h, prev) <= starts[k]);
                }
            }
        }
        CHECK(bad_data == 0);
        CHECK(out_of_memory < ops / 100);
        CHECK_HEAP(h);
        for (int k = 0; k < SLOTS; k++) tm_free(h, ptr[k]);
        tm_stats s = tm_get_stats(h);
        CHECK(s.used_bytes == 0 && s.free_blocks == 1); /* everything merged back */
    }
}

int main(void) {
    test_create();
    test_alignment_and_usable_size();
    test_edge_cases();
    test_split_and_coalesce();
    test_freed_memory_is_reused();
    test_first_fit_vs_best_fit();
    test_realloc();
    test_calloc();
    test_misuse_is_reported();
    test_checker_catches_overflow();
    test_stats_and_dump();
    test_random_stress();
    if (failures) {
        fprintf(stderr, "%d of %d checks FAILED\n", failures, checks);
        return 1;
    }
    printf("all %d checks passed\n", checks);
    return 0;
}
