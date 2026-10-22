import io
import random

import pytest

from snapvault.chunker import GEAR, Chunker, fixed_chunks

DATA = random.Random(42).randbytes(1_000_000)


@pytest.fixture(scope="module")
def chunker():
    return Chunker()


def test_chunks_join_back_to_the_original(chunker):
    parts = chunker.split(DATA)
    assert b"".join(parts) == DATA


def test_chunk_sizes_stay_within_bounds(chunker):
    parts = chunker.split(DATA)
    assert all(chunker.min_size <= len(p) <= chunker.max_size for p in parts[:-1])
    assert 0 < len(parts[-1]) <= chunker.max_size
    average = len(DATA) / len(parts)
    assert 5000 < average < 7500, average  # min_size + 4096 = 6144 expected


def test_streaming_gives_the_same_chunks_whatever_the_read_size(chunker):
    expected = chunker.split(DATA)
    for read_size in (1, 999, 4096, 70_000, 1 << 20):
        if read_size == 1:
            data = DATA[:50_000]
            assert list(chunker.chunks(io.BytesIO(data), read_size)) == chunker.split(data)
        else:
            assert list(chunker.chunks(io.BytesIO(DATA), read_size)) == expected


def test_chunking_never_changes():
    # The gear table and cut rule must stay the same forever, or new backups
    # would stop sharing chunks with old ones. These values are pinned.
    assert GEAR[0] == 0xAAD3C8D5FCCC94DD
    assert GEAR[255] == 0xB0AC5113DAD41560
    assert len(set(GEAR)) == 256
    assert [len(p) for p in Chunker().split(DATA)[:6]] == [3069, 6068, 3948, 2123, 2724, 3717]


def test_small_and_empty_inputs(chunker):
    assert chunker.split(b"") == []
    assert list(chunker.chunks(io.BytesIO(b""))) == []
    assert chunker.split(b"abc") == [b"abc"]
    exactly_min = bytes(chunker.min_size)
    assert chunker.split(exactly_min) == [exactly_min]


def test_data_without_cut_points_is_cut_at_max_size(chunker):
    # Zeros give the same hash value forever, and it isn't a cut point, so
    # only the max_size limit ends a chunk.
    zeros = bytes(200_000)
    assert [len(p) for p in chunker.split(zeros)] == [65536, 65536, 65536, 3392]


@pytest.mark.parametrize("where", [0, 100, 500_000, 999_999])
def test_an_insertion_only_changes_nearby_chunks(chunker, where):
    edited = DATA[:where] + b"inserted text" + DATA[where:]
    before, after = chunker.split(DATA), chunker.split(edited)
    reused = len(set(before) & set(after))
    assert reused >= len(before) - 3, f"only {reused} of {len(before)} chunks reused"


def test_fixed_size_blocks_cannot_survive_an_insertion():
    edited = b"!" + DATA
    reused = len(set(fixed_chunks(DATA)) & set(fixed_chunks(edited)))
    assert reused == 0


def test_settings_are_validated():
    for args in [(0, 8192, 65536), (4096, 4096, 65536), (2048, 8000, 65536), (2048, 8192, 8192)]:
        with pytest.raises(ValueError):
            Chunker(*args)
