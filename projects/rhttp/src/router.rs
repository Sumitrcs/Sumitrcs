use std::collections::HashMap;
use std::sync::Arc;

use crate::request::{Method, Request};
use crate::response::{Response, Status};

pub type Handler = Arc<dyn Fn(&Request) -> Response + Send + Sync>;

#[derive(Debug, Clone, PartialEq)]
enum Segment {
    Static(String),
    Param(String),
    /// `*name` — matches the rest of the path (must be last).
    Wildcard(String),
}

struct Route {
    method: Method,
    segments: Vec<Segment>,
    handler: Handler,
}

/// Matches `METHOD /path` against registered patterns like `/users/:id`
/// and `/static/*path`. Static segments win over params, so `/users/me`
/// can be registered alongside `/users/:id` regardless of order.
#[derive(Default)]
pub struct Router {
    routes: Vec<Route>,
}

impl Router {
    pub fn new() -> Self {
        Router::default()
    }

    pub fn route<F>(&mut self, method: Method, pattern: &str, handler: F) -> &mut Self
    where
        F: Fn(&Request) -> Response + Send + Sync + 'static,
    {
        let segments = split(pattern)
            .map(|s| {
                if let Some(p) = s.strip_prefix(':') {
                    Segment::Param(p.to_string())
                } else if let Some(w) = s.strip_prefix('*') {
                    Segment::Wildcard(w.to_string())
                } else {
                    Segment::Static(s.to_string())
                }
            })
            .collect::<Vec<_>>();
        if let Some(pos) = segments
            .iter()
            .position(|s| matches!(s, Segment::Wildcard(_)))
        {
            assert_eq!(
                pos,
                segments.len() - 1,
                "wildcard must be the last segment in {pattern}"
            );
        }
        self.routes.push(Route {
            method,
            segments,
            handler: Arc::new(handler),
        });
        self
    }

    pub fn get<F: Fn(&Request) -> Response + Send + Sync + 'static>(
        &mut self,
        p: &str,
        h: F,
    ) -> &mut Self {
        self.route(Method::Get, p, h)
    }
    pub fn post<F: Fn(&Request) -> Response + Send + Sync + 'static>(
        &mut self,
        p: &str,
        h: F,
    ) -> &mut Self {
        self.route(Method::Post, p, h)
    }
    pub fn put<F: Fn(&Request) -> Response + Send + Sync + 'static>(
        &mut self,
        p: &str,
        h: F,
    ) -> &mut Self {
        self.route(Method::Put, p, h)
    }
    pub fn delete<F: Fn(&Request) -> Response + Send + Sync + 'static>(
        &mut self,
        p: &str,
        h: F,
    ) -> &mut Self {
        self.route(Method::Delete, p, h)
    }

    /// Finds the best route, fills `req.params` and runs the handler.
    /// Returns 404, or 405 with an `Allow` header when only the method is wrong.
    pub fn dispatch(&self, req: &mut Request) -> Response {
        let path: Vec<&str> = split(&req.path).collect();
        let mut best: Option<(u32, &Route, HashMap<String, String>)> = None;
        let mut allowed: Vec<&'static str> = Vec::new();

        for route in &self.routes {
            let Some((score, params)) = match_route(&route.segments, &path) else {
                continue;
            };
            // HEAD is served by GET handlers
            let method_ok = route.method == req.method
                || (req.method == Method::Head && route.method == Method::Get);
            if !method_ok {
                if !allowed.contains(&route.method.as_str()) {
                    allowed.push(route.method.as_str());
                }
                continue;
            }
            if best.as_ref().is_none_or(|(s, _, _)| score > *s) {
                best = Some((score, route, params));
            }
        }

        match best {
            Some((_, route, params)) => {
                req.params = params;
                (route.handler)(req)
            }
            None if !allowed.is_empty() => {
                allowed.sort();
                Response::error(Status::METHOD_NOT_ALLOWED)
                    .with_header("Allow", &allowed.join(", "))
            }
            None => Response::error(Status::NOT_FOUND),
        }
    }
}

fn split(path: &str) -> impl Iterator<Item = &str> {
    path.split('/').filter(|s| !s.is_empty())
}

/// Returns a specificity score (static > param > wildcard) and captured params.
fn match_route(pattern: &[Segment], path: &[&str]) -> Option<(u32, HashMap<String, String>)> {
    let mut params = HashMap::new();
    let mut score = 0u32;
    for (i, seg) in pattern.iter().enumerate() {
        match seg {
            Segment::Wildcard(name) => {
                params.insert(
                    name.clone(),
                    path.get(i..).map(|p| p.join("/")).unwrap_or_default(),
                );
                return Some((score, params));
            }
            Segment::Static(s) => {
                if path.get(i) != Some(&s.as_str()) {
                    return None;
                }
                score += 3u32.pow(8u32.saturating_sub(i as u32)) * 2;
            }
            Segment::Param(name) => {
                params.insert(name.clone(), (*path.get(i)?).to_string());
                score += 3u32.pow(8u32.saturating_sub(i as u32));
            }
        }
    }
    (pattern.len() == path.len()).then_some((score, params))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn req(method: &str, path: &str) -> Request {
        let raw = format!("{method} {path} HTTP/1.1\r\n\r\n");
        Request::read_from(&mut Cursor::new(raw.into_bytes()), 0).unwrap()
    }

    fn body(r: Response) -> String {
        String::from_utf8(r.body).unwrap()
    }

    fn router() -> Router {
        let mut r = Router::new();
        r.get("/", |_| Response::text("home"))
            .get("/users/:id", |q| {
                Response::text(format!("user {}", q.param("id").unwrap()))
            })
            .get("/users/me", |_| Response::text("me"))
            .post("/users", |_| {
                Response::text("created").with_status(Status::CREATED)
            })
            .get("/files/*rest", |q| {
                Response::text(format!("file {}", q.param("rest").unwrap()))
            })
            .get("/users/:id/posts/:post", |q| {
                Response::text(format!(
                    "{}:{}",
                    q.param("id").unwrap(),
                    q.param("post").unwrap()
                ))
            });
        r
    }

    #[test]
    fn matches_static_params_and_wildcards() {
        let r = router();
        assert_eq!(body(r.dispatch(&mut req("GET", "/"))), "home");
        assert_eq!(body(r.dispatch(&mut req("GET", "/users/42"))), "user 42");
        assert_eq!(body(r.dispatch(&mut req("GET", "/users/me"))), "me");
        assert_eq!(body(r.dispatch(&mut req("GET", "/users/7/posts/9"))), "7:9");
        assert_eq!(
            body(r.dispatch(&mut req("GET", "/files/a/b/c.txt"))),
            "file a/b/c.txt"
        );
        assert_eq!(body(r.dispatch(&mut req("GET", "/users/42/"))), "user 42");
    }

    #[test]
    fn not_found_and_method_not_allowed() {
        let r = router();
        assert_eq!(
            r.dispatch(&mut req("GET", "/nope")).status,
            Status::NOT_FOUND
        );
        let res = r.dispatch(&mut req("DELETE", "/users"));
        assert_eq!(res.status, Status::METHOD_NOT_ALLOWED);
        assert_eq!(res.header("Allow"), Some("POST"));
    }

    #[test]
    fn head_uses_get_handler() {
        assert_eq!(router().dispatch(&mut req("HEAD", "/")).status, Status::OK);
    }
}
