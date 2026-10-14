//! One WebRTC peer (str0m, sans-IO) per session: sends the H.264 track, receives the
//! `input` data channel. Ported from the spike's `peer.rs`; the pacer, the click trace
//! and the shared statistics are gone, and these are new: tailnet-only candidates and
//! source addresses, bandwidth estimation, a 10 s idle close, and the release hook.
use crate::frame::{EncodedFrame, FrameTarget};
use crate::tailnet::{filter_offer_candidates, is_tailnet_ip};
use anyhow::{anyhow, Result};
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};
use str0m::bwe::{Bitrate, BweKind};
use str0m::change::SdpOffer;
use str0m::media::{Frequency, MediaTime, Mid};
use str0m::net::{Protocol, Receive};
use str0m::rtp::AbsCaptureTime;
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc, RtcConfig};

/// Nothing received from the peer for this long closes the session (spec D5).
pub const IDLE_LIMIT: Duration = Duration::from_secs(10);
/// UDP send/receive buffers. The macOS defaults (9 KiB / 768 KiB) lost packets at 4K.
pub const SOCKET_BUFFER: usize = 4 << 20;
/// RTX history in packets (the spike's value).
pub const RTX_PACKETS: usize = 4000;

/// Whether a received datagram may reach ICE. A browser that hides its host candidates
/// behind mDNS names is found by its first connectivity check, which ICE records as a
/// peer-reflexive candidate: that one is welcome when it comes from a tailnet address
/// and from nowhere else (spec D2).
pub fn source_allowed(source: SocketAddr) -> bool {
    is_tailnet_ip(source.ip())
}

pub fn idle_expired(last_rx: Instant, now: Instant) -> bool {
    now.saturating_duration_since(last_rx) > IDLE_LIMIT
}

/// The session's side of the peer. Called from the peer thread.
pub trait PeerHooks: Send + Sync + 'static {
    /// A new viewer or a PLI/FIR: the next encoded frame should be a keyframe.
    fn request_keyframe(&self);
    /// The sender-side bandwidth estimate in bits per second.
    fn estimate(&self, bps: u64);
    /// One data channel message from the page.
    fn input(&self, data: &[u8]);
    /// The `input` data channel closed while the peer lives on: whatever the page still
    /// held down must be released (spec D4).
    fn input_closed(&self) {}
    /// The peer thread ended for any reason (input must release everything held).
    fn closed(&self);
}

#[derive(Clone)]
pub struct PeerParams {
    pub bind_ip: IpAddr,
    /// The estimator's starting point and the ceiling it probes towards.
    pub initial_bitrate: u32,
    pub desired_bitrate: u32,
}

#[derive(Clone)]
pub struct PeerHandle {
    alive: Arc<AtomicBool>,
    frames: Sender<Msg>,
}
impl PeerHandle {
    pub fn is_alive(&self) -> bool {
        self.alive.load(Relaxed)
    }
    pub fn close(&self) {
        self.alive.store(false, Relaxed);
    }
    /// A handle with no peer behind it, for tests of whatever holds handles.
    #[cfg(test)]
    pub fn detached() -> PeerHandle {
        PeerHandle { alive: Arc::new(AtomicBool::new(true)), frames: channel().0 }
    }
}
impl FrameTarget for PeerHandle {
    /// False when the peer is gone.
    fn send_frame(&self, frame: EncodedFrame) -> bool {
        self.is_alive() && self.frames.send(Msg::Frame(frame)).is_ok()
    }
    fn stream_stopped(&self) {
        self.close();
    }
}

enum Msg {
    Udp(Instant, SocketAddr, Vec<u8>),
    Frame(EncodedFrame),
}

fn set_socket_buffers(socket: &UdpSocket, bytes: usize) {
    use std::os::fd::AsRawFd;
    let value = bytes as i32;
    for option in [libc::SO_SNDBUF, libc::SO_RCVBUF] {
        // SAFETY: a valid socket descriptor and a pointer to a live i32 of the stated size.
        let rc = unsafe {
            libc::setsockopt(
                socket.as_raw_fd(),
                libc::SOL_SOCKET,
                option,
                &value as *const i32 as *const _,
                std::mem::size_of::<i32>() as libc::socklen_t,
            )
        };
        if rc != 0 {
            eprintln!("[peer] setsockopt({option}) failed: {}", std::io::Error::last_os_error());
        }
    }
}

