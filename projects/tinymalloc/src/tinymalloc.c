/*
 * tinymalloc — implementation.
 *
 * The heap is one long run of blocks laid end to end. Every block starts with
 * a header and ends with a footer (a copy of the header: the "boundary tag").
 *
 *     header  = block size | allocated bit       (8 bytes)
 *     payload = what the program gets            (size − 16 bytes)
 *     footer  = same as header                   (8 bytes)
 *
 * Block sizes are multiples of 16, so the low 4 bits of a size are always zero
 * and bit 0 is free to hold the "allocated" flag.
 *
 * The footer is what makes free() fast: the word just before a block's header
 * is the previous block's footer, so we can find and merge with a free
 * neighbour on the left without searching.
 *
 * Free blocks also keep two pointers in their (unused) payload, linking every
 * free block into a doubly linked "free list". malloc() only has to search
 * that list, not the whole heap.
 *
 * The heap is bracketed by two fake blocks that are always "allocated": a
 * prologue at the start and an epilogue (a header of size 0) at the end. With
 * them, the first and last real blocks need no special cases.
 *
 *     | prologue | block | block | ... | block | epilogue |
 */
#include "tinymalloc.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <assert.h>

#define TAG        8   /* bytes in a header or footer */
#define MIN_BLOCK  32  /* header + two list pointers + footer, rounded to 16 */
#define ALLOCATED  ((uint64_t)1)

typedef struct {
    char *prev;
    char *next;
} free_links;

static_assert(2 * TAG + sizeof(free_links) <= MIN_BLOCK, "a free block must fit its list pointers");

struct tm_heap {
    char *first;          /* first real block (just after the prologue) */
    char *epilogue;       /* the size-0 header that ends the heap */
    char *free_list;      /* most recently freed block, or NULL */
    tm_policy policy;
    tm_error_fn on_error;
    size_t used;
    size_t peak_used;
};

/* ---- reading and writing boundary tags ---------------------------------- */
/* `b` always points at a block's header. */

static uint64_t get_tag(const char *p) {
    uint64_t v;
    memcpy(&v, p, sizeof v);
    return v;
}

static void put_tag(char *p, uint64_t v) {
    memcpy(p, &v, sizeof v);
}

static size_t block_size(const char *b) { return (size_t)(get_tag(b) & ~(uint64_t)15); }
static int is_allocated(const char *b) { return (int)(get_tag(b) & ALLOCATED); }
static char *footer(char *b) { return b + block_size(b) - TAG; }
static char *next_block(char *b) { return b + block_size(b); }
static char *prev_block(char *b) { return b - block_size(b - TAG); /* b - TAG is the previous footer */ }
static void *payload(char *b) { return b + TAG; }
static char *block_of(void *p) { return (char *)p - TAG; }
static free_links *links(char *b) { return (free_links *)(void *)(b + TAG); }

static void set_block(char *b, size_t size, int allocated) {
    uint64_t tag = (uint64_t)size | (allocated ? ALLOCATED : 0);
    put_tag(b, tag);
    put_tag(b + size - TAG, tag);
}

static size_t align_up(size_t n, size_t a) { return (n + a - 1) / a * a; }

/* Block size needed for a request: payload + both tags, rounded up to 16, and
 * never smaller than a free block (which must hold the two list pointers). */
static int block_size_for(size_t request, size_t *out) {
    if (request > SIZE_MAX - 2 * TAG - TM_ALIGN) {
        return 0;
    }
    size_t size = align_up(request + 2 * TAG, TM_ALIGN);
    *out = size < MIN_BLOCK ? MIN_BLOCK : size;
    return 1;
}

/* ---- the free list ------------------------------------------------------ */

static void list_push(tm_heap *h, char *b) {
    links(b)->prev = NULL;
    links(b)->next = h->free_list;
    if (h->free_list) {
        links(h->free_list)->prev = b;
    }
    h->free_list = b;
}

