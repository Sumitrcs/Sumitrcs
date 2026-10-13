/*
 * tinymalloc — a small, readable memory allocator.
 *
 * It manages a block of memory you give it (an "arena") and hands out pieces
 * of it, exactly like malloc/free do with the memory the OS gives a process.
 *
 *     static unsigned char memory[1 << 20];
 *     tm_heap *heap = tm_create(memory, sizeof memory);
 *     char *s = tm_malloc(heap, 100);
 *     tm_free(heap, s);
 */
#ifndef TINYMALLOC_H
#define TINYMALLOC_H

#include <stddef.h>
#include <stdio.h>

/* Every pointer returned is aligned to this many bytes, like glibc on 64-bit. */
#define TM_ALIGN 16

typedef struct tm_heap tm_heap;

typedef enum {
    TM_FIRST_FIT, /* take the first free block that is big enough (fast) */
    TM_BEST_FIT   /* take the smallest free block that is big enough (less waste) */
} tm_policy;

typedef struct {
    size_t heap_bytes;    /* bytes available for blocks (arena minus bookkeeping) */
    size_t used_bytes;    /* bytes in allocated blocks, headers included */
    size_t free_bytes;    /* bytes in free blocks */
    size_t largest_free;  /* biggest single request that could succeed right now */
    size_t blocks;        /* allocated + free blocks */
    size_t free_blocks;
    size_t peak_used;     /* highest used_bytes seen so far */
} tm_stats;

/* Called on misuse such as a double free. The default prints the message and
 * aborts, as glibc does; tests install their own to check the message. */
typedef void (*tm_error_fn)(const char *message, void *ptr);

/* Sets up a heap inside `memory`. Returns NULL if `size` is too small. */
tm_heap *tm_create(void *memory, size_t size);

void *tm_malloc(tm_heap *heap, size_t size);
void *tm_calloc(tm_heap *heap, size_t count, size_t size);
void *tm_realloc(tm_heap *heap, void *ptr, size_t size);
void tm_free(tm_heap *heap, void *ptr);

/* Usable bytes in an allocated block (at least what was requested). */
size_t tm_usable_size(tm_heap *heap, void *ptr);

void tm_set_policy(tm_heap *heap, tm_policy policy);
void tm_set_error_handler(tm_heap *heap, tm_error_fn handler);

tm_stats tm_get_stats(tm_heap *heap);

/* Walks the whole heap and verifies every invariant. Returns 0 if all is well,
 * otherwise -1 with a description in `why`. */
int tm_check(tm_heap *heap, char *why, size_t why_len);

/* Prints one line per block plus a picture of the heap, `width` chars wide. */
void tm_dump(tm_heap *heap, FILE *out, int width);

#endif
