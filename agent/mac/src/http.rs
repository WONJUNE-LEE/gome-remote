//! The agent's HTTP interface for the gateway (spec D2, D5, D7): `GET /v1/status` and
//! `POST /v1/sessions`. `route` holds every decision and is tested without a socket;
//! `serve` only moves bytes between tiny_http and `route`.
use crate::auth::{Backoff, Guard, Reject, RequestMeta};
use crate::size::{self, Size};
use crate::status::{Gate, Status};
use serde_json::{json, Value};
use std::io::Read;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const MAX_BODY: u64 = 64 * 1024;
/// Requests handled at once. Each waits on its own thread, so a slowed-down failed
/// login never delays a request that authenticates; beyond this the agent says 503.
pub const MAX_IN_FLIGHT: usize = 16;

pub struct SessionRequest {
    pub size: Size,
    pub sdp: String,
}

pub enum SessionFailure {
    Gate(Gate),
    /// The offer could not be used (400).
    BadOffer(String),
    /// Anything else (500). The text goes to the log, never to the caller.
    Internal(String),
}

pub trait Backend: Send + Sync {
    fn status(&self) -> Status;
    fn start_session(&self, request: SessionRequest) -> Result<String, SessionFailure>;
}

pub struct Head<'a> {
    pub method: &'a str,
    /// Path without a query string.
    pub path: &'a str,
    pub peer: IpAddr,
    pub host: Option<&'a str>,
    pub origin: Option<&'a str>,
    pub authorization: Option<&'a str>,
    pub content_type: Option<&'a str>,
    pub content_length: Option<u64>,
}

#[derive(Debug, PartialEq)]
pub struct Reply {
    pub status: u16,
    pub body: String,
    /// How long to wait before answering (failed authentication only).
    pub delay: Duration,
}
impl Reply {
    fn json(status: u16, value: Value) -> Reply {
        Reply { status, body: value.to_string(), delay: Duration::ZERO }
    }
    fn error(status: u16, message: &str) -> Reply {
        Reply::json(status, json!({ "error": message }))
    }
}

pub struct Router {
    guard: Guard,
    backend: Arc<dyn Backend>,
    backoff: Mutex<Backoff>,
}

impl Router {
    pub fn new(guard: Guard, backend: Arc<dyn Backend>) -> Self {
        Router { guard, backend, backoff: Mutex::new(Backoff::default()) }
    }

    pub fn route(&self, head: &Head, body: &mut dyn Read) -> Reply {
        let meta =
            RequestMeta { peer: head.peer, host: head.host, origin: head.origin, authorization: head.authorization };
        match self.guard.check(&meta) {
            Ok(()) => self.backoff.lock().unwrap().succeeded(),
            Err(Reject::Forbidden(why)) => {
                eprintln!("[http] refused ({why})");
                return Reply::error(403, "forbidden");
            }
            Err(Reject::Unauthorized) => {
                eprintln!("[http] refused (token)");
                let delay = self.backoff.lock().unwrap().failed();
                return Reply { delay, ..Reply::error(401, "unauthorized") };
            }
        }
        match (head.method, head.path) {
            ("GET", "/v1/status") => {
                Reply { status: 200, body: self.backend.status().to_json(), delay: Duration::ZERO }
            }
            ("POST", "/v1/sessions") => self.create_session(head, body),
            (_, "/v1/status") | (_, "/v1/sessions") => Reply::error(405, "method not allowed"),
            _ => Reply::error(404, "not found"),
        }
    }