static void list_remove(tm_heap *h, char *b) {
    free_links *l = links(b);
    if (l->prev) {
        links(l->prev)->next = l->next;
    } else {
        h->free_list = l->next;
    }
    if (l->next) {
        links(l->next)->prev = l->prev;
    }
}

/* ---- setup -------------------------------------------------------------- */

static void default_error(const char *message, void *ptr) {
    fprintf(stderr, "tinymalloc: %s (pointer %p)\n", message, ptr);
    abort();
}

tm_heap *tm_create(void *memory, size_t size) {
    if (!memory) {
        return NULL;
    }
    uintptr_t start = (uintptr_t)memory;
    uintptr_t end = start + size;
    uintptr_t heap_struct = align_up(start, _Alignof(max_align_t));
    uintptr_t after_struct = heap_struct + sizeof(tm_heap);
    /* The prologue header sits at an address ≡ 8 (mod 16), so that every block
     * header after it is too, and every payload (header + 8) is 16-aligned. */
    uintptr_t prologue = align_up(after_struct + TAG, TM_ALIGN) - TAG;
    uintptr_t first = prologue + 2 * TAG;
    if (end < start || end < first + MIN_BLOCK + TAG) {
        return NULL;
    }
    size_t span = (size_t)(end - first - TAG) / TM_ALIGN * TM_ALIGN; /* room for blocks */
    if (span < MIN_BLOCK) {
        return NULL;
    }

    tm_heap *h = (tm_heap *)heap_struct;
    memset(h, 0, sizeof *h);
    h->policy = TM_FIRST_FIT;
    h->on_error = default_error;
    h->first = (char *)first;
    h->epilogue = h->first + span;

    set_block((char *)prologue, 2 * TAG, 1);
    put_tag(h->epilogue, ALLOCATED); /* size 0, allocated */
    set_block(h->first, span, 0);    /* one big free block */
    list_push(h, h->first);
    return h;
}

void tm_set_policy(tm_heap *h, tm_policy policy) { h->policy = policy; }

void tm_set_error_handler(tm_heap *h, tm_error_fn handler) {
    h->on_error = handler ? handler : default_error;
}

/* ---- malloc ------------------------------------------------------------- */

static char *find_fit(tm_heap *h, size_t size) {
    char *best = NULL;
    for (char *b = h->free_list; b; b = links(b)->next) {
        size_t s = block_size(b);
        if (s < size) {
            continue;
        }
        if (h->policy == TM_FIRST_FIT || s == size) {
            return b;
        }
        if (!best || s < block_size(best)) {
            best = b;
        }
    }
    return best;
}

/* Marks free block `b` allocated with `size` bytes, splitting off the rest as
 * a new free block when it is big enough to be one. */
static void place(tm_heap *h, char *b, size_t size) {
    size_t total = block_size(b);
    list_remove(h, b);
    if (total - size >= MIN_BLOCK) {
        set_block(b, size, 1);
        char *rest = next_block(b);
        set_block(rest, total - size, 0);
        list_push(h, rest);
    } else {
        set_block(b, total, 1); /* too small to split: hand over a few spare bytes */
    }
    h->used += block_size(b);
    if (h->used > h->peak_used) {
        h->peak_used = h->used;
    }
}

void *tm_malloc(tm_heap *h, size_t request) {
    size_t size;
    if (request == 0 || !block_size_for(request, &size)) {
        return NULL;
    }
    char *b = find_fit(h, size);
    if (!b) {
        return NULL; /* out of memory: the arena can't grow */
    }
    place(h, b, size);
    return payload(b);
}

void *tm_calloc(tm_heap *h, size_t count, size_t size) {
    if (size && count > SIZE_MAX / size) {
        return NULL; /* count * size would overflow */
    }
    void *p = tm_malloc(h, count * size);
    if (p) {
        memset(p, 0, count * size);
    }
    return p;
}

/* ---- free --------------------------------------------------------------- */

