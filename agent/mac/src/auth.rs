//! Who may talk to the agent's HTTP server (spec D2): only the configured gateway
//! address, only with `Host` equal to the bound address and port, never with an `Origin`
//! header (a browser sends one; the gateway does not), and only with the bearer token.
use crate::tailnet::is_tailnet_ip;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;
use subtle::ConstantTimeEq;

#[derive(Debug, PartialEq, Eq)]
pub enum Reject {
    /// 403: the caller is not the gateway, or the request looks like a browser's.
    Forbidden(&'static str),
    /// 401: right place, wrong or missing token. Only this one is slowed down.
    Unauthorized,
}

pub struct RequestMeta<'a> {
    pub peer: IpAddr,
    pub host: Option<&'a str>,
    pub origin: Option<&'a str>,
    pub authorization: Option<&'a str>,
}

pub struct Guard {
    bind: SocketAddr,
    gateway: IpAddr,
    token: String,
}

/// An IPv4 peer can show up as an IPv4-mapped IPv6 address on a dual-stack socket.
fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        v4 => v4,
    }
}

impl Guard {
    pub fn new(bind: SocketAddr, gateway: IpAddr, token: String) -> Self {
        Guard { bind, gateway: canonical(gateway), token }
    }

    /// `Host` exactly as a client addressing the bound address would send it.
    pub fn expected_host(&self) -> String {
        match self.bind.ip() {
            IpAddr::V4(v4) => format!("{v4}:{}", self.bind.port()),
            IpAddr::V6(v6) => format!("[{v6}]:{}", self.bind.port()),
        }
    }

    pub fn check(&self, request: &RequestMeta) -> Result<(), Reject> {
        let peer = canonical(request.peer);
        if peer != self.gateway || !is_tailnet_ip(peer) {
            return Err(Reject::Forbidden("source"));
        }
        if request.host != Some(self.expected_host().as_str()) {
            return Err(Reject::Forbidden("host"));
        }
        if request.origin.is_some() {
            return Err(Reject::Forbidden("origin"));
        }
        let presented = request.authorization.and_then(|value| value.strip_prefix("Bearer ")).unwrap_or("");
        if !constant_time_eq(presented.as_bytes(), self.token.as_bytes()) {
            return Err(Reject::Unauthorized);
        }
        Ok(())
    }
}

/// Length-independent comparison (a length difference still compares every byte of the
/// longer side, against a fixed filler).
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let len = a.len().max(b.len());
    let pad = |s: &[u8]| {
        let mut v = vec![0xffu8; len];
        v[..s.len()].copy_from_slice(s);
        v
    };
    let same_length = (a.len() as u64).ct_eq(&(b.len() as u64));
    let same_bytes = pad(a).ct_eq(&pad(b));
    bool::from(same_length & same_bytes)
}

/// Slows down consecutive authentication failures: 100 ms, 200 ms, 400 ms ... up to 5 s.
/// A success resets it. Requests that authenticate are never delayed.
#[derive(Default)]
pub struct Backoff {
    failures: u32,
}
impl Backoff {
    pub const FIRST: Duration = Duration::from_millis(100);
    pub const MAX: Duration = Duration::from_secs(5);

    pub fn failed(&mut self) -> Duration {
        self.failures = self.failures.saturating_add(1);
        let shift = (self.failures - 1).min(10);
        (Self::FIRST * (1u32 << shift)).min(Self::MAX)
    }
    pub fn succeeded(&mut self) {
        self.failures = 0;
    }
}

