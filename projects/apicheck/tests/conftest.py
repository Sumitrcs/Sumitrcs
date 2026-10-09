"""A tiny fake API so the tests don't need the internet."""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

USERS = {1: {"id": 1, "name": "Asha", "email": "asha@example.com", "active": True}}


class FakeAPI(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, payload, headers=None):
        body = json.dumps(payload).encode() if not isinstance(payload, bytes) else payload
        self.send_response(status)
        self.send_header("Content-Type", "application/json" if not isinstance(payload, bytes) else "text/plain")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authed(self):
        return self.headers.get("Authorization") == "Bearer secret-token"

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/health":
            self.reply(200, {"ok": True, "version": "1.4.2"})
        elif path == "/plain":
            self.reply(200, b"hello there")
        elif path == "/slow":
            time.sleep(0.3)
            self.reply(200, {"ok": True})
        elif path == "/echo-query":
            self.reply(200, {"query": self.path.partition("?")[2]})
        elif path.startswith("/users/"):
            if not self.authed():
                return self.reply(401, {"error": "unauthorized"})
            uid = int(path.rsplit("/", 1)[1])
            if uid in USERS:
                self.reply(200, USERS[uid])
            else:
                self.reply(404, {"error": "not found"})
        else:
            self.reply(404, {"error": "no route"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        data = json.loads(self.rfile.read(length) or b"{}")
        if self.path == "/login":
            if data.get("password") == "hunter2":
                self.reply(200, {"token": "secret-token"})
            else:
                self.reply(403, {"error": "bad password"})
        elif self.path == "/users":
            if not self.authed():
                return self.reply(401, {"error": "unauthorized"})
            uid = max(USERS) + 1
            USERS[uid] = {"id": uid, **data}
            self.reply(201, USERS[uid], {"Location": f"/users/{uid}"})
        else:
            self.reply(404, {"error": "no route"})


@pytest.fixture(scope="session")
def api():
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeAPI)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