/* Merges free block `b` with free neighbours and returns the merged block,
 * which is not on the free list yet. Four cases, depending on whether the
 * blocks before and after are free. */
static char *coalesce(tm_heap *h, char *b) {
    char *next = next_block(b);
    size_t size = block_size(b);
    if (!is_allocated(next)) {
        list_remove(h, next);
        size += block_size(next);
    }
    if (!is_allocated(b - TAG)) { /* previous block's footer */
        char *prev = prev_block(b);
        list_remove(h, prev);
        size += block_size(prev);
        b = prev;
    }
    set_block(b, size, 0);
    return b;
}

/* Cheap sanity checks on a pointer passed to free/realloc. */
static int valid_block(tm_heap *h, void *p, const char *who) {
    char *b = block_of(p);
    char why[96];
    uintptr_t at = (uintptr_t)b;
    if ((uintptr_t)p % TM_ALIGN != 0 || at < (uintptr_t)h->first || at >= (uintptr_t)h->epilogue) {
        snprintf(why, sizeof why, "%s(): pointer was not returned by tm_malloc", who);
    } else if (!is_allocated(b)) {
        snprintf(why, sizeof why, "%s(): double free or pointer to a free block", who);
    } else if (block_size(b) < MIN_BLOCK || b + block_size(b) > h->epilogue ||
               get_tag(footer(b)) != get_tag(b)) {
        snprintf(why, sizeof why, "%s(): heap corrupted (bad boundary tags)", who);
    } else {
        return 1;
    }
    h->on_error(why, p);
    return 0;
}

void tm_free(tm_heap *h, void *p) {
    if (!p || !valid_block(h, p, "tm_free")) {
        return;
    }
    char *b = block_of(p);
    h->used -= block_size(b);
    set_block(b, block_size(b), 0);
    list_push(h, coalesce(h, b));
}

size_t tm_usable_size(tm_heap *h, void *p) {
    if (!p || !valid_block(h, p, "tm_usable_size")) {
        return 0;
    }
    return block_size(block_of(p)) - 2 * TAG;
}

/* ---- realloc ------------------------------------------------------------ */

/* Shrinks allocated block `b` to `size`, giving the tail back to the heap. */
static void shrink(tm_heap *h, char *b, size_t size) {
    size_t total = block_size(b);
    if (total - size < MIN_BLOCK) {
        return;
    }
    set_block(b, size, 1);
    char *rest = next_block(b);
    set_block(rest, total - size, 0);
    h->used -= total - size;
    list_push(h, coalesce(h, rest));
}

void *tm_realloc(tm_heap *h, void *p, size_t request) {
    if (!p) {
        return tm_malloc(h, request);
    }
    if (request == 0) {
        tm_free(h, p);
        return NULL;
    }
    size_t size;
    if (!valid_block(h, p, "tm_realloc") || !block_size_for(request, &size)) {
        return NULL;
    }
    char *b = block_of(p);
    size_t have = block_size(b);

    /* 1. Already big enough: keep it where it is (maybe giving back the tail). */
    if (size <= have) {
        shrink(h, b, size);
        return p;
    }
    /* 2. The next block is free and the two together are enough: grow in place. */
    char *next = next_block(b);
    if (!is_allocated(next) && have + block_size(next) >= size) {
        list_remove(h, next);
        set_block(b, have + block_size(next), 1);
        h->used += block_size(next);
        if (h->used > h->peak_used) {
            h->peak_used = h->used;
        }
        shrink(h, b, size);
        return p;
    }
    /* 3. Otherwise move: allocate, copy, free. On failure the old block stays. */
    void *moved = tm_malloc(h, request);
    if (moved) {
        memcpy(moved, p, have - 2 * TAG);
        tm_free(h, p);
    }
    return moved;
}

/* ---- inspection --------------------------------------------------------- */