    fn create_session(&self, head: &Head, body: &mut dyn Read) -> Reply {
        if !head.content_type.map(|t| t.starts_with("application/json")).unwrap_or(false) {
            return Reply::error(415, "json required");
        }
        let Some(length) = head.content_length else {
            return Reply::error(411, "content-length required");
        };
        if length > MAX_BODY {
            return Reply::error(413, "body too large");
        }
        let mut bytes = Vec::with_capacity(length as usize);
        if body.take(length).read_to_end(&mut bytes).is_err() || bytes.len() as u64 != length {
            return Reply::error(400, "body incomplete");
        }
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            return Reply::error(400, "invalid json");
        };
        let request = (|| {
            let width = value.get("width")?.as_i64()?;
            let height = value.get("height")?.as_i64()?;
            let sdp = value.get("sdp")?.as_str().filter(|s| s.starts_with("v=0"))?;
            Some(SessionRequest { size: size::parse_requested(width, height)?, sdp: sdp.to_string() })
        })();
        let Some(request) = request else {
            return Reply::error(400, "width, height and sdp are required");
        };
        match self.backend.start_session(request) {
            Ok(sdp) => Reply::json(200, json!({ "sdp": sdp })),
            Err(SessionFailure::Gate(gate)) => {
                Reply::json(gate.http_status(), json!({ "error": gate.code(), "code": gate.code() }))
            }
            Err(SessionFailure::BadOffer(why)) => {
                eprintln!("[http] bad offer: {why}");
                Reply::error(400, "offer rejected")
            }
            Err(SessionFailure::Internal(why)) => {
                eprintln!("[http] session failed: {why}");
                Reply::error(500, "session failed")
            }
        }
    }
}

/// Serves until the process ends. One thread per request, at most `MAX_IN_FLIGHT`.
pub fn serve(bind: SocketAddr, router: Arc<Router>) -> anyhow::Result<()> {
    let server = tiny_http::Server::http(bind).map_err(|e| anyhow::anyhow!("cannot bind {bind}: {e}"))?;
    println!("[http] listening on {bind}");
    let in_flight = Arc::new(AtomicUsize::new(0));
    for request in server.incoming_requests() {
        if in_flight.fetch_add(1, SeqCst) >= MAX_IN_FLIGHT {
            in_flight.fetch_sub(1, SeqCst);
            let _ = request.respond(tiny_http::Response::from_string("busy").with_status_code(503));
            continue;
        }
        let (router, in_flight) = (router.clone(), in_flight.clone());
        std::thread::spawn(move || {
            handle(&router, request);
            in_flight.fetch_sub(1, SeqCst);
        });
    }
    Ok(())
}

