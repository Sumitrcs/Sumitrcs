"""snapvault: deduplicating, incremental backups with content-defined chunking."""

from .chunker import Chunker, fixed_chunks
from .vault import BackupStats, Change, Entry, Snapshot, Vault, VaultError

__all__ = ["BackupStats", "Change", "Chunker", "Entry", "Snapshot", "Vault", "VaultError", "fixed_chunks"]
__version__ = "1.0.0"
