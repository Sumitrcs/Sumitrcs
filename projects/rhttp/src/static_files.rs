use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::request::Request;
use crate::response::{Response, Status};

pub fn mime_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("json") => "application/json",
        Some("txt" | "md") => "text/plain; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("pdf") => "application/pdf",
        Some("wasm") => "application/wasm",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

/// Serves `rel` from `root`, refusing anything that would escape the root
/// directory (`..`, absolute paths). Directories serve their `index.html`.
/// Supports conditional GET via a weak ETag built from size + mtime.
pub fn serve_dir(root: &Path, rel: &str, req: &Request) -> Response {
    let mut path = PathBuf::from(root);
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(c) => path.push(c),
            Component::CurDir => {}
            _ => return Response::error(Status::FORBIDDEN),
        }
    }
    if path.is_dir() {
        path.push("index.html");
    }
    let Ok(meta) = fs::metadata(&path) else {
        return Response::error(Status::NOT_FOUND);
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    let etag = format!("W/\"{:x}-{:x}\"", meta.len(), mtime);
    if req.header("if-none-match") == Some(etag.as_str()) {
        return Response::new(Status::NOT_MODIFIED).with_header("ETag", &etag);
    }
    match fs::read(&path) {
        Ok(bytes) => Response::new(Status::OK)
            .with_header("Content-Type", mime_type(&path))
            .with_header("ETag", &etag)
            .with_header("Cache-Control", "public, max-age=60")
            .with_body(bytes),
        Err(_) => Response::error(Status::INTERNAL_SERVER_ERROR),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn get(path: &str, extra: &str) -> Request {
        let raw = format!("GET {path} HTTP/1.1\r\n{extra}\r\n");
        Request::read_from(&mut Cursor::new(raw.into_bytes()), 0).unwrap()
    }

    #[test]
    fn serves_files_blocks_traversal_and_supports_etags() {
        let dir = std::env::temp_dir().join(format!("rhttp-test-{}", std::process::id()));
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub/index.html"), "<h1>hi</h1>").unwrap();
        fs::write(dir.join("a.css"), "body{}").unwrap();

        let r = serve_dir(&dir, "sub", &get("/", ""));
        assert_eq!(r.status, Status::OK);
        assert_eq!(r.header("Content-Type"), Some("text/html; charset=utf-8"));

        let css = serve_dir(&dir, "a.css", &get("/", ""));
        let etag = css.header("ETag").unwrap().to_string();
        let again = serve_dir(
            &dir,
            "a.css",
            &get("/", &format!("If-None-Match: {etag}\r\n")),
        );
        assert_eq!(again.status, Status::NOT_MODIFIED);

        assert_eq!(
            serve_dir(&dir, "../etc/passwd", &get("/", "")).status,
            Status::FORBIDDEN
        );
        assert_eq!(
            serve_dir(&dir, "missing.txt", &get("/", "")).status,
            Status::NOT_FOUND
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
