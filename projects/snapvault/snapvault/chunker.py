"""Content-defined chunking: splitting files where the *content* says so.

The simple way to deduplicate is to cut every file into fixed 8 KiB blocks
and store each distinct block once. That breaks as soon as a byte is
inserted near the start of a file: every block boundary after it moves, so
every block looks new.

Content-defined chunking puts the boundaries at places chosen by the data
itself. A rolling hash is computed over the last few dozen bytes, and
wherever that hash happens to have a particular bit pattern, we cut. Insert
a byte and only the chunk around it changes; after that the same content
produces the same hash, the same cut points, and the same chunks.

This module uses the "gear" hash from the FastCDC paper (Xia et al., 2016):

    h = (h << 1) + GEAR[byte]        (keeping 64 bits)

Shifting left one bit per byte means a byte stops affecting the top bits
after 64 steps, so the top bits of h depend only on the last 64 bytes: a
rolling hash with no explicit "remove the oldest byte" step.
"""

from __future__ import annotations

import hashlib
from typing import BinaryIO, Iterator

MASK64 = (1 << 64) - 1


def _gear_table() -> tuple[int, ...]:
    # 256 fixed pseudo-random 64-bit numbers, one per byte value. They must
    # never change, or old backups would chunk differently from new ones.
    return tuple(
        int.from_bytes(hashlib.sha256(b"snapvault gear %d" % i).digest()[:8], "big")
        for i in range(256)
    )


GEAR = _gear_table()


class Chunker:
    """Splits a byte stream into chunks of min_size..max_size bytes.

    avg_size (a power of two) is the target average. The real average is
    min_size plus the largest power of two not above avg_size - min_size:
    6 KiB with the defaults, measured at about 6.1 KiB on random data."""

    def __init__(self, min_size: int = 2048, avg_size: int = 8192, max_size: int = 65536):
        if avg_size & (avg_size - 1) or not 0 < min_size < avg_size < max_size:
            raise ValueError("need 0 < min_size < avg_size < max_size, with avg_size a power of two")
        self.min_size = min_size
        self.avg_size = avg_size
        self.max_size = max_size
        # Cut where the top `bits` bits of the hash are all zero. That happens
        # with probability 1 / 2**bits per byte, so after the min_size bytes
        # that are never cut, a cut comes about 2**bits bytes later.
        bits = max(1, (avg_size - min_size).bit_length() - 1)
        self.mask = ((1 << bits) - 1) << (64 - bits)

    def cut_point(self, data: bytes | bytearray | memoryview, at_eof: bool) -> int:
        """Length of the next chunk at the start of data, or 0 if more data
        is needed to decide."""
        n = len(data)
        if n < self.max_size and not at_eof:
            return 0
        if n <= self.min_size:
            return n
        limit = min(n, self.max_size)
        h = 0
        mask = self.mask
        gear = GEAR
        # The first min_size bytes are skipped: a cut there is never allowed,
        # so hashing them would be wasted work. This is FastCDC's main trick.
        for i in range(self.min_size, limit):
            h = ((h << 1) + gear[data[i]]) & MASK64
            if not h & mask:
                return i + 1
        return limit

    def chunks(self, stream: BinaryIO, read_size: int = 1 << 20) -> Iterator[bytes]:
        """Yields the chunks of a binary stream, reading it piece by piece."""
        buf = bytearray()
        pos = 0  # start of the unchunked data in buf
        eof = False
        while True:
            if not eof and len(buf) - pos < self.max_size:
                block = stream.read(read_size)
                if block:
                    del buf[:pos]  # drop what was already chunked, once per read
                    pos = 0
                    buf += block
                    continue
                eof = True
            if pos == len(buf):
                return
            with memoryview(buf) as view:
                n = self.cut_point(view[pos:], eof)
                chunk = bytes(view[pos : pos + n])
            pos += n
            yield chunk

    def split(self, data: bytes) -> list[bytes]:
        """All chunks of an in-memory byte string."""
        out = []
        view = memoryview(data)
        while view:
            n = self.cut_point(view, at_eof=True)
            out.append(bytes(view[:n]))
            view = view[n:]
        return out


def fixed_chunks(data: bytes, size: int = 8192) -> list[bytes]:
    """Fixed-size blocks, for comparison: see the README."""
    return [data[i : i + size] for i in range(0, len(data), size)]