fn header(request: &tiny_http::Request, name: &str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

fn handle(router: &Router, mut request: tiny_http::Request) {
    let Some(peer) = request.remote_addr().map(|a| a.ip()) else { return };
    let method = request.method().as_str().to_string();
    let path = request.url().split('?').next().unwrap_or("/").to_string();
    let (host, origin, authorization, content_type) = (
        header(&request, "Host"),
        header(&request, "Origin"),
        header(&request, "Authorization"),
        header(&request, "Content-Type"),
    );
    let head = Head {
        method: &method,
        path: &path,
        peer,
        host: host.as_deref(),
        origin: origin.as_deref(),
        authorization: authorization.as_deref(),
        content_type: content_type.as_deref(),
        content_length: request.body_length().map(|n| n as u64),
    };
    let reply = router.route(&head, request.as_reader());
    if !reply.delay.is_zero() {
        std::thread::sleep(reply.delay);
    }
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    let _ = request
        .respond(tiny_http::Response::from_string(reply.body).with_status_code(reply.status).with_header(header));
}

// ---- tests ----

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status::{Accessibility, DisplayState, Screen};
    use std::sync::atomic::AtomicBool;

    const TOKEN: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

    struct Fake {
        gate: Mutex<Option<Gate>>,
        started: AtomicBool,
        last_size: Mutex<Option<Size>>,
    }
    impl Backend for Fake {
        fn status(&self) -> Status {
            Status {
                screen: Screen::Granted,
                accessibility: Accessibility::Granted,
                display: DisplayState::Ok,
                locked: false,
                last_capture_at: None,
                version: "0.1.0",
            }
        }
        fn start_session(&self, request: SessionRequest) -> Result<String, SessionFailure> {
            if let Some(gate) = *self.gate.lock().unwrap() {
                return Err(SessionFailure::Gate(gate));
            }
            self.started.store(true, SeqCst);
            *self.last_size.lock().unwrap() = Some(request.size);
            Ok("v=0\r\nanswer".to_string())
        }
    }

    fn router() -> (Router, Arc<Fake>) {
        let fake =
            Arc::new(Fake { gate: Mutex::new(None), started: AtomicBool::new(false), last_size: Mutex::new(None) });
        let guard = Guard::new("100.64.0.20:18471".parse().unwrap(), "100.64.0.10".parse().unwrap(), TOKEN.into());
        (Router::new(guard, fake.clone()), fake)
    }

    fn head<'a>(method: &'a str, path: &'a str, auth: &'a str, length: Option<u64>) -> Head<'a> {
        Head {
            method,
            path,
            peer: "100.64.0.10".parse().unwrap(),
            host: Some("100.64.0.20:18471"),
            origin: None,
            authorization: Some(auth),
            content_type: Some("application/json"),
            content_length: length,
        }
    }
    const BEARER: &str = "Bearer abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
    const GOOD_BODY: &str = r#"{"width":2560,"height":1440,"sdp":"v=0\r\nm=video"}"#;

    fn post(r: &Router, body: &str) -> Reply {
        r.route(&head("POST", "/v1/sessions", BEARER, Some(body.len() as u64)), &mut body.as_bytes())
    }

    #[test]
    fn status_needs_the_token_and_returns_the_enumerations() {
        let (r, _) = router();
        let reply = r.route(&head("GET", "/v1/status", BEARER, None), &mut std::io::empty());
        assert_eq!(reply.status, 200);
        let v: Value = serde_json::from_str(&reply.body).unwrap();
        assert_eq!(v["screen"], "granted");
        let denied = r.route(&head("GET", "/v1/status", "Bearer nope", None), &mut std::io::empty());
        assert_eq!(denied.status, 401);
    }

    #[test]
    fn a_session_request_reaches_the_backend_with_the_requested_size() {
        let (r, fake) = router();
        let reply = post(&r, GOOD_BODY);
        assert_eq!(reply.status, 200, "{}", reply.body);
        assert_eq!(serde_json::from_str::<Value>(&reply.body).unwrap()["sdp"], "v=0\r\nanswer");
        assert!(fake.started.load(SeqCst));
        assert_eq!(*fake.last_size.lock().unwrap(), Some(Size { w: 2560, h: 1440 }));
    }

    #[test]
    fn refusals_say_forbidden_without_delay_and_never_reach_the_backend() {
        let (r, fake) = router();
        let mut stranger = head("POST", "/v1/sessions", BEARER, Some(GOOD_BODY.len() as u64));
        stranger.peer = "100.64.0.99".parse().unwrap();
        let reply = r.route(&stranger, &mut GOOD_BODY.as_bytes());
        assert_eq!((reply.status, reply.delay), (403, Duration::ZERO));
        let mut browser = head("POST", "/v1/sessions", BEARER, Some(GOOD_BODY.len() as u64));
        browser.origin = Some("https://gateway.example.ts.net:8451");
        assert_eq!(r.route(&browser, &mut GOOD_BODY.as_bytes()).status, 403);
        let mut rebinding = head("POST", "/v1/sessions", BEARER, Some(GOOD_BODY.len() as u64));
        rebinding.host = Some("attacker.example:18471");
        assert_eq!(r.route(&rebinding, &mut GOOD_BODY.as_bytes()).status, 403);
        assert!(!fake.started.load(SeqCst));
    }

    #[test]
    fn wrong_tokens_are_slowed_down_and_a_good_request_resets_it() {
        let (r, _) = router();
        let bad = |r: &Router| r.route(&head("GET", "/v1/status", "Bearer nope", None), &mut std::io::empty());
        assert_eq!(bad(&r).delay, Duration::from_millis(100));
        assert_eq!(bad(&r).delay, Duration::from_millis(200));
        let ok = r.route(&head("GET", "/v1/status", BEARER, None), &mut std::io::empty());
        assert_eq!((ok.status, ok.delay), (200, Duration::ZERO), "the gateway itself is never delayed");
        assert_eq!(bad(&r).delay, Duration::from_millis(100));
    }

    #[test]
    fn body_rules_content_type_length_cap_json_and_fields() {
        let (r, _) = router();
        let mut no_type = head("POST", "/v1/sessions", BEARER, Some(2));
        no_type.content_type = Some("text/plain");
        assert_eq!(r.route(&no_type, &mut "{}".as_bytes()).status, 415);
        no_type.content_type = None;
        assert_eq!(r.route(&no_type, &mut "{}".as_bytes()).status, 415);
        let chunked = head("POST", "/v1/sessions", BEARER, None);
        assert_eq!(r.route(&chunked, &mut GOOD_BODY.as_bytes()).status, 411);
        let huge = head("POST", "/v1/sessions", BEARER, Some(MAX_BODY + 1));
        assert_eq!(r.route(&huge, &mut std::io::repeat(b'x')).status, 413);
        let at_cap = format!(r#"{{"width":2560,"height":1440,"sdp":"v=0{}"}}"#, "a".repeat(MAX_BODY as usize - 40));
        assert!(at_cap.len() as u64 <= MAX_BODY);
        assert_eq!(post(&r, &at_cap).status, 200, "a body exactly at the cap is accepted");
        assert_eq!(post(&r, "not json").status, 400);
        // A length that promises more than arrives.
        let short = head("POST", "/v1/sessions", BEARER, Some(500));
        assert_eq!(r.route(&short, &mut GOOD_BODY.as_bytes()).status, 400);
        for body in [
            r#"{"width":2560,"height":1440}"#,
            r#"{"width":2560,"sdp":"v=0"}"#,
            r#"{"width":2560,"height":1440,"sdp":"hello"}"#,
            r#"{"width":2560,"height":1440,"sdp":5}"#,
            r#"{"width":100,"height":1440,"sdp":"v=0"}"#,
            r#"{"width":"2560","height":1440,"sdp":"v=0"}"#,
            r#"[]"#,
        ] {
            assert_eq!(post(&r, body).status, 400, "{body}");
        }
    }

    #[test]
    fn state_refusals_carry_their_codes() {
        let (r, fake) = router();
        *fake.gate.lock().unwrap() = Some(Gate::Permission);
        let reply = post(&r, GOOD_BODY);
        assert_eq!(reply.status, 403);
        assert_eq!(serde_json::from_str::<Value>(&reply.body).unwrap()["code"], "permission");
        *fake.gate.lock().unwrap() = Some(Gate::Locked);
        let reply = post(&r, GOOD_BODY);
        assert_eq!(reply.status, 423);
        assert_eq!(serde_json::from_str::<Value>(&reply.body).unwrap()["code"], "locked");
    }

    #[test]
    fn unknown_paths_and_methods_are_refused_after_authentication() {
        let (r, _) = router();
        assert_eq!(r.route(&head("GET", "/", BEARER, None), &mut std::io::empty()).status, 404);
        assert_eq!(r.route(&head("GET", "/v1/offer", BEARER, None), &mut std::io::empty()).status, 404);
        assert_eq!(r.route(&head("POST", "/v1/status", BEARER, Some(0)), &mut std::io::empty()).status, 405);
        assert_eq!(r.route(&head("GET", "/v1/sessions", BEARER, None), &mut std::io::empty()).status, 405);
        assert_eq!(
            r.route(&head("GET", "/", "Bearer nope", None), &mut std::io::empty()).status,
            401,
            "nothing is public"
        );
    }
}
