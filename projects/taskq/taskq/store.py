"""SQLite-backed job storage.

Claiming a job is a single `UPDATE … RETURNING` statement, so two workers
(even in different processes) can never receive the same job. A claimed job
holds a *lease*; if the worker dies, the lease expires and the job becomes
claimable again.
"""

from __future__ import annotations

import json
import random
import sqlite3
import threading
import time
from dataclasses import dataclass
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    queue         TEXT    NOT NULL DEFAULT 'default',
    task          TEXT    NOT NULL,
    payload       TEXT    NOT NULL DEFAULT '{}',
    priority      INTEGER NOT NULL DEFAULT 0,
    status        TEXT    NOT NULL DEFAULT 'queued',  -- queued | running | done | dead
    attempts      INTEGER NOT NULL DEFAULT 0,
    max_attempts  INTEGER NOT NULL DEFAULT 5,
    run_at        REAL    NOT NULL,
    locked_until  REAL,
    locked_by     TEXT,
    unique_key    TEXT,
    result        TEXT,
    last_error    TEXT,
    created_at    REAL    NOT NULL,
    updated_at    REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs (queue, status, priority DESC, run_at);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_unique ON jobs (unique_key)
    WHERE unique_key IS NOT NULL AND status IN ('queued', 'running');
"""

STATUSES = ("queued", "running", "done", "dead")


@dataclass
class Job:
    id: int
    queue: str
    task: str
    payload: dict[str, Any]
    priority: int
    status: str
    attempts: int
    max_attempts: int
    run_at: float
    last_error: str | None = None
    result: Any = None

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "Job":
        return cls(
            id=row["id"], queue=row["queue"], task=row["task"], payload=json.loads(row["payload"]),
            priority=row["priority"], status=row["status"], attempts=row["attempts"],
            max_attempts=row["max_attempts"], run_at=row["run_at"], last_error=row["last_error"],
            result=json.loads(row["result"]) if row["result"] else None,
        )


def backoff_delay(attempt: int, base: float = 2.0, cap: float = 3600.0) -> float:
    """Exponential backoff with full jitter (AWS architecture blog style)."""
    return random.uniform(0, min(cap, base * (2 ** (attempt - 1))))


class JobStore:
    def __init__(self, path: str = "taskq.db", clock=time.time):
        self.path = path
        self.clock = clock
        self._local = threading.local()
        with self._conn() as c:
            c.executescript(SCHEMA)

    def _conn(self) -> sqlite3.Connection:
        # One connection per thread; asyncio code calls us from a thread pool.
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.path, timeout=30, isolation_level=None, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            self._local.conn = conn
        return conn

    def close(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None

    # -- producer API ----------------------------------------------------------
    def enqueue(self, task: str, payload: dict[str, Any] | None = None, *, queue: str = "default",
                priority: int = 0, delay: float = 0, max_attempts: int = 5, unique_key: str | None = None) -> int | None:
        """Adds a job. With `unique_key`, a duplicate of a pending job is ignored
        and None is returned (idempotent enqueue)."""
        now = self.clock()
        try:
            cur = self._conn().execute(
                """INSERT INTO jobs (queue, task, payload, priority, max_attempts, run_at, unique_key, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (queue, task, json.dumps(payload or {}), priority, max_attempts, now + delay, unique_key, now, now),
            )
            return cur.lastrowid
        except sqlite3.IntegrityError:
            return None

    # -- worker API --------------------------------------------------------------
    def claim(self, worker_id: str, queues: tuple[str, ...] = ("default",), lease: float = 60) -> Job | None:
        """Atomically takes the highest-priority ready job, or one whose lease expired."""
        now = self.clock()
        marks = ",".join("?" * len(queues))
        row = self._conn().execute(
            f"""UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_by = ?,
                       locked_until = ?, updated_at = ?
                WHERE id = (
                    SELECT id FROM jobs
                    WHERE queue IN ({marks}) AND run_at <= ?
                      AND (status = 'queued' OR (status = 'running' AND locked_until < ?))
                    ORDER BY priority DESC, run_at, id
                    LIMIT 1
                )
                RETURNING *""",
            (worker_id, now + lease, now, *queues, now, now),
        ).fetchone()
        if row is None:
            return None
        job = Job.from_row(row)
        # A job whose lease expired on its final attempt has used up its budget.
        if job.attempts > job.max_attempts:
            self._finish(job.id, "dead", error="lease expired on final attempt")
            return self.claim(worker_id, queues, lease)
        return job

    def heartbeat(self, job_id: int, worker_id: str, lease: float = 60) -> bool:
        """Extends the lease of a long-running job. Returns False if it was lost."""
        cur = self._conn().execute(
            "UPDATE jobs SET locked_until = ? WHERE id = ? AND locked_by = ? AND status = 'running'",
            (self.clock() + lease, job_id, worker_id),
        )
        return cur.rowcount == 1

    def complete(self, job_id: int, result: Any = None) -> None:
        self._finish(job_id, "done", result=result)

    def fail(self, job_id: int, error: str, retry_delay: float | None = None) -> str:
        """Records a failure. Returns the new status: 'queued' (will retry) or 'dead'."""
        row = self._conn().execute("SELECT attempts, max_attempts FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            raise KeyError(job_id)
        if row["attempts"] >= row["max_attempts"]:
            self._finish(job_id, "dead", error=error)
            return "dead"
        delay = backoff_delay(row["attempts"]) if retry_delay is None else retry_delay
        now = self.clock()
        self._conn().execute(
            """UPDATE jobs SET status = 'queued', run_at = ?, last_error = ?, locked_by = NULL,
                   locked_until = NULL, updated_at = ? WHERE id = ?""",
            (now + delay, error, now, job_id),
        )
        return "queued"

    def _finish(self, job_id: int, status: str, result: Any = None, error: str | None = None) -> None:
        self._conn().execute(
            """UPDATE jobs SET status = ?, result = ?, last_error = COALESCE(?, last_error),
                   locked_by = NULL, locked_until = NULL, updated_at = ? WHERE id = ?""",
            (status, json.dumps(result) if result is not None else None, error, self.clock(), job_id),
        )

    # -- admin API -----------------------------------------------------------------
    def get(self, job_id: int) -> Job | None:
        row = self._conn().execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return Job.from_row(row) if row else None

    def stats(self) -> dict[str, dict[str, int]]:
        out: dict[str, dict[str, int]] = {}
        for row in self._conn().execute("SELECT queue, status, COUNT(*) AS n FROM jobs GROUP BY queue, status"):
            out.setdefault(row["queue"], {s: 0 for s in STATUSES})[row["status"]] = row["n"]
        return out

    def pending(self, queues: tuple[str, ...] = ("default",)) -> int:
        """Jobs that are queued (ready or delayed) or running."""
        marks = ",".join("?" * len(queues))
        return self._conn().execute(
            f"SELECT COUNT(*) FROM jobs WHERE queue IN ({marks}) AND status IN ('queued', 'running')", queues
        ).fetchone()[0]

    def dead(self, limit: int = 50) -> list[Job]:
        rows = self._conn().execute("SELECT * FROM jobs WHERE status = 'dead' ORDER BY updated_at DESC LIMIT ?", (limit,))
        return [Job.from_row(r) for r in rows]

    def retry_dead(self, queue: str | None = None) -> int:
        """Moves dead jobs back to the queue with a fresh attempt budget."""
        now = self.clock()
        sql = "UPDATE jobs SET status = 'queued', attempts = 0, run_at = ?, updated_at = ? WHERE status = 'dead'"
        args: list[Any] = [now, now]
        if queue:
            sql += " AND queue = ?"
            args.append(queue)
        return self._conn().execute(sql, args).rowcount

    def purge_done(self, older_than: float = 7 * 86400) -> int:
        return self._conn().execute(
            "DELETE FROM jobs WHERE status = 'done' AND updated_at < ?", (self.clock() - older_than,)
        ).rowcount
