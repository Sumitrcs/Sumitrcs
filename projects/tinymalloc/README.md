# tinymalloc

[![CI](https://github.com/Sumitrcs/tinymalloc/actions/workflows/ci.yml/badge.svg)](https://github.com/Sumitrcs/tinymalloc/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

A memory allocator written from scratch in C11: `malloc`, `free`, `realloc` and `calloc`, in about 400 commented lines.
It manages a block of memory you hand it, the same way the real `malloc` manages the memory the operating system gives your program.
It comes with a heap checker, an ASCII heap map, and a trace runner that compares **first fit** with **best fit**.

If you have ever wondered what `free()` actually does, or why a buffer overflow "corrupts the heap", this is the place to find out.

```text
$ make demo
a = malloc(100), b = malloc(200), c = malloc(100) split it up:
  +0       used      128 bytes
  +128     used      224 bytes
  +352     used      128 bytes
  +480     free      464 bytes
[########################........................]

free(b) leaves a hole between a and c:
[#######...........######........................]

free(a), free(d): neighbouring free blocks merge (coalesce):
  +0       free      352 bytes
  +352     used      128 bytes
  +480     free      464 bytes
[..................######........................]

c = realloc(c, 300) grows c in place into the free space after it:
[..................################..............]
```

## Features

- `tm_malloc`, `tm_free`, `tm_realloc`, `tm_calloc` and `tm_usable_size`, with the same rules as the C standard functions
- 16-byte aligned pointers, as with glibc on 64-bit systems
- **Boundary tags** for constant-time merging of free neighbours
- An **explicit free list**: `malloc` searches only free blocks
- A **first-fit** or **best-fit** policy, switchable at run time
- `realloc` grows or shrinks **in place** whenever it can
- Misuse detection: double free, freeing a pointer that didn't come from the allocator, and corrupted tags
- `tm_check()` walks the heap and verifies every invariant; `tm_dump()` draws the heap
- Overflow-safe size maths (`calloc(huge, huge)` returns `NULL` instead of a tiny block)

## Use it

```c
#include "tinymalloc.h"

static _Alignas(16) unsigned char memory[1 << 20];   /* 1 MiB arena */

int main(void) {
    tm_heap *heap = tm_create(memory, sizeof memory);
    char *name = tm_malloc(heap, 32);
    int *nums  = tm_calloc(heap, 100, sizeof *nums);
    nums = tm_realloc(heap, nums, 200 * sizeof *nums);
    tm_free(heap, name);
    tm_free(heap, nums);
}
```

```bash
make test        # 36,000+ checks, including 200,000 random operations
make sanitize    # the same tests under AddressSanitizer + UBSan
make demo        # the step-by-step picture above
make bench       # replay the traces in traces/ with both policies
```

## How it works

### 1. The heap is a row of blocks

Every block, free or used, starts with an 8-byte **header** and ends with an identical 8-byte **footer**:

```text
 ┌────────┬───────────────────────────────┬────────┐
 │ header │ payload  (what you get back)  │ footer │
 │ size|1 │                               │ size|1 │
 └────────┴───────────────────────────────┴────────┘
          ▲ pointer returned by tm_malloc
```

Block sizes are always multiples of 16, so the lowest 4 bits of a size are always 0.
We borrow bit 0 to mean "allocated", and we have to mask it off when reading the size: `tag & ~15`.

The heap begins with a fake *prologue* block and ends with a fake *epilogue* block. Both are marked as permanently allocated.
They let the code at the edges of the heap work without special cases.

### 2. malloc: find a hole, cut it to size

```text
size needed = request + 16 bytes of tags, rounded up to 16 (at least 32)
```

`malloc(100)` therefore uses a 128-byte block. The allocator searches the **free list**, a doubly linked list threaded through the free blocks' own (unused) payloads, so it costs no extra memory.

- **First fit** takes the first block that is big enough. It is fast.
- **Best fit** takes the smallest block that is big enough. It wastes less.

If the chosen block is much bigger than needed, it is **split**. The front part is handed out and the rest goes back on the free list.

### 3. free: merge with free neighbours

Without merging, the heap would end up as thousands of tiny holes that are each too small to use. This is called *fragmentation*.
So `free` checks both neighbours:

- The **right** neighbour's header is at `block + size`.
- The **left** neighbour's footer is just before our header. That is the whole point of the footer: it lets us find the start of the previous block **in constant time**.

There are four cases (neither, left, right or both neighbours free), and all of them are handled by one short function, `coalesce()`.

### 4. realloc: avoid copying

1. If the new size fits in the current block, return the same pointer and free the unused tail.
2. If the next block is free and big enough together with this one, absorb it. The pointer stays the same.
3. Only otherwise: `malloc` a new block, `memcpy` the data and `free` the old block.

### 5. Why a buffer overflow "corrupts the heap"

Write a few bytes past the end of your allocation and you overwrite your block's **footer**, then the next block's **header**.
The next `free` or `malloc` then reads a garbage size, and things go wrong far away from the actual bug.
`tm_check()` catches exactly this case, and the tests do it on purpose:

```c
memset(p, 'x', tm_usable_size(heap, p) + 4);   /* oops */
tm_check(heap, why, sizeof why);  /* → "block at +0: header and footer differ" */
```

## First fit vs best fit (`make bench`)

The `traces/` folder has three reproducible workloads, made by `traces/make_traces.py`.
**util** is the most data the program held at once divided by how far into the arena the allocator had to go: higher is better.

```text
traces/mixed.txt: 20792 operations, arena 16384 KiB
policy        peak data   high water      util   failed    ops/sec
first-fit        708559      1832800     38.7%        0   19802112
best-fit         708559       890576     79.6%        0   10820904

traces/grow.txt: 8812 operations, arena 16384 KiB
first-fit        855051      1894448     45.1%        0    4094874
best-fit         855051      1134592     75.4%        0    3685518

traces/fragment.txt: 13537 operations, arena 16384 KiB
first-fit       1443456      1788992     80.7%        0    6293797
best-fit        1443456      1551568     93.0%        0   11380488
```

Best fit packs memory about twice as tightly here. First fit is usually faster, because it stops at the first match.
That is a real engineering trade-off, and the reason production allocators use **size classes** (see the exercises below).

## What you'll learn

- How `malloc` and `free` really work: headers, footers, splitting and coalescing
- Pointer arithmetic and alignment in C, done portably (`memcpy` for unaligned reads, `uintptr_t` for addresses)
- Storing flags in the low bits of a size
- Doubly linked lists stored *inside* the memory they manage
- Writing a self-checking data structure (`tm_check`), and fuzz-style random testing against a shadow copy
- Measuring a design choice with real workloads instead of guessing

## Try it yourself

1. **Size classes.** Keep separate free lists for blocks of 32, 64, 128, … bytes ("segregated fits"). How do speed and utilisation change in `make bench`?
2. **Drop the footer of used blocks.** Store a "previous block is allocated" bit in each header instead, so allocated blocks need only 8 bytes of overhead. (This is what glibc does.)
3. **Address-ordered free list.** Insert freed blocks in address order instead of at the front. Does first fit now waste less?
4. **Grow the heap.** When no block fits, ask the OS for more memory with `mmap` and add it to the heap.
5. **Use it for real.** Name the functions `malloc`, `free` and so on, build a shared library, and run `LD_PRELOAD=./libtm.so ls`.

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
