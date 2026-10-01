"""Demo: generate and email invoices in the background with retries.

    python examples/invoices_demo.py
"""

import asyncio
import logging
import random

from taskq import Retry, TaskQ

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
app = TaskQ("demo.db")


@app.task(max_attempts=4, timeout=5)
async def render_invoice(invoice_id: int) -> str:
    await asyncio.sleep(random.uniform(0.05, 0.2))
    return f"invoices/{invoice_id}.pdf"


@app.task(queue="default", max_attempts=3)
async def email_invoice(invoice_id: int, to: str) -> dict:
    if random.random() < 0.3:
        raise ConnectionError("SMTP server busy")  # retried with exponential backoff
    if to.endswith("@example.invalid"):
        raise Retry(delay=0.5, reason="mailbox temporarily unavailable")
    return {"sent_to": to}


async def main() -> None:
    for i in range(1, 11):
        render_invoice.delay(invoice_id=i)
        email_invoice.schedule(invoice_id=i, to=f"client{i}@example.com", unique_key=f"email-{i}")
    email_invoice.schedule(invoice_id=1, to="dupe@example.com", unique_key="email-1")  # ignored: duplicate
    await app.run_worker(concurrency=4, burst=True, poll_interval=0.1)
    print(app.store.stats())


if __name__ == "__main__":
    asyncio.run(main())