tm_stats tm_get_stats(tm_heap *h) {
    tm_stats s = {0};
    s.heap_bytes = (size_t)(h->epilogue - h->first);
    s.peak_used = h->peak_used;
    for (char *b = h->first; b < h->epilogue; b = next_block(b)) {
        s.blocks++;
        if (is_allocated(b)) {
            s.used_bytes += block_size(b);
        } else {
            s.free_blocks++;
            s.free_bytes += block_size(b);
            if (block_size(b) - 2 * TAG > s.largest_free) {
                s.largest_free = block_size(b) - 2 * TAG;
            }
        }
    }
    return s;
}

#define FAIL(...) do { snprintf(why, why_len, __VA_ARGS__); return -1; } while (0)

int tm_check(tm_heap *h, char *why, size_t why_len) {
    char scratch[1];
    if (!why || why_len == 0) {
        why = scratch;
        why_len = sizeof scratch;
    }
    size_t free_in_heap = 0, used = 0;
    int prev_free = 0;
    char *b = h->first;
    for (; b < h->epilogue; b = next_block(b)) {
        size_t off = (size_t)(b - h->first);
        size_t size = block_size(b);
        if ((uintptr_t)payload(b) % TM_ALIGN) FAIL("block at +%zu: payload not %d-aligned", off, TM_ALIGN);
        if (size < MIN_BLOCK || size % TM_ALIGN) FAIL("block at +%zu: bad size %zu", off, size);
        if (b + size > h->epilogue) FAIL("block at +%zu: runs past the end of the heap", off);
        if (get_tag(b) != get_tag(footer(b))) FAIL("block at +%zu: header and footer differ", off);
        if (!is_allocated(b)) {
            if (prev_free) FAIL("block at +%zu: two free blocks in a row (missed coalesce)", off);
            free_in_heap++;
        } else {
            used += size;
        }
        prev_free = !is_allocated(b);
    }
    if (b != h->epilogue) FAIL("blocks do not end exactly at the epilogue");
    if (block_size(h->epilogue) != 0 || !is_allocated(h->epilogue)) FAIL("epilogue overwritten");
    if (used != h->used) FAIL("used-bytes counter is %zu but blocks add up to %zu", h->used, used);

    size_t free_in_list = 0;
    char *prev = NULL;
    for (char *f = h->free_list; f; f = links(f)->next) {
        if (f < h->first || f >= h->epilogue) FAIL("free list points outside the heap");
        if (is_allocated(f)) FAIL("free list contains an allocated block at +%zu", (size_t)(f - h->first));
        if (links(f)->prev != prev) FAIL("free list back-link broken at +%zu", (size_t)(f - h->first));
        if (++free_in_list > free_in_heap) FAIL("free list is longer than the number of free blocks (cycle?)");
        prev = f;
    }
    if (free_in_list != free_in_heap) {
        FAIL("%zu free blocks in the heap but %zu on the free list", free_in_heap, free_in_list);
    }
    return 0;
}

void tm_dump(tm_heap *h, FILE *out, int width) {
    tm_stats s = tm_get_stats(h);
    for (char *b = h->first; b < h->epilogue; b = next_block(b)) {
        fprintf(out, "  +%-7zu %-5s %7zu bytes\n", (size_t)(b - h->first),
                is_allocated(b) ? "used" : "free", block_size(b));
    }
    /* Picture: each character stands for heap_bytes / width bytes and shows
     * the block in the middle of that stretch: '#' used, '.' free. */
    if (width < 8) {
        width = 8;
    }
    fputc('[', out);
    char *b = h->first;
    for (int i = 0; i < width; i++) {
        size_t middle = s.heap_bytes * (2 * (size_t)i + 1) / (2 * (size_t)width);
        while ((size_t)(next_block(b) - h->first) <= middle) {
            b = next_block(b);
        }
        fputc(is_allocated(b) ? '#' : '.', out);
    }
    fprintf(out, "]\n  %zu used, %zu free in %zu free block%s, largest request possible %zu\n",
            s.used_bytes, s.free_bytes, s.free_blocks, s.free_blocks == 1 ? "" : "s", s.largest_free);
}
