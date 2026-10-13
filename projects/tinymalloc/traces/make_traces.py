"""Writes the sample traces in this folder. Run: python3 traces/make_traces.py

Each trace is deterministic (fixed random seed), so results are reproducible.
"""
import random
from pathlib import Path

HERE = Path(__file__).parent


def write(name, header, ops):
    lines = [f"# {line}" for line in header.splitlines()] + ops
    (HERE / name).write_text("\n".join(lines) + "\n")


def mixed():
    """Many short-lived small objects plus a few long-lived big ones."""
    rnd = random.Random(1)
    ops, live, next_id = [], [], 0
    for _ in range(20000):
        if live and rnd.random() < 0.48:
            ops.append(f"f {live.pop(rnd.randrange(len(live)))}")
        else:
            size = rnd.randint(4000, 40000) if rnd.random() < 0.03 else rnd.randint(8, 256)
            ops.append(f"a {next_id} {size}")
            live.append(next_id)
            next_id += 1
    ops += [f"f {i}" for i in live]
    return ops


def fragment():
    """Leaves holes of many sizes, then asks for blocks that fit some exactly:
    the case where best fit beats first fit."""
    rnd = random.Random(2)
    ops, next_id = [], 0
    sizes = [rnd.choice([24, 56, 120, 248, 504, 1016]) for _ in range(3000)]
    for s in sizes:
        ops.append(f"a {next_id} {s}")
        next_id += 1
    ops += [f"f {i}" for i in range(0, 3000, 2)]           # every other block: holes
    for _ in range(6000):
        ops.append(f"a {next_id} {rnd.choice([24, 56, 120, 248, 504, 1016])}")
        if rnd.random() < 0.5:
            ops.append(f"f {next_id}")
        next_id += 1
    return ops


def grow():
    """Strings and vectors that keep growing with realloc."""
    rnd = random.Random(3)
    ops = []
    sizes = {i: 16 for i in range(50)}
    ops += [f"a {i} 16" for i in sizes]
    for _ in range(8000):
        i = rnd.randrange(50)
        sizes[i] = min(int(sizes[i] * 1.5) + 1, 64000)
        ops.append(f"r {i} {sizes[i]}")
        if sizes[i] >= 64000:
            ops.append(f"f {i}")
            ops.append(f"a {i} 16")
            sizes[i] = 16
    ops += [f"f {i}" for i in sizes]
    return ops


write("mixed.txt", "Mixed workload: short-lived small objects and a few big ones.", mixed())
write("fragment.txt", "Fragmentation: holes of many sizes, then requests that fit some exactly.", fragment())
write("grow.txt", "Growing buffers: realloc by 1.5x, like a string builder or vector.", grow())
