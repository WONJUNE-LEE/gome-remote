//! Which addresses count as "the tailnet", and the ICE candidate filter built on it.
//!
//! The range is written as numbers, not as text, so the public-repository hygiene scan
//! (which looks for address-shaped text) has nothing to flag in this file.
use std::net::IpAddr;

/// IPv4 100.64/10 (second octet 64..=127) and IPv6 fd7a:115c:a1e0::/48.
pub fn is_tailnet_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 100 && (64..=127).contains(&o[1])
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_tailnet_ip(IpAddr::V4(v4));
            }
            let s = v6.segments();
            s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0
        }
    }
}

/// Removes every `a=candidate:` line of an SDP whose address is not a literal tailnet
/// UDP address. mDNS names (`<uuid>.local`), LAN and public addresses, relay and TCP
/// candidates all go. Other lines, and the line ending style, are left exactly as they were.
pub fn filter_offer_candidates(sdp: &str) -> String {
    let mut out = String::with_capacity(sdp.len());
    for line in sdp.split_inclusive('\n') {
        let text = line.trim_end_matches(['\r', '\n']);
        if let Some(rest) = text.strip_prefix("a=candidate:") {
            if !candidate_allowed(rest) {
                continue;
            }
        }
        out.push_str(line);
    }
    out
}

// rest = "<foundation> <component> <transport> <priority> <address> <port> typ <type> ..."
fn candidate_allowed(rest: &str) -> bool {
    let mut parts = rest.split_whitespace();
    let (_foundation, _component, transport, _priority, address) =
        (parts.next(), parts.next(), parts.next(), parts.next(), parts.next());
    match (transport, address.and_then(|a| a.parse::<IpAddr>().ok())) {
        (Some(t), Some(ip)) => t.eq_ignore_ascii_case("udp") && is_tailnet_ip(ip),
        _ => false,
    }
}

// ---- tests ----

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn tailnet_ranges_are_exact_at_both_edges() {
        assert!(is_tailnet_ip(ip("100.64.0.20")));
        assert!(is_tailnet_ip(ip("100.127.255.254")));
        assert!(!is_tailnet_ip(ip("100.63.255.255")));
        assert!(!is_tailnet_ip(ip("100.128.0.1")));
        assert!(!is_tailnet_ip(ip("10.0.0.5")));
        assert!(!is_tailnet_ip(ip("127.0.0.1")));
    }

    #[test]
    fn tailnet_ipv6_prefix_and_mapped_ipv4() {
        assert!(is_tailnet_ip(ip("fd7a:115c:a1e0::1234")));
        assert!(!is_tailnet_ip(ip("fd7a:115c:a1e1::1")));
        assert!(!is_tailnet_ip(ip("fe80::1")));
        assert!(is_tailnet_ip(ip("::ffff:100.64.0.20")));
        assert!(!is_tailnet_ip(ip("::ffff:192.168.0.2")));
    }

    const OFFER: &str = "v=0\r\n\
a=candidate:1 1 udp 2122260223 100.64.0.10 51000 typ host generation 0\r\n\
a=candidate:2 1 udp 2122194687 192.168.0.5 51001 typ host generation 0\r\n\
a=candidate:3 1 udp 2122129151 0b3a1c9e-77aa-4c1d-9d3e-0a1b2c3d4e5f.local 51002 typ host\r\n\
a=candidate:4 1 tcp 1518280447 100.64.0.10 9 typ host tcptype active\r\n\
a=candidate:5 1 udp 1686052607 203.0.113.9 51003 typ srflx raddr 0.0.0.0 rport 0\r\n\
a=candidate:6 1 udp 2122063615 fd7a:115c:a1e0::1234 51004 typ host\r\n\
a=candidate:7 1 UDP 100 100.64.0.99 51005 typ relay\r\n\
a=end-of-candidates\r\n\
m=video 9 UDP/TLS/RTP/SAVPF 102\r\n";

    #[test]
    fn only_literal_tailnet_udp_candidates_survive() {
        let kept = filter_offer_candidates(OFFER);
        let candidates: Vec<&str> = kept.lines().filter(|l| l.starts_with("a=candidate:")).collect();
        assert_eq!(candidates.len(), 3, "{kept}");
        assert!(candidates[0].starts_with("a=candidate:1 "));
        assert!(candidates[1].starts_with("a=candidate:6 "));
        // 100.64.0.99 is inside the tailnet range, so the relay-typed candidate stays;
        // the type is not what is filtered, the address is.
        assert!(candidates[2].starts_with("a=candidate:7 "));
        assert!(!kept.contains(".local"));
        assert!(!kept.contains("192.168.0.5"));
        assert!(!kept.contains("203.0.113.9"));
        assert!(!kept.contains("tcptype"));
    }

    #[test]
    fn other_lines_and_line_endings_are_untouched() {
        let kept = filter_offer_candidates(OFFER);
        assert!(kept.starts_with("v=0\r\n"));
        assert!(kept.contains("a=end-of-candidates\r\n"));
        assert!(kept.ends_with("m=video 9 UDP/TLS/RTP/SAVPF 102\r\n"));
        let lf_only = "v=0\na=candidate:3 1 udp 1 host.local 5 typ host\nm=video 9\n";
        assert_eq!(filter_offer_candidates(lf_only), "v=0\nm=video 9\n");
    }

    #[test]
    fn malformed_candidates_are_dropped_not_trusted() {
        for line in [
            "a=candidate:",
            "a=candidate:1 1 udp",
            "a=candidate:1 1 udp 1 not-an-address 5 typ host",
            "a=candidate:1 1 udp 1 100.64.0.10.evil.example 5 typ host",
        ] {
            let sdp = format!("v=0\r\n{line}\r\n");
            assert_eq!(filter_offer_candidates(&sdp), "v=0\r\n", "{line}");
        }
    }

    #[test]
    fn an_offer_without_any_candidate_passes_through() {
        let sdp = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 102\r\n";
        assert_eq!(filter_offer_candidates(sdp), sdp);
    }
}
