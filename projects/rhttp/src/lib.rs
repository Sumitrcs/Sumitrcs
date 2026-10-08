//! A small HTTP/1.1 server built only on the Rust standard library.
//!
//! ```no_run
//! use rhttp::{Response, Router, Server};
//!
//! let mut router = Router::new();
//! router.get("/hello/:name", |req| Response::text(format!("Hello, {}!", req.param("name").unwrap())));
//! Server::bind("127.0.0.1:8080").unwrap().run(router);
//! ```

mod pool;
mod request;
mod response;
mod router;
mod server;
mod static_files;

pub use pool::ThreadPool;
pub use request::{Method, ParseError, Request};
pub use response::{Response, Status};
pub use router::{Handler, Router};
pub use server::{Server, ServerConfig};
pub use static_files::{mime_type, serve_dir};
