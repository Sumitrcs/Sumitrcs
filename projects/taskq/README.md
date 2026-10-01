# taskq

**Durable background jobs for Python — backed by a single SQLite file.**
No Redis, no RabbitMQ, no extra service to run. Ideal for small SaaS apps,
internal tools and scripts that need reliable "do this later, and retry if
it fails" semantics.

```python
import asyncio
from taskq import TaskQ, Retry

app = TaskQ("jobs.db")

@app.task(max_attempts=5, timeout=30)
async def send_invoice(invoice_id: int, email: str):
    ...                       # raise any exception -> retried with backoff
    if mailbox_full:
        raise Retry(delay=600)  # or choose the delay yourself

send_invoice.delay(invoice_id=42, email="client@acme.in")
send_invoice.schedule(invoice_id=43, email="x@y.in", countdown=3600,
                      priority=10, unique_key="invoice-43")

asyncio.run(app.run_worker(concurrency=8))
```

## Guarantees and features

| Feature | How |
|---|---|
| **No double processing** | jobs are claimed with one atomic `UPDATE … RETURNING`; tested with 8 threads racing for 300 jobs |
| **Crash safety** | a claimed job holds a *lease*; if the worker dies the lease expires and another worker picks it up |
| **Long jobs** | the worker sends heartbeats that extend the lease while a task runs |
| **Retries** | exponential backoff with full jitter, per-task `max_attempts`, or `raise Retry(delay=…)` |
| **Dead-letter queue** | exhausted jobs move to `dead` with the last error; requeue with one command |
| **Priorities, delays, named queues** | `priority`, `countdown`, `queue="emails"` |
| **Idempotent enqueue** | `unique_key` ignores duplicates while a job is pending (partial unique index) |
| **Timeouts** | per-task `timeout`, enforced with `asyncio.wait_for` |
| **Sync or async tasks** | blocking functions run in a thread pool so they don't stall the loop |
| **Graceful shutdown** | SIGINT/SIGTERM stop claiming and wait for in-flight jobs |
| **Burst mode** | `run_worker(burst=True)` drains the queue (including backoffs) and exits — great for cron |

SQLite runs in WAL mode, so producers and workers in different processes can
share the same file.

## Admin CLI

```bash
$ taskq stats jobs.db
queue               queued   running      done      dead
default                  0         0        19         1

$ taskq dead jobs.db
#6      email_invoice            attempts=3   2026-10-01 06:28  ConnectionError: SMTP server busy

$ taskq retry-dead jobs.db
requeued 1 job(s)

$ taskq purge jobs.db --days 7
```

## Demo

```bash
python examples/invoices_demo.py
```

Renders and "emails" ten invoices with a 30% simulated SMTP failure rate and
shows retries, a dead-lettered job and the duplicate-enqueue guard.

## Tests

```bash
pip install -e ".[dev]"
pytest
```

Time is injected into `JobStore`, so lease expiry and backoff are tested
deterministically without sleeping.

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
