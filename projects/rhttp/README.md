# rhttp

An **HTTP/1.1 server written from scratch in Rust** — no Tokio, no Hyper, no
dependencies at all. Just `std::net`, a hand-rolled thread pool and a careful
request parser.

```rust
use rhttp::{Response, Router, Server, serve_dir};

let mut router = Router::new();
router
    .get("/api/hello/:name", |req| Response::json(format!(r#"{{"hi":"{}"}}"#, req.param("name").unwrap())))
    .post("/api/notes", |req| Response::text(format!("got {} bytes", req.body.len())))
    .get("/*path", |req| serve_dir("public".as_ref(), req.param("path").unwrap(), req));

Server::bind("127.0.0.1:8080")?.run(router);
```

```bash
cargo run --example demo      # JSON API + static site on http://127.0.0.1:8080
```

## What's implemented

**Protocol**
- Request line, headers (case-insensitive, repeated headers joined), query strings, percent-decoding (UTF-8 safe)
- `Content-Length` bodies with a configurable size limit
- **Persistent connections** (HTTP/1.1 keep-alive, HTTP/1.0 `Connection: keep-alive`) with idle timeout and per-connection request cap
- **Pipelining** — several requests in one TCP write are answered in order
- `HEAD` served from `GET` handlers with the correct `Content-Length` and no body
- Precise error statuses: `400`, `404`, `405` + `Allow`, `413`, `431`, `500`, `501`, `505`

**Routing**
- Path parameters `/users/:id` and wildcards `/static/*path`
- Static segments outrank params, so `/users/me` and `/users/:id` coexist in any order

**Static files**
- MIME types, `index.html` for directories, weak **ETags** with `304 Not Modified`
- **Path traversal protection** — any `..` or absolute component returns `403`

**Robustness**
- Fixed-size worker **thread pool**; a panicking handler returns `500` and the worker survives
- Header section capped at 16 KiB; `Transfer-Encoding` with `Content-Length` is refused (request smuggling)
- CR/LF stripped from response header values (header injection)
- After any framing error the connection is closed, never reused

## Architecture

```
TcpListener ──accept──▶ ThreadPool ──▶ handle_connection (loop per keep-alive request)
                                         │
                                         ├─ Request::read_from   (parser, limits)
                                         ├─ Router::dispatch     (best match, params, 404/405)
                                         └─ Response::write_to   (status, headers, body)
```

| File | Responsibility |
|---|---|
| `src/request.rs` | streaming parser, limits, query / percent decoding |
| `src/response.rs` | builder and serialisation |
| `src/router.rs` | pattern matching with specificity scoring |
| `src/static_files.rs` | safe file serving, MIME, ETags |
| `src/pool.rs` | thread pool with panic isolation and graceful drop |
| `src/server.rs` | accept loop, keep-alive, error mapping, access log |

## Tests

```bash
cargo test
```

Unit tests cover the parser's edge cases and routing. Integration tests start a
real server on a random port and talk raw TCP to it: pipelined requests,
every error status, 32 concurrent clients with panicking handlers mixed in,
and `HEAD` semantics.

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