/// Handles an SDP offer: returns the answer and a handle to feed frames and close the peer.
pub fn accept(offer_sdp: &str, params: PeerParams, hooks: Arc<dyn PeerHooks>) -> Result<(String, PeerHandle)> {
    // Only tailnet UDP candidates are ever considered (spec D2).
    let offer =
        SdpOffer::from_sdp_string(&filter_offer_candidates(offer_sdp)).map_err(|e| anyhow!("bad offer: {e:?}"))?;
    let mut rtc = RtcConfig::new()
        .clear_codecs()
        .enable_h264(true)
        .set_send_buffer_video(RTX_PACKETS)
        .enable_bwe(Some(Bitrate::bps(params.initial_bitrate as u64)))
        .set_stats_interval(Some(Duration::from_secs(1)))
        .build(Instant::now());
    rtc.bwe().set_desired_bitrate(Bitrate::bps(params.desired_bitrate as u64));

    // The media socket is bound to the tailnet address, which is also the only host candidate.
    let socket = UdpSocket::bind(SocketAddr::new(params.bind_ip, 0))?;
    let local = socket.local_addr()?;
    set_socket_buffers(&socket, SOCKET_BUFFER);
    rtc.add_local_candidate(Candidate::host(local, "udp").map_err(|e| anyhow!("candidate: {e:?}"))?);
    let answer = rtc.sdp_api().accept_offer(offer).map_err(|e| anyhow!("accept_offer: {e:?}"))?;
    let answer_sdp = answer.to_sdp_string();

    let (tx, rx) = channel::<Msg>();
    let alive = Arc::new(AtomicBool::new(true));
    {
        let socket = socket.try_clone()?;
        let tx = tx.clone();
        let alive = alive.clone();
        socket.set_read_timeout(Some(Duration::from_millis(500)))?;
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 2048];
            while alive.load(Relaxed) {
                match socket.recv_from(&mut buf) {
                    // A datagram from outside the tailnet never reaches ICE: this is what
                    // keeps a peer-reflexive candidate from any other address out.
                    Ok((n, source)) if source_allowed(source) => {
                        if tx.send(Msg::Udp(Instant::now(), source, buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                    _ => continue,
                }
            }
        });
    }
    let handle = PeerHandle { alive: alive.clone(), frames: tx };
    let thread_alive = alive.clone();
    std::thread::spawn(move || {
        // The guard runs `closed` on every way out, a panic included, exactly once.
        let _released = ReleaseOnDrop { alive: thread_alive.clone(), hooks: hooks.clone() };
        if let Err(e) = run(rtc, socket, local, rx, &thread_alive, hooks.as_ref()) {
            eprintln!("[peer] ended with error: {e:?}");
        }
    });
    Ok((answer_sdp, handle))
}

struct ReleaseOnDrop {
    alive: Arc<AtomicBool>,
    hooks: Arc<dyn PeerHooks>,
}
impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        self.alive.store(false, Relaxed);
        self.hooks.closed();
        println!("[peer] closed");
    }
}

