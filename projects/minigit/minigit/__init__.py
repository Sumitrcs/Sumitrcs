"""minigit — a small, readable Git that uses Git's real on-disk formats."""

from .index import IndexEntry, IndexFormatError, read_index, write_index
from .objects import Commit, ObjectError, ObjectStore, TreeEntry, decode_tree, encode_tree, hash_object
from .repo import Repository, RepoError, Status

__all__ = [
    "Commit", "IndexEntry", "IndexFormatError", "ObjectError", "ObjectStore", "RepoError", "Repository",
    "Status", "TreeEntry", "decode_tree", "encode_tree", "hash_object", "read_index", "write_index",
]
__version__ = "1.0.0"
