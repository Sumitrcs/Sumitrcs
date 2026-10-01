use std::io::{self, BufReader, BufWriter};
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::pool::ThreadPool;
use crate::request::{Method, ParseError, Request};
use crate::response::{Response, Status};
use crate::router::Router;

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub threads: usize,
    pub max_body: usize,
    /// How long an idle keep-alive connection is held open.
    pub keep_alive_timeout: Duration,
    /// Maximum requests served on one connection.
    pub max_requests_per_conn: usize,
    pub log: bool,
}

impl Default for ServerConfig {
    fn default() -> Self {
        ServerConfig {
            threads: std::thread::available_parallelism().map_or(4, |n| n.get() * 2),
            max_body: 1 << 20,
            keep_alive_timeout: Duration::from_secs(5),
            max_requests_per_conn: 1000,
            log: true,
        }
    }
}

pub struct Server {
    listener: TcpListener,
    config: ServerConfig,
    shutdown: Arc<AtomicBool>,
}

impl Server {
    pub fn bind<A: ToSocketAddrs>(addr: A) -> io::Result<Server> {
        Ok(Server {
            listener: TcpListener::bind(addr)?,
            config: ServerConfig::default(),
            shutdown: Arc::default(),
        })
    }

    pub fn with_config(mut self, config: ServerConfig) -> Self {
        self.config = config;
        self
    }

    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        self.listener.local_addr()
    }

    /// A handle that stops the accept loop when set (used by tests and signal handlers).
    pub fn shutdown_handle(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.shutdown)
    }

    pub fn run(self, router: Router) {
        let router = Arc::new(router);
        let pool = ThreadPool::new(self.config.threads);
        let config = Arc::new(self.config);
        if config.log
            && let Ok(addr) = self.listener.local_addr()
        {
            eprintln!("rhttp listening on http://{addr} ({} threads)", pool.size());
        }
        for stream in self.listener.incoming() {
            if self.shutdown.load(Ordering::SeqCst) {
                break;
            }
            let Ok(stream) = stream else { continue };
            let router = Arc::clone(&router);
            let config = Arc::clone(&config);
            pool.execute(move || {
                let _ = handle_connection(stream, &router, &config);
            });
        }
    }
}

fn handle_connection(stream: TcpStream, router: &Router, cfg: &ServerConfig) -> io::Result<()> {
    stream.set_read_timeout(Some(cfg.keep_alive_timeout))?;
    stream.set_nodelay(true)?;
    let peer = stream.peer_addr().ok();
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut writer = BufWriter::new(stream);

    for served in 1..=cfg.max_requests_per_conn {
        let started = Instant::now();
        let mut req = match Request::read_from(&mut reader, cfg.max_body) {
            Ok(r) => r,
            Err(ParseError::Eof) => return Ok(()),
            Err(ParseError::Io(_)) => return Ok(()), // timeout or reset
            Err(e) => {
                let status = match e {
                    ParseError::BodyTooLarge => Status::PAYLOAD_TOO_LARGE,
                    ParseError::HeadersTooLarge => Status::HEADERS_TOO_LARGE,
                    ParseError::UnsupportedMethod => Status::NOT_IMPLEMENTED,
                    ParseError::UnsupportedVersion => Status::VERSION_NOT_SUPPORTED,
                    _ => Status::BAD_REQUEST,
                };
                // After a framing error we can't trust the stream: always close.
                return Response::error(status).write_to(&mut writer, false, false);
            }
        };

        let keep_alive = req.keep_alive() && served < cfg.max_requests_per_conn;
        let head = req.method == Method::Head;
        let res = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            router.dispatch(&mut req)
        })) {
            Ok(r) => r,
            Err(_) => Response::error(Status::INTERNAL_SERVER_ERROR),
        };
        res.write_to(&mut writer, head, keep_alive)?;

        if cfg.log {
            eprintln!(
                "{} {} {} -> {} ({:.1} ms)",
                peer.map(|p| p.ip().to_string()).unwrap_or_default(),
                req.method.as_str(),
                req.path,
                res.status.0,
                started.elapsed().as_secs_f64() * 1000.0
            );
        }
        if !keep_alive {
            break;
        }
    }
    Ok(())
}
