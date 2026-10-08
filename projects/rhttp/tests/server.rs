use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::thread;
use std::time::Duration;

use rhttp::{Response, Router, Server, ServerConfig, Status};

fn start() -> SocketAddr {
    let mut router = Router::new();
    router
        .get("/hello/:name", |r| {
            Response::text(format!("Hello, {}!", r.param("name").unwrap()))
        })
        .post("/echo", |r| {
            Response::new(Status::OK).with_body(r.body.clone())
        })
        .get("/panic", |_| panic!("handler bug"));
    let server = Server::bind("127.0.0.1:0")
        .unwrap()
        .with_config(ServerConfig {
            threads: 4,
            max_body: 1024,
            keep_alive_timeout: Duration::from_millis(500),
            max_requests_per_conn: 100,
            log: false,
        });
    let addr = server.local_addr().unwrap();
    thread::spawn(move || server.run(router));
    addr
}

/// Reads one response (status line, headers, Content-Length body).
fn read_response(r: &mut BufReader<TcpStream>) -> (u16, Vec<(String, String)>, String) {
    let mut line = String::new();
    r.read_line(&mut line).unwrap();
    let status: u16 = line.split(' ').nth(1).unwrap().parse().unwrap();
    let mut headers = Vec::new();
    loop {
        line.clear();
        r.read_line(&mut line).unwrap();
        let l = line.trim_end();
        if l.is_empty() {
            break;
        }
        let (k, v) = l.split_once(": ").unwrap();
        headers.push((k.to_string(), v.to_string()));
    }
    let len = headers
        .iter()
        .find(|(k, _)| k == "Content-Length")
        .map_or(0, |(_, v)| v.parse().unwrap());
    let mut body = vec![0; len];
    r.read_exact(&mut body).unwrap();
    (status, headers, String::from_utf8(body).unwrap())
}

#[test]
fn serves_routes_over_tcp() {
    let addr = start();
    let mut s = TcpStream::connect(addr).unwrap();
    s.write_all(b"GET /hello/Sumit HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        .unwrap();
    let (status, headers, body) = read_response(&mut BufReader::new(s));
    assert_eq!(status, 200);
    assert_eq!(body, "Hello, Sumit!");
    assert!(headers.contains(&("Connection".into(), "close".into())));
}

#[test]
fn keep_alive_and_pipelining() {
    let addr = start();
    let s = TcpStream::connect(addr).unwrap();
    let mut w = s.try_clone().unwrap();
    // Three pipelined requests in a single write
    w.write_all(
        b"GET /hello/a HTTP/1.1\r\n\r\nPOST /echo HTTP/1.1\r\nContent-Length: 4\r\n\r\npingGET /hello/c HTTP/1.1\r\n\r\n",
    )
    .unwrap();
    let mut r = BufReader::new(s);
    assert_eq!(read_response(&mut r).2, "Hello, a!");
    assert_eq!(read_response(&mut r).2, "ping");
    assert_eq!(read_response(&mut r).2, "Hello, c!");
}

#[test]
fn errors_are_reported_with_proper_status() {
    let addr = start();
    for (raw, want) in [
        (
            &b"GET /missing HTTP/1.1\r\nConnection: close\r\n\r\n"[..],
            404,
        ),
        (b"DELETE /echo HTTP/1.1\r\nConnection: close\r\n\r\n", 405),
        (b"POST /echo HTTP/1.1\r\nContent-Length: 99999\r\n\r\n", 413),
        (b"garbage\r\n\r\n", 400),
        (b"BREW /pot HTTP/1.1\r\n\r\n", 501),
        (b"GET /panic HTTP/1.1\r\nConnection: close\r\n\r\n", 500),
    ] {
        let mut s = TcpStream::connect(addr).unwrap();
        s.write_all(raw).unwrap();
        assert_eq!(
            read_response(&mut BufReader::new(s)).0,
            want,
            "{}",
            String::from_utf8_lossy(raw)
        );
    }
}

#[test]
fn server_survives_handler_panic_and_many_clients() {
    let addr = start();
    let handles: Vec<_> = (0..32)
        .map(|i| {
            thread::spawn(move || {
                let mut s = TcpStream::connect(addr).unwrap();
                let path = if i % 8 == 0 {
                    "/panic".to_string()
                } else {
                    format!("/hello/{i}")
                };
                write!(s, "GET {path} HTTP/1.1\r\nConnection: close\r\n\r\n").unwrap();
                read_response(&mut BufReader::new(s)).0
            })
        })
        .collect();
    let codes: Vec<u16> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(codes.iter().filter(|c| **c == 500).count(), 4);
    assert_eq!(codes.iter().filter(|c| **c == 200).count(), 28);
}

#[test]
fn head_request_has_length_but_no_body() {
    let addr = start();
    let mut s = TcpStream::connect(addr).unwrap();
    s.write_all(b"HEAD /hello/x HTTP/1.1\r\nConnection: close\r\n\r\n")
        .unwrap();
    let mut raw = String::new();
    s.read_to_string(&mut raw).unwrap();
    assert!(raw.contains("Content-Length: 9\r\n"));
    assert!(raw.ends_with("\r\n\r\n"));
}