// ---- tests ----

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

    fn guard() -> Guard {
        Guard::new("100.64.0.20:18471".parse().unwrap(), "100.64.0.10".parse().unwrap(), TOKEN.into())
    }
    fn good<'a>(auth: &'a str) -> RequestMeta<'a> {
        RequestMeta {
            peer: "100.64.0.10".parse().unwrap(),
            host: Some("100.64.0.20:18471"),
            origin: None,
            authorization: Some(auth),
        }
    }

    #[test]
    fn the_gateway_with_the_token_passes() {
        let bearer = format!("Bearer {TOKEN}");
        assert_eq!(guard().check(&good(&bearer)), Ok(()));
    }

    #[test]
    fn a_wrong_missing_or_malformed_token_is_unauthorized() {
        let g = guard();
        for auth in [
            "Bearer wrong",
            "Bearer ",
            "Bearer",
            "bearer abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
            "Basic abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
            "Bearer abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ ",
            "Bearer abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP",
            "Bearer abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQR",
        ] {
            assert_eq!(g.check(&good(auth)), Err(Reject::Unauthorized), "{auth:?}");
        }
        let mut none = good("");
        none.authorization = None;
        assert_eq!(g.check(&none), Err(Reject::Unauthorized));
    }

    #[test]
    fn a_tailnet_address_that_is_not_the_gateway_is_forbidden_even_with_the_token() {
        let bearer = format!("Bearer {TOKEN}");
        for peer in ["100.64.0.99", "100.127.255.254", "127.0.0.1", "192.168.1.9", "fd7a:115c:a1e0::1234"] {
            let mut request = good(&bearer);
            request.peer = peer.parse().unwrap();
            assert_eq!(guard().check(&request), Err(Reject::Forbidden("source")), "{peer}");
        }
    }

    #[test]
    fn an_ipv4_mapped_gateway_address_is_the_gateway() {
        let bearer = format!("Bearer {TOKEN}");
        let mut request = good(&bearer);
        request.peer = "::ffff:100.64.0.10".parse().unwrap();
        assert_eq!(guard().check(&request), Ok(()));
    }

    #[test]
    fn host_must_be_the_bound_address_and_port() {
        let bearer = format!("Bearer {TOKEN}");
        for host in [
            None,
            Some("100.64.0.20"),
            Some("100.64.0.20:18472"),
            Some("localhost:18471"),
            Some("attacker.example:18471"),
            Some("100.64.0.20:18471 "),
            Some("100.64.0.99:18471"),
        ] {
            let mut request = good(&bearer);
            request.host = host;
            assert_eq!(guard().check(&request), Err(Reject::Forbidden("host")), "{host:?}");
        }
    }

    #[test]
    fn any_origin_header_is_refused() {
        let bearer = format!("Bearer {TOKEN}");
        for origin in ["http://100.64.0.20:18471", "https://gateway.example.ts.net:8451", "null", ""] {
            let mut request = good(&bearer);
            request.origin = Some(origin);
            assert_eq!(guard().check(&request), Err(Reject::Forbidden("origin")), "{origin:?}");
        }
    }

    #[test]
    fn source_is_judged_before_the_token_so_strangers_learn_nothing() {
        let mut request = good("Bearer wrong");
        request.peer = "100.64.0.99".parse().unwrap();
        assert_eq!(guard().check(&request), Err(Reject::Forbidden("source")));
    }

    #[test]
    fn an_ipv6_bind_expects_a_bracketed_host() {
        let g =
            Guard::new("[fd7a:115c:a1e0::1234]:18471".parse().unwrap(), "100.64.0.10".parse().unwrap(), TOKEN.into());
        assert_eq!(g.expected_host(), "[fd7a:115c:a1e0::1234]:18471");
    }

    #[test]
    fn constant_time_eq_handles_every_length_relation() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(constant_time_eq(b"", b""));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(!constant_time_eq(b"abcd", b"abc"));
        assert!(!constant_time_eq(b"", b"a"));
        // The filler byte must not make a short value equal a longer one that ends in it.
        assert!(!constant_time_eq(b"a", b"a\xff"));
    }

    #[test]
    fn backoff_doubles_up_to_five_seconds_and_resets_on_success() {
        let mut b = Backoff::default();
        assert_eq!(b.failed(), Duration::from_millis(100));
        assert_eq!(b.failed(), Duration::from_millis(200));
        assert_eq!(b.failed(), Duration::from_millis(400));
        for _ in 0..40 {
            b.failed();
        }
        assert_eq!(b.failed(), Duration::from_secs(5));
        b.succeeded();
        assert_eq!(b.failed(), Duration::from_millis(100));
    }
}