fn run(
    mut rtc: Rtc,
    socket: UdpSocket,
    local: SocketAddr,
    rx: std::sync::mpsc::Receiver<Msg>,
    alive: &AtomicBool,
    hooks: &dyn PeerHooks,
) -> Result<()> {
    let epoch = Instant::now();
    let mut mid: Option<Mid> = None;
    let mut payload_type = None;
    let mut connected = false;
    let mut sent_key = false;
    let mut rtx_configured = false;
    let mut last_rx = Instant::now();
    loop {
        let timeout = loop {
            match rtc.poll_output()? {
                Output::Timeout(t) => break t,
                Output::Transmit(t) => {
                    if let Err(e) = socket.send_to(&t.contents, t.destination) {
                        eprintln!("[peer] send_to error: {e}");
                    }
                }
                Output::Event(event) => match event {
                    Event::IceConnectionStateChange(IceConnectionState::Disconnected) => return Ok(()),
                    Event::Connected => {
                        println!("[peer] connected");
                        connected = true;
                        hooks.request_keyframe();
                    }
                    Event::MediaAdded(m) => {
                        mid = Some(m.mid);
                        if !rtx_configured {
                            if let Some(stream) = rtc.direct_api().stream_tx_by_mid(m.mid, None) {
                                // RTX with a 3 s history; without it a lost packet waits for a PLI (about 1 s).
                                stream.set_rtx_cache(RTX_PACKETS, Duration::from_secs(3), Some(0.15f32));
                                rtx_configured = true;
                            }
                        }
                    }
                    Event::KeyframeRequest(_) => hooks.request_keyframe(),
                    Event::EgressBitrateEstimate(BweKind::Twcc { estimate, .. }) => {
                        hooks.estimate(estimate.as_u64());
                    }
                    Event::ChannelData(data) => hooks.input(&data.data),
                    Event::ChannelClose(_) => hooks.input_closed(),
                    Event::Closed => return Ok(()),
                    _ => {}
                },
            }
        };
        if !rtc.is_alive() || !alive.load(Relaxed) {
            return Ok(());
        }
        if idle_expired(last_rx, Instant::now()) {
            println!("[peer] idle for {IDLE_LIMIT:?}, closing");
            return Ok(());
        }
        let wait = timeout.saturating_duration_since(Instant::now()).min(Duration::from_millis(200));
        match rx.recv_timeout(wait) {
            Ok(Msg::Udp(at, source, data)) => {
                last_rx = at;
                let Ok(contents) = data.as_slice().try_into() else { continue };
                rtc.handle_input(Input::Receive(
                    at,
                    Receive { proto: Protocol::Udp, source, destination: local, contents },
                ))?;
            }
            Ok(Msg::Frame(frame)) => {
                let Some(m) = mid else { continue };
                if !connected || (!sent_key && !frame.key) {
                    continue;
                }
                if payload_type.is_none() {
                    payload_type = rtc.writer(m).and_then(|w| w.payload_params().next().map(|p| p.pt()));
                }
                let Some(pt) = payload_type else { continue };
                let rtp = (frame.submitted.duration_since(epoch).as_micros() as u64) * 90 / 1000;
                let key = frame.key;
                if let Some(writer) = rtc.writer(m) {
                    let capture = std::time::SystemTime::now() - frame.submitted.elapsed();
                    let writer = writer
                        .playout_delay(MediaTime::ZERO, MediaTime::ZERO)
                        .abs_capture_time(AbsCaptureTime { capture_time: capture, clock_offset: None });
                    match writer.write(pt, Instant::now(), MediaTime::new(rtp, Frequency::NINETY_KHZ), frame.data) {
                        Ok(_) => sent_key |= key,
                        Err(e) => eprintln!("[peer] write error: {e:?}"),
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => rtc.handle_input(Input::Timeout(Instant::now()))?,
            Err(RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_expires_only_after_ten_seconds() {
        let t0 = Instant::now();
        assert!(!idle_expired(t0, t0 + Duration::from_secs(10)));
        assert!(idle_expired(t0, t0 + Duration::from_secs(10) + Duration::from_millis(1)));
        assert!(!idle_expired(t0 + Duration::from_secs(5), t0), "a clock that went backwards is not idle");
    }

    #[test]
    fn a_stream_the_system_stopped_closes_the_peer() {
        let handle = PeerHandle::detached();
        assert!(handle.is_alive());
        FrameTarget::stream_stopped(&handle);
        assert!(!handle.is_alive(), "the session must end so the page shows its ended card");
    }

    struct Quiet;
    impl PeerHooks for Quiet {
        fn request_keyframe(&self) {}
        fn estimate(&self, _bps: u64) {}
        fn input(&self, _data: &[u8]) {}
        fn closed(&self) {}
    }

    /// An offer like a browser's: a receive-only H.264 video, built by a second str0m.
    fn browser_like_offer(extra_candidate_lines: &str) -> String {
        use str0m::media::{Direction, MediaKind};
        let mut client = RtcConfig::new().clear_codecs().enable_h264(true).build(Instant::now());
        let mut api = client.sdp_api();
        api.add_media(MediaKind::Video, Direction::RecvOnly, None, None, None);
        let (offer, _pending) = api.apply().expect("an offer");
        let mut sdp = offer.to_sdp_string();
        sdp.push_str(extra_candidate_lines);
        sdp
    }

    #[test]
    fn the_answer_offers_h264_with_rtx_and_the_congestion_feedback_the_estimator_needs() {
        let params = PeerParams {
            bind_ip: "127.0.0.1".parse().unwrap(),
            initial_bitrate: 6_000_000,
            desired_bitrate: 12_000_000,
        };
        let (answer, handle) = accept(&browser_like_offer(""), params, Arc::new(Quiet)).expect("an answer");
        assert!(answer.contains("H264/90000"), "{answer}");
        assert!(answer.contains("rtx/90000"), "without RTX a lost packet freezes the picture for a second:\n{answer}");
        assert!(answer.contains("transport-cc"), "bandwidth estimation needs transport-wide feedback:\n{answer}");
        assert!(answer.contains("a=candidate:"), "the agent advertises its own host candidate");
        assert!(answer.contains("127.0.0.1"), "and it is the address the socket is bound to");
        handle.close();
    }

    #[test]
    fn a_stranger_candidate_in_the_offer_does_not_make_the_offer_unusable() {
        // The filter removes these lines before str0m sees them (tailnet.rs tests the filter itself).
        let lines = "a=candidate:9 1 udp 2122260223 192.168.0.5 51001 typ host\r\n\
                     a=candidate:10 1 udp 2122260223 0b3a1c9e-77aa-4c1d-9d3e-0a1b2c3d4e5f.local 51002 typ host\r\n";
        let params = PeerParams {
            bind_ip: "127.0.0.1".parse().unwrap(),
            initial_bitrate: 6_000_000,
            desired_bitrate: 12_000_000,
        };
        let (answer, handle) = accept(&browser_like_offer(lines), params, Arc::new(Quiet)).expect("an answer");
        assert!(answer.contains("H264/90000"));
        handle.close();
    }

    #[test]
    fn garbage_instead_of_an_offer_is_an_error_not_a_panic() {
        let params = PeerParams {
            bind_ip: "127.0.0.1".parse().unwrap(),
            initial_bitrate: 6_000_000,
            desired_bitrate: 12_000_000,
        };
        for bad in ["", "hello", "v=0\r\n", "v=0\r\nm=video"] {
            assert!(accept(bad, params.clone(), Arc::new(Quiet)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_peer_reflexive_source_is_accepted_from_the_tailnet_and_refused_from_anywhere_else() {
        // A browser behind an mDNS name is first seen as the source of a connectivity check.
        for ok in ["100.64.0.99:51000", "100.127.255.254:9", "[fd7a:115c:a1e0::1234]:51000"] {
            assert!(source_allowed(ok.parse().unwrap()), "{ok}");
        }
        for bad in ["192.168.0.5:51001", "203.0.113.9:51003", "127.0.0.1:1", "100.128.0.1:5", "[fe80::1]:5"] {
            assert!(!source_allowed(bad.parse().unwrap()), "{bad}");
        }
    }

    #[test]
    fn prflx_candidate_lines_follow_the_same_rule_and_never_break_accept() {
        let lines = "a=candidate:11 1 udp 1686052607 100.64.0.99 51010 typ prflx raddr 0.0.0.0 rport 0\r\n\
                     a=candidate:12 1 udp 1686052607 203.0.113.9 51011 typ prflx raddr 0.0.0.0 rport 0\r\n";
        let offer = browser_like_offer(lines);
        let kept = filter_offer_candidates(&offer);
        assert!(kept.contains("100.64.0.99 51010 typ prflx"), "a tailnet prflx candidate stays");
        assert!(!kept.contains("203.0.113.9"), "any other prflx candidate goes");
        let params = PeerParams {
            bind_ip: "127.0.0.1".parse().unwrap(),
            initial_bitrate: 6_000_000,
            desired_bitrate: 12_000_000,
        };
        let (_answer, handle) = accept(&offer, params, Arc::new(Quiet)).expect("an answer");
        handle.close();
    }

    #[test]
    fn closed_runs_exactly_once_after_close() {
        use std::sync::atomic::AtomicUsize;
        struct Counting(Arc<AtomicUsize>);
        impl PeerHooks for Counting {
            fn request_keyframe(&self) {}
            fn estimate(&self, _bps: u64) {}
            fn input(&self, _data: &[u8]) {}
            fn closed(&self) {
                self.0.fetch_add(1, Relaxed);
            }
        }
        let count = Arc::new(AtomicUsize::new(0));
        let params = PeerParams {
            bind_ip: "127.0.0.1".parse().unwrap(),
            initial_bitrate: 6_000_000,
            desired_bitrate: 12_000_000,
        };
        let (_answer, handle) = accept(&browser_like_offer(""), params, Arc::new(Counting(count.clone()))).unwrap();
        handle.close();
        let deadline = Instant::now() + Duration::from_secs(3);
        while count.load(Relaxed) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(count.load(Relaxed), 1);
        assert!(!handle.is_alive());
    }
}
