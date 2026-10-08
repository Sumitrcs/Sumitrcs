"""Async worker pool.

    app = TaskQ("jobs.db")

    @app.task(max_attempts=3, timeout=30)
    async def send_invoice(invoice_id: int, email: str):
        ...

    send_invoice.delay(invoice_id=42, email="a@b.com")
    asyncio.run(app.run_worker(concurrency=8))
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import os
import signal
import socket
import traceback
from dataclasses import dataclass
from typing import Any, Callable

from .store import Job, JobStore

log = logging.getLogger("taskq")


class Retry(Exception):
    """Raise from a task to retry after a specific delay instead of the default backoff."""

    def __init__(self, delay: float, reason: str = "retry requested"):
        super().__init__(reason)
        self.delay = delay


@dataclass
class TaskDef:
    name: str
    fn: Callable[..., Any]
    queue: str
    max_attempts: int
    timeout: float | None
    app: "TaskQ"

    def delay(self, **kwargs: Any) -> int | None:
        return self.app.store.enqueue(self.name, kwargs, queue=self.queue, max_attempts=self.max_attempts)

    def schedule(self, *, countdown: float = 0, priority: int = 0, unique_key: str | None = None, **kwargs: Any) -> int | None:
        return self.app.store.enqueue(self.name, kwargs, queue=self.queue, priority=priority, delay=countdown,
                                      max_attempts=self.max_attempts, unique_key=unique_key)

    async def __call__(self, **kwargs: Any) -> Any:
        """Calling the task directly runs it inline (handy in tests)."""
        result = self.fn(**kwargs)
        return await result if inspect.isawaitable(result) else result


class TaskQ:
    def __init__(self, path: str = "taskq.db", store: JobStore | None = None):
        self.store = store or JobStore(path)
        self.tasks: dict[str, TaskDef] = {}
        self._stopping: asyncio.Event | None = None  # created inside the running loop
        self.processed = 0
        self.failed = 0

    def task(self, name: str | None = None, *, queue: str = "default", max_attempts: int = 5,
             timeout: float | None = None) -> Callable[[Callable[..., Any]], TaskDef]:
        def decorator(fn: Callable[..., Any]) -> TaskDef:
            tname = name or fn.__name__
            if tname in self.tasks:
                raise ValueError(f"Task {tname!r} is already registered")
            td = TaskDef(tname, fn, queue, max_attempts, timeout, self)
            self.tasks[tname] = td
            return td
        return decorator

    def stop(self) -> None:
        if self._stopping is not None:
            self._stopping.set()

    async def run_worker(self, concurrency: int = 4, queues: tuple[str, ...] = ("default",), poll_interval: float = 0.5,
                         lease: float = 60, burst: bool = False) -> None:
        """Runs until stop() is called, or with burst=True until no queued or running jobs remain."""
        self._stopping = asyncio.Event()
        worker_id = f"{socket.gethostname()}:{os.getpid()}:{id(self):x}"
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, self.stop)
            except (NotImplementedError, RuntimeError):
                pass  # not on the main thread / Windows

        sem = asyncio.Semaphore(concurrency)
        running: set[asyncio.Task] = set()
        log.info("worker %s started (concurrency=%d, queues=%s)", worker_id, concurrency, queues)

        while not self._stopping.is_set():
            await sem.acquire()
            job = await asyncio.to_thread(self.store.claim, worker_id, queues, lease)
            if job is None:
                sem.release()
                # Burst mode drains the queue, including jobs waiting out a retry backoff.
                if burst and not running and await asyncio.to_thread(self.store.pending, queues) == 0:
                    break
                try:
                    await asyncio.wait_for(self._stopping.wait(), poll_interval)
                except asyncio.TimeoutError:
                    pass
                continue
            t = asyncio.create_task(self._execute(job, worker_id, lease))
            running.add(t)
            t.add_done_callback(lambda t: (running.discard(t), sem.release()))

        # Graceful shutdown: let in-flight jobs finish.
        if running:
            log.info("waiting for %d running job(s)", len(running))
            await asyncio.gather(*running, return_exceptions=True)
        log.info("worker %s stopped (processed=%d failed=%d)", worker_id, self.processed, self.failed)

    async def _execute(self, job: Job, worker_id: str, lease: float) -> None:
        td = self.tasks.get(job.task)
        if td is None:
            await asyncio.to_thread(self.store.fail, job.id, f"unknown task {job.task!r}", 60)
            return

        async def keep_alive() -> None:
            while True:
                await asyncio.sleep(lease / 3)
                await asyncio.to_thread(self.store.heartbeat, job.id, worker_id, lease)

        hb = asyncio.create_task(keep_alive())
        try:
            coro = self._invoke(td, job.payload)
            result = await (asyncio.wait_for(coro, td.timeout) if td.timeout else coro)
        except Retry as r:
            status = await asyncio.to_thread(self.store.fail, job.id, str(r), r.delay)
            log.info("job %d (%s) retry in %.1fs -> %s", job.id, job.task, r.delay, status)
        except asyncio.TimeoutError:
            self.failed += 1
            status = await asyncio.to_thread(self.store.fail, job.id, f"timed out after {td.timeout}s")
            log.warning("job %d (%s) timed out -> %s", job.id, job.task, status)
        except Exception as e:  # noqa: BLE001 — any task error is recorded, never crashes the worker
            self.failed += 1
            err = "".join(traceback.format_exception_only(type(e), e)).strip()
            status = await asyncio.to_thread(self.store.fail, job.id, err)
            log.warning("job %d (%s) failed (%s) -> %s", job.id, job.task, err, status)
        else:
            self.processed += 1
            await asyncio.to_thread(self.store.complete, job.id, result)
        finally:
            hb.cancel()

    async def _invoke(self, td: TaskDef, payload: dict[str, Any]) -> Any:
        if inspect.iscoroutinefunction(td.fn):
            return await td.fn(**payload)
        # Blocking functions run in a thread so they don't stall the event loop.
        return await asyncio.to_thread(td.fn, **payload)

