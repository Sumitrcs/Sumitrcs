import asyncio
import threading

import pytest

from taskq import JobStore, Retry, TaskQ, backoff_delay
from taskq.cli import main


class Clock:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self):
        return self.t


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def store(tmp_path, clock):
    s = JobStore(str(tmp_path / "q.db"), clock=clock)
    yield s
    s.close()


def test_enqueue_and_claim_by_priority(store):
    low = store.enqueue("t", {"n": 1}, priority=0)
    high = store.enqueue("t", {"n": 2}, priority=10)
    assert store.claim("w").id == high
    assert store.claim("w").id == low
    assert store.claim("w") is None


def test_delayed_jobs_wait(store, clock):
    store.enqueue("t", delay=30)
    assert store.claim("w") is None
    clock.t += 31
    assert store.claim("w") is not None


def test_queues_are_isolated(store):
    store.enqueue("t", queue="emails")
    assert store.claim("w", queues=("default",)) is None
    assert store.claim("w", queues=("emails", "default")).queue == "emails"


def test_unique_key_dedupes_pending_jobs(store):
    assert store.enqueue("t", unique_key="k") is not None
    assert store.enqueue("t", unique_key="k") is None
    job = store.claim("w")
    store.complete(job.id)
    assert store.enqueue("t", unique_key="k") is not None  # allowed again once done


def test_failure_retries_then_dead_letters(store, clock):
    jid = store.enqueue("t", max_attempts=2)
    store.claim("w")
    assert store.fail(jid, "boom", retry_delay=10) == "queued"
    assert store.claim("w") is None  # backing off
    clock.t += 11
    store.claim("w")
    assert store.fail(jid, "boom again") == "dead"
    job = store.get(jid)
    assert job.status == "dead" and job.attempts == 2 and job.last_error == "boom again"
    assert store.retry_dead() == 1
    assert store.claim("w").attempts == 1


def test_expired_lease_is_reclaimed(store, clock):
    jid = store.enqueue("t")
    assert store.claim("crashed-worker", lease=30).id == jid
    assert store.claim("other") is None  # still leased
    clock.t += 31
    job = store.claim("other")
    assert job.id == jid and job.attempts == 2


def test_heartbeat_extends_lease(store, clock):
    jid = store.enqueue("t")
    store.claim("w", lease=30)
    clock.t += 20
    assert store.heartbeat(jid, "w", lease=30)
    clock.t += 20
    assert store.claim("other") is None
    assert not store.heartbeat(jid, "someone-else")


def test_lease_expiry_on_last_attempt_goes_dead(store, clock):
    jid = store.enqueue("t", max_attempts=1)
    store.claim("w", lease=5)
    clock.t += 6
    assert store.claim("w") is None
    assert store.get(jid).status == "dead"


def test_concurrent_claims_never_duplicate(tmp_path):
    path = str(tmp_path / "c.db")
    s = JobStore(path)
    for i in range(300):
        s.enqueue("t", {"i": i})
    claimed: list[int] = []
    lock = threading.Lock()

    def worker(name):
        st = JobStore(path)
        while (job := st.claim(name)) is not None:
            with lock:
                claimed.append(job.id)
        st.close()

    threads = [threading.Thread(target=worker, args=(f"w{i}",)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(claimed) == 300 and len(set(claimed)) == 300


def test_backoff_is_bounded():
    for attempt in range(1, 30):
        assert 0 <= backoff_delay(attempt, base=2, cap=60) <= 60


def test_worker_runs_async_and_sync_tasks(tmp_path):
    app = TaskQ(str(tmp_path / "w.db"))
    seen = []

    @app.task()
    async def add(a, b):
        seen.append(("async", a + b))
        return a + b

    @app.task()
    def mul(a, b):  # blocking function, runs in a thread
        seen.append(("sync", a * b))
        return a * b

    ids = [add.delay(a=2, b=3), mul.delay(a=4, b=5)]
    asyncio.run(app.run_worker(concurrency=2, burst=True, poll_interval=0.01))
    assert sorted(seen) == [("async", 5), ("sync", 20)]
    assert [app.store.get(i).result for i in ids] == [5, 20]
    assert app.processed == 2


def test_worker_retries_failures_and_respects_timeout(tmp_path):
    app = TaskQ(str(tmp_path / "w.db"))
    calls = {"flaky": 0}

    @app.task(max_attempts=3)
    async def flaky():
        calls["flaky"] += 1
        if calls["flaky"] < 3:
            raise Retry(delay=0, reason="not yet")
        return "ok"

    @app.task(max_attempts=1, timeout=0.05)
    async def slow():
        await asyncio.sleep(1)

    @app.task(max_attempts=2)
    def broken():
        raise ValueError("bad input")

    fid, sid, bid = flaky.delay(), slow.delay(), broken.delay()
    app.store.enqueue("never_registered", max_attempts=1)

    async def run():
        # failures without explicit delay back off randomly; keep polling briefly
        worker = asyncio.create_task(app.run_worker(concurrency=3, poll_interval=0.01))
        for _ in range(400):
            await asyncio.sleep(0.01)
            st = app.store
            if st.get(fid).status == "done" and st.get(sid).status == "dead" and st.get(bid).status == "dead":
                break
            # make backed-off jobs ready immediately
            st._conn().execute("UPDATE jobs SET run_at = 0 WHERE status = 'queued'")
        app.stop()
        await worker

    asyncio.run(run())
    assert app.store.get(fid).result == "ok" and calls["flaky"] == 3
    assert "timed out" in app.store.get(sid).last_error
    dead = app.store.get(bid)
    assert dead.status == "dead" and "ValueError: bad input" in dead.last_error and dead.attempts == 2


def test_duplicate_task_names_rejected(tmp_path):
    app = TaskQ(str(tmp_path / "w.db"))

    @app.task()
    def job():
        pass

    with pytest.raises(ValueError):
        app.task(name="job")(lambda: None)


def test_cli(tmp_path, capsys):
    db = str(tmp_path / "cli.db")
    s = JobStore(db)
    jid = s.enqueue("t", max_attempts=1)
    s.claim("w")
    s.fail(jid, "kaput")
    s.enqueue("t2", queue="emails")
    assert main(["stats", db]) == 0
    out = capsys.readouterr().out
    assert "emails" in out and "default" in out
    main(["dead", db])
    assert "kaput" in capsys.readouterr().out
    main(["retry-dead", db])
    assert "requeued 1" in capsys.readouterr().out
