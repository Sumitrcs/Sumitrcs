use std::collections::HashMap;
use std::fmt;
use std::io::{BufRead, Read};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Method {
    Get,
    Head,
    Post,
    Put,
    Patch,
    Delete,
    Options,
}

impl Method {
    fn parse(s: &str) -> Option<Method> {
        Some(match s {
            "GET" => Method::Get,
            "HEAD" => Method::Head,
            "POST" => Method::Post,
            "PUT" => Method::Put,
            "PATCH" => Method::Patch,
            "DELETE" => Method::Delete,
            "OPTIONS" => Method::Options,
            _ => return None,
        })
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Head => "HEAD",
            Method::Post => "POST",
            Method::Put => "PUT",
            Method::Patch => "PATCH",
            Method::Delete => "DELETE",
            Method::Options => "OPTIONS",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ParseError {
    /// Connection closed cleanly before a request started (normal for keep-alive).
    Eof,
    BadRequestLine,
    UnsupportedMethod,
    UnsupportedVersion,
    BadHeader,
    HeadersTooLarge,
    BodyTooLarge,
    BadContentLength,
    Io(String),
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

#[derive(Debug, Clone)]
pub struct Request {
    pub method: Method,
    pub path: String,
    pub query: HashMap<String, String>,
    pub version: String,
    /// Header names are stored lower-cased.
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
    pub(crate) params: HashMap<String, String>,
}

pub const MAX_HEADER_BYTES: usize = 16 * 1024;

impl Request {
    /// Reads one request from a buffered stream.
    pub fn read_from<R: BufRead>(reader: &mut R, max_body: usize) -> Result<Request, ParseError> {
        let mut header_bytes = 0usize;
        let mut line = String::new();

        // Tolerate stray CRLFs between pipelined requests (RFC 9112 §2.2).
        loop {
            line.clear();
            let n = read_line(reader, &mut line, &mut header_bytes)?;
            if n == 0 {
                return Err(ParseError::Eof);
            }
            if !line.trim().is_empty() {
                break;
            }
        }

        let request_line = std::mem::take(&mut line);
        let mut parts = request_line.trim_end().split(' ');
        let (m, target, version) = match (parts.next(), parts.next(), parts.next(), parts.next()) {
            (Some(m), Some(t), Some(v), None) if !t.is_empty() => (m, t, v),
            _ => return Err(ParseError::BadRequestLine),
        };
        let method = Method::parse(m).ok_or(ParseError::UnsupportedMethod)?;
        if version != "HTTP/1.1" && version != "HTTP/1.0" {
            return Err(ParseError::UnsupportedVersion);
        }
        if !target.starts_with('/') {
            return Err(ParseError::BadRequestLine);
        }
        let (raw_path, raw_query) = target.split_once('?').unwrap_or((target, ""));

        let mut headers = HashMap::new();
        loop {
            line.clear();
            if read_line(reader, &mut line, &mut header_bytes)? == 0 {
                return Err(ParseError::BadHeader);
            }
            let l = line.trim_end_matches(['\r', '\n']);
            if l.is_empty() {
                break;
            }
            let (name, value) = l.split_once(':').ok_or(ParseError::BadHeader)?;
            if name.is_empty() || name.contains(char::is_whitespace) {
                return Err(ParseError::BadHeader);
            }
            let name = name.to_ascii_lowercase();
            let value = value.trim().to_string();
            // Repeated headers are joined with ", " per RFC 9110 §5.3
            headers
                .entry(name)
                .and_modify(|v: &mut String| {
                    v.push_str(", ");
                    v.push_str(&value)
                })
                .or_insert(value);
        }

        if headers.contains_key("transfer-encoding") {
            // Chunked uploads are out of scope; refusing is safer than guessing
            // (mixing TE and Content-Length enables request smuggling).
            return Err(ParseError::BadContentLength);
        }
        let len = match headers.get("content-length") {
            Some(v) => v
                .parse::<usize>()
                .map_err(|_| ParseError::BadContentLength)?,
            None => 0,
        };
        if len > max_body {
            return Err(ParseError::BodyTooLarge);
        }
        let mut body = vec![0; len];
        reader
            .read_exact(&mut body)
            .map_err(|e| ParseError::Io(e.to_string()))?;

        Ok(Request {
            method,
            path: percent_decode(raw_path, false),
            query: parse_query(raw_query),
            version: version.to_string(),
            headers,
            body,
            params: HashMap::new(),
        })
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(&name.to_ascii_lowercase())
            .map(String::as_str)
    }

    /// A path parameter captured by the router, e.g. `:id` in `/users/:id`.
    pub fn param(&self, name: &str) -> Option<&str> {
        self.params.get(name).map(String::as_str)
    }

    pub fn query(&self, name: &str) -> Option<&str> {
        self.query.get(name).map(String::as_str)
    }

    pub fn body_str(&self) -> Option<&str> {
        std::str::from_utf8(&self.body).ok()
    }

    /// HTTP/1.1 defaults to keep-alive; HTTP/1.0 defaults to close.
    pub fn keep_alive(&self) -> bool {
        let conn = self.header("connection").unwrap_or("").to_ascii_lowercase();
        if self.version == "HTTP/1.0" {
            conn.contains("keep-alive")
        } else {
            !conn.contains("close")
        }
    }

    /// Parses an `application/x-www-form-urlencoded` body.
    pub fn form(&self) -> HashMap<String, String> {
        parse_query(self.body_str().unwrap_or(""))
    }
}

fn read_line<R: BufRead>(
    r: &mut R,
    buf: &mut String,
    total: &mut usize,
) -> Result<usize, ParseError> {
    let mut limited = r.take((MAX_HEADER_BYTES - *total + 1) as u64);
    let n = limited
        .read_line(buf)
        .map_err(|e| ParseError::Io(e.to_string()))?;
    *total += n;
    if *total > MAX_HEADER_BYTES {
        return Err(ParseError::HeadersTooLarge);
    }
    Ok(n)
}

pub fn parse_query(q: &str) -> HashMap<String, String> {
    q.split('&')
        .filter(|s| !s.is_empty())
        .map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            (percent_decode(k, true), percent_decode(v, true))
        })
        .collect()
}

/// Decodes %XX escapes (and '+' as space in query strings). Invalid escapes are kept literally.
pub fn percent_decode(s: &str, plus_as_space: bool) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(b) => {
                        out.push(b);
                        i += 3;
                        continue;
                    }
                    None => out.push(b'%'),
                }
            }
            b'+' if plus_as_space => out.push(b' '),
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn parse(raw: &str) -> Result<Request, ParseError> {
        Request::read_from(&mut Cursor::new(raw.as_bytes().to_vec()), 1024)
    }

    #[test]
    fn parses_request_line_headers_query_and_body() {
        let r = parse("POST /api/items%20x?q=a+b&n=1 HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nX-A: 1\r\nx-a: 2\r\n\r\nhello").unwrap();
        assert_eq!(r.method, Method::Post);
        assert_eq!(r.path, "/api/items x");
        assert_eq!(r.query("q"), Some("a b"));
        assert_eq!(r.header("HOST"), Some("x"));
        assert_eq!(r.header("x-a"), Some("1, 2"));
        assert_eq!(r.body_str(), Some("hello"));
        assert!(r.keep_alive());
    }

    #[test]
    fn rejects_malformed_requests() {
        assert_eq!(parse("").unwrap_err(), ParseError::Eof);
        assert_eq!(
            parse("GET\r\n\r\n").unwrap_err(),
            ParseError::BadRequestLine
        );
        assert_eq!(
            parse("BREW / HTTP/1.1\r\n\r\n").unwrap_err(),
            ParseError::UnsupportedMethod
        );
        assert_eq!(
            parse("GET / HTTP/2\r\n\r\n").unwrap_err(),
            ParseError::UnsupportedVersion
        );
        assert_eq!(
            parse("GET / HTTP/1.1\r\nBad Header: x\r\n\r\n").unwrap_err(),
            ParseError::BadHeader
        );
        assert_eq!(
            parse("GET / HTTP/1.1\r\nContent-Length: abc\r\n\r\n").unwrap_err(),
            ParseError::BadContentLength
        );
        assert_eq!(
            parse("POST / HTTP/1.1\r\nContent-Length: 4096\r\n\r\n").unwrap_err(),
            ParseError::BodyTooLarge
        );
        assert_eq!(
            parse("POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 3\r\n\r\nabc")
                .unwrap_err(),
            ParseError::BadContentLength
        );
    }

    #[test]
    fn enforces_header_size_limit() {
        let raw = format!(
            "GET / HTTP/1.1\r\nX-Big: {}\r\n\r\n",
            "a".repeat(MAX_HEADER_BYTES)
        );
        assert_eq!(parse(&raw).unwrap_err(), ParseError::HeadersTooLarge);
    }

    #[test]
    fn http10_defaults_to_close() {
        assert!(!parse("GET / HTTP/1.0\r\n\r\n").unwrap().keep_alive());
        assert!(
            parse("GET / HTTP/1.0\r\nConnection: keep-alive\r\n\r\n")
                .unwrap()
                .keep_alive()
        );
        assert!(
            !parse("GET / HTTP/1.1\r\nConnection: close\r\n\r\n")
                .unwrap()
                .keep_alive()
        );
    }

    #[test]
    fn percent_decoding_edge_cases() {
        assert_eq!(percent_decode("%41%42c", false), "ABc");
        assert_eq!(percent_decode("100%", false), "100%");
        assert_eq!(percent_decode("%zz", false), "%zz");
        assert_eq!(percent_decode("a+b", false), "a+b");
        assert_eq!(percent_decode("%E0%A4%A8", false), "न");
    }
}
