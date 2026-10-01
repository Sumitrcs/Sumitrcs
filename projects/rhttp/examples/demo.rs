//! cargo run --example demo
//! then open http://127.0.0.1:8080
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use rhttp::{Response, Router, Server, Status, serve_dir};

fn main() -> std::io::Result<()> {
    static VISITS: AtomicU64 = AtomicU64::new(0);
    static NOTES: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let public = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("examples/public");

    let mut router = Router::new();
    router
        .get("/api/hello/:name", |r| {
            let n = VISITS.fetch_add(1, Ordering::Relaxed) + 1;
            Response::json(format!(
                r#"{{"greeting":"Hello, {}!","visit":{n}}}"#,
                json_escape(r.param("name").unwrap())
            ))
        })
        .get("/api/notes", |_| {
            let notes = NOTES.lock().unwrap();
            let items: Vec<String> = notes
                .iter()
                .map(|n| format!("\"{}\"", json_escape(n)))
                .collect();
            Response::json(format!("[{}]", items.join(",")))
        })
        .post("/api/notes", |r| match r.body_str().map(str::trim) {
            Some(text) if !text.is_empty() => {
                NOTES.lock().unwrap().push(text.to_string());
                Response::json(r#"{"ok":true}"#).with_status(Status::CREATED)
            }
            _ => Response::error(Status::BAD_REQUEST),
        })
        .get("/*path", move |r| {
            serve_dir(&public, r.param("path").unwrap_or(""), r)
        });

    Server::bind("127.0.0.1:8080")?.run(router);
    Ok(())
}

fn json_escape(s: &str) -> String {
    s.chars()
        .flat_map(|c| match c {
            '"' => vec!['\\', '"'],
            '\\' => vec!['\\', '\\'],
            '\n' => vec!['\\', 'n'],
            c if (c as u32) < 0x20 => format!("\\u{:04x}", c as u32).chars().collect(),
            c => vec![c],
        })
        .collect()
}
