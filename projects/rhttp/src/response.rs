use std::io::{self, Write};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Status(pub u16);

impl Status {
    pub const OK: Status = Status(200);
    pub const CREATED: Status = Status(201);
    pub const NO_CONTENT: Status = Status(204);
    pub const MOVED_PERMANENTLY: Status = Status(301);
    pub const NOT_MODIFIED: Status = Status(304);
    pub const BAD_REQUEST: Status = Status(400);
    pub const FORBIDDEN: Status = Status(403);
    pub const NOT_FOUND: Status = Status(404);
    pub const METHOD_NOT_ALLOWED: Status = Status(405);
    pub const PAYLOAD_TOO_LARGE: Status = Status(413);
    pub const HEADERS_TOO_LARGE: Status = Status(431);
    pub const INTERNAL_SERVER_ERROR: Status = Status(500);
    pub const NOT_IMPLEMENTED: Status = Status(501);
    pub const VERSION_NOT_SUPPORTED: Status = Status(505);

    pub fn reason(self) -> &'static str {
        match self.0 {
            200 => "OK",
            201 => "Created",
            204 => "No Content",
            301 => "Moved Permanently",
            304 => "Not Modified",
            400 => "Bad Request",
            403 => "Forbidden",
            404 => "Not Found",
            405 => "Method Not Allowed",
            413 => "Content Too Large",
            431 => "Request Header Fields Too Large",
            500 => "Internal Server Error",
            501 => "Not Implemented",
            505 => "HTTP Version Not Supported",
            _ => "",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: Status,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn new(status: Status) -> Self {
        Response {
            status,
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    pub fn text(body: impl Into<String>) -> Self {
        Response::new(Status::OK)
            .with_header("Content-Type", "text/plain; charset=utf-8")
            .with_body(body.into())
    }

    pub fn html(body: impl Into<String>) -> Self {
        Response::new(Status::OK)
            .with_header("Content-Type", "text/html; charset=utf-8")
            .with_body(body.into())
    }

    /// The caller supplies already-serialised JSON (no serde dependency).
    pub fn json(body: impl Into<String>) -> Self {
        Response::new(Status::OK)
            .with_header("Content-Type", "application/json")
            .with_body(body.into())
    }

    pub fn redirect(location: &str) -> Self {
        Response::new(Status::MOVED_PERMANENTLY).with_header("Location", location)
    }

    pub fn error(status: Status) -> Self {
        let msg = format!("{} {}\n", status.0, status.reason());
        Response::new(status)
            .with_header("Content-Type", "text/plain; charset=utf-8")
            .with_body(msg)
    }

    pub fn with_status(mut self, status: Status) -> Self {
        self.status = status;
        self
    }

    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.set_header(name, value);
        self
    }

    pub fn with_body(mut self, body: impl Into<Vec<u8>>) -> Self {
        self.body = body.into();
        self
    }

    pub fn set_header(&mut self, name: &str, value: &str) {
        // Prevent header injection through CR/LF in values.
        let value: String = value.chars().filter(|c| *c != '\r' && *c != '\n').collect();
        if let Some(h) = self
            .headers
            .iter_mut()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
        {
            h.1 = value;
        } else {
            self.headers.push((name.to_string(), value));
        }
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// Serialises the response. For HEAD requests the body is omitted but
    /// Content-Length still reflects it.
    pub fn write_to<W: Write>(
        &self,
        w: &mut W,
        head_only: bool,
        keep_alive: bool,
    ) -> io::Result<()> {
        let mut out = Vec::with_capacity(256 + self.body.len());
        write!(
            out,
            "HTTP/1.1 {} {}\r\n",
            self.status.0,
            self.status.reason()
        )?;
        for (n, v) in &self.headers {
            if n.eq_ignore_ascii_case("content-length") || n.eq_ignore_ascii_case("connection") {
                continue;
            }
            write!(out, "{n}: {v}\r\n")?;
        }
        let no_body = self.status.0 == 204 || self.status.0 == 304;
        if !no_body {
            write!(out, "Content-Length: {}\r\n", self.body.len())?;
        }
        write!(
            out,
            "Connection: {}\r\n\r\n",
            if keep_alive { "keep-alive" } else { "close" }
        )?;
        if !head_only && !no_body {
            out.extend_from_slice(&self.body);
        }
        w.write_all(&out)?;
        w.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialises_status_headers_and_body() {
        let mut buf = Vec::new();
        Response::text("hi")
            .with_header("X-Test", "1")
            .write_to(&mut buf, false, true)
            .unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert!(s.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(s.contains("Content-Length: 2\r\n"));
        assert!(s.contains("Connection: keep-alive\r\n"));
        assert!(s.ends_with("\r\n\r\nhi"));
    }

    #[test]
    fn head_omits_body_and_header_values_are_sanitised() {
        let mut buf = Vec::new();
        Response::text("hello")
            .with_header("X-Evil", "a\r\nSet-Cookie: x")
            .write_to(&mut buf, true, false)
            .unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert!(s.contains("Content-Length: 5"));
        assert!(s.contains("X-Evil: aSet-Cookie: x\r\n"));
        assert!(s.ends_with("\r\n\r\n"));
    }
}
