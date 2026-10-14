//! One WebRTC peer (str0m, sans-IO) per session: sends the H.264 track, receives the
//! `input` data channel. Ported from the spike's `peer.rs`; the pacer, the click trace
//! and the shared statistics are gone, and these are new: tailnet-only candidates and
//! source addresses, bandwidth estimation, a 10 s idle close, and the release hook.
use crate::frame::{EncodedFrame, FrameTarget};
use crate::http::LogLimiter;
use crate::tailnet::{filter_offer_candidates, is_tailnet_ip};
use anyhow::{anyhow, Result};
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError};
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
    frames: SyncSender<Msg>,
    /// Set when a frame was dropped for want of room: the picture is broken until the next
    /// keyframe, so the peer thread asks the encoder for one.
    repair: Arc<AtomicBool>,
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
        PeerHandle { alive: Arc::new(AtomicBool::new(true)), frames: sync_channel(1).0, repair: Arc::default() }
    }
    /// Like `detached`, but the queue's other end is returned so a test can look into it.
    #[cfg(test)]
    fn detached_with_queue(capacity: usize) -> (PeerHandle, std::sync::mpsc::Receiver<Msg>) {
        let (frames, rx) = sync_channel(capacity);
        (PeerHandle { alive: Arc::new(AtomicBool::new(true)), frames, repair: Arc::default() }, rx)
    }
}
impl FrameTarget for PeerHandle {
    /// False when the peer is gone. A frame that finds the queue full is dropped (the peer
    /// is behind) and the peer is still there; the drop is noted so the peer thread asks for
    /// a keyframe, which is what repairs the picture. (The request is not made here: this
    /// runs on the encoder's callback thread, which must not wait on the encoder.)
    fn send_frame(&self, frame: EncodedFrame) -> bool {
        self.is_alive()
            && match self.frames.try_send(Msg::Frame(frame)) {
                Ok(()) => true,
                Err(TrySendError::Full(_)) => {
                    self.repair.store(true, Relaxed);
                    true
                }
                Err(TrySendError::Disconnected(_)) => false,
            }
    }
    fn stream_stopped(&self) {
        self.close();
    }
}

enum Msg {
    Udp(Instant, SocketAddr, Vec<u8>),
    Frame(EncodedFrame),
}

/// What the peer thread has not yet taken: datagrams and frames. The peer thread drains it
/// every few milliseconds, so this is a burst allowance, not a backlog; what does not fit is
/// dropped, which keeps a stalled peer from growing memory without bound.
const QUEUE_CAPACITY: usize = 256;

/// What the socket read thread does with one datagram: it reaches ICE only from a tailnet
/// source (this is what keeps a peer-reflexive candidate from any other address out), and
/// is dropped when the queue is full. False once the peer thread is gone.
fn forward(tx: &SyncSender<Msg>, at: Instant, source: SocketAddr, data: &[u8]) -> bool {
    if !source_allowed(source) {
        return true;
    }
    !matches!(tx.try_send(Msg::Udp(at, source, data.to_vec())), Err(TrySendError::Disconnected(_)))
}

/// True once after every frame that was dropped; the peer thread then requests a keyframe.
fn repair_due(flag: &AtomicBool) -> bool {
    flag.swap(false, Relaxed)
}

/// The idle clock moves only for a datagram str0m accepted as part of this session.
fn refreshed(last_rx: Instant, at: Instant, accepted: bool) -> Instant {
    if accepted {
        last_rx.max(at)
    } else {
        last_rx
    }
}

/// Hands one datagram to str0m, and counts it as the peer being there only when str0m
/// accepted it (a stranger on the tailnet sending noise must not keep a session open).
fn on_datagram(
    rtc: &mut Rtc,
    last_rx: &mut Instant,
    at: Instant,
    source: SocketAddr,
    local: SocketAddr,
    data: &[u8],
) -> Result<()> {
    let Ok(contents) = data.try_into() else { return Ok(()) };
    let input = Input::Receive(at, Receive { proto: Protocol::Udp, source, destination: local, contents });
    let accepted = rtc.accepts(&input);
    *last_rx = refreshed(*last_rx, at, accepted);
    if accepted {
        rtc.handle_input(input)?;
    }
    Ok(())
}

/// The offer as str0m gets to see it: only tailnet UDP candidates are ever considered (spec D2).
fn prepare_offer(offer_sdp: &str) -> Result<SdpOffer> {
    SdpOffer::from_sdp_string(&filter_offer_candidates(offer_sdp)).map_err(|e| anyhow!("bad offer: {e:?}"))
}

/// A log line from a path that can fail per packet: at most one a second, with a count of
/// what was held back.
fn limited(limiter: &mut LogLimiter, now: Instant, text: &str) -> Option<String> {
    match limiter.note(now)? {
        0 => Some(text.to_string()),
        held => Some(format!("{text} (and {held} more since the last line)")),
    }
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
    let offer = prepare_offer(offer_sdp)?;
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

    let (tx, rx) = sync_channel::<Msg>(QUEUE_CAPACITY);
    let alive = Arc::new(AtomicBool::new(true));
    {
        let socket = socket.try_clone()?;
        let tx = tx.clone();
        let alive = alive.clone();
        socket.set_read_timeout(Some(Duration::from_millis(500)))?;
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 2048];
            while alive.load(Relaxed) {
                if let Ok((n, source)) = socket.recv_from(&mut buf) {
                    if !forward(&tx, Instant::now(), source, &buf[..n]) {
                        break;
                    }
                }
            }
        });
    }
    let repair = Arc::new(AtomicBool::new(false));
    let handle = PeerHandle { alive: alive.clone(), frames: tx, repair: repair.clone() };
    let thread_alive = alive.clone();
    std::thread::spawn(move || {
        // The guard runs `closed` on every way out, a panic included, exactly once.
        let _released = ReleaseOnDrop { alive: thread_alive.clone(), hooks: hooks.clone() };
        if let Err(e) = run(rtc, socket, local, rx, &thread_alive, &repair, hooks.as_ref()) {
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
    rx: Receiver<Msg>,
    alive: &AtomicBool,
    repair: &AtomicBool,
    hooks: &dyn PeerHooks,
) -> Result<()> {
    let epoch = Instant::now();
    let mut mid: Option<Mid> = None;
    let mut payload_type = None;
    let mut connected = false;
    let mut sent_key = false;
    let mut rtx_configured = false;
    let mut last_rx = Instant::now();
    // A socket that fails does so for every packet: a line a second, not a line per packet.
    let (mut send_log, mut write_log) = (LogLimiter::default(), LogLimiter::default());
    loop {
        if repair_due(repair) {
            hooks.request_keyframe();
        }
        let timeout = loop {
            match rtc.poll_output()? {
                Output::Timeout(t) => break t,
                Output::Transmit(t) => {
                    if let Err(e) = socket.send_to(&t.contents, t.destination) {
                        if let Some(line) =
                            limited(&mut send_log, Instant::now(), &format!("[peer] send_to error: {e}"))
                        {
                            eprintln!("{line}");
                        }
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
            Ok(Msg::Udp(at, source, data)) => on_datagram(&mut rtc, &mut last_rx, at, source, local, &data)?,
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
                        Err(e) => {
                            if let Some(line) =
                                limited(&mut write_log, Instant::now(), &format!("[peer] write error: {e:?}"))
                            {
                                eprintln!("{line}");
                            }
                        }
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
        let candidates: Vec<&str> = answer.lines().filter(|l| l.starts_with("a=candidate:")).collect();
        assert_eq!(candidates.len(), 1, "the agent advertises exactly its own host candidate:\n{answer}");
        assert!(
            candidates[0].contains(" 127.0.0.1 "),
            "and it is the address the socket is bound to: {}",
            candidates[0]
        );
        handle.close();
    }

    #[test]
    fn accept_reads_the_offer_through_the_candidate_filter() {
        let lines = "a=candidate:9 1 udp 2122260223 192.168.0.5 51001 typ host\r\n\
                     a=candidate:10 1 udp 2122260223 0b3a1c9e-77aa-4c1d-9d3e-0a1b2c3d4e5f.local 51002 typ host\r\n\
                     a=candidate:11 1 udp 2122260223 100.64.0.99 51003 typ host\r\n";
        let prepared = prepare_offer(&browser_like_offer(lines)).expect("an offer").to_sdp_string();
        assert!(prepared.contains("100.64.0.99"), "the tailnet candidate stays:\n{prepared}");
        assert!(!prepared.contains("192.168.0.5"), "a LAN candidate never reaches str0m:\n{prepared}");
        assert!(!prepared.contains(".local"), "an mDNS candidate never reaches str0m:\n{prepared}");
        // With nothing but strangers the offer still parses and has no remote candidate at all.
        let only = "a=candidate:9 1 udp 2122260223 192.168.0.5 51001 typ host\r\n\
                    a=candidate:10 1 udp 2122260223 203.0.113.9 51002 typ srflx raddr 0.0.0.0 rport 0\r\n";
        let prepared = prepare_offer(&browser_like_offer(only)).expect("an offer").to_sdp_string();
        assert!(!prepared.contains("a=candidate:"), "{prepared}");
    }

    #[test]
    fn the_read_thread_forwards_only_datagrams_from_the_tailnet() {
        let (tx, rx) = sync_channel::<Msg>(8);
        let now = Instant::now();
        assert!(forward(&tx, now, "192.168.0.5:51001".parse().unwrap(), b"x"), "dropping is not a failure");
        assert!(forward(&tx, now, "[fe80::1]:5".parse().unwrap(), b"x"));
        assert!(rx.try_recv().is_err(), "nothing from outside the tailnet reaches ICE");
        assert!(forward(&tx, now, "100.64.0.99:51000".parse().unwrap(), b"hello"));
        match rx.try_recv() {
            Ok(Msg::Udp(_, source, data)) => {
                assert_eq!(source, "100.64.0.99:51000".parse::<SocketAddr>().unwrap());
                assert_eq!(data, b"hello");
            }
            _ => panic!("the tailnet datagram was not forwarded"),
        }
        drop(rx);
        assert!(!forward(&tx, now, "100.64.0.99:51000".parse().unwrap(), b"x"), "the peer is gone: stop reading");
    }

    #[test]
    fn a_full_queue_drops_datagrams_and_frames_instead_of_blocking_or_growing() {
        let (tx, rx) = sync_channel::<Msg>(2);
        let now = Instant::now();
        let source: SocketAddr = "100.64.0.99:51000".parse().unwrap();
        for _ in 0..5 {
            assert!(forward(&tx, now, source, b"x"), "a full queue is not a failure");
        }
        assert_eq!(rx.try_iter().count(), 2);
        let (handle, rx) = PeerHandle::detached_with_queue(3);
        for _ in 0..10 {
            let frame = EncodedFrame { data: vec![0], key: false, submitted: now };
            assert!(handle.send_frame(frame), "a frame dropped for want of room is not a dead peer");
        }
        assert_eq!(rx.try_iter().count(), 3, "the queue is bounded");
        // A dropped frame breaks the picture until a keyframe: the peer thread is told, once.
        assert!(repair_due(&handle.repair), "a dropped frame must lead to a keyframe request");
        assert!(!repair_due(&handle.repair), "one request per drop, not one per loop");
        let (quiet, _rx) = PeerHandle::detached_with_queue(3);
        assert!(quiet.send_frame(EncodedFrame { data: vec![0], key: true, submitted: now }));
        assert!(!repair_due(&quiet.repair), "nothing was dropped, nothing to repair");
    }

    #[test]
    fn only_a_datagram_str0m_accepted_counts_as_the_peer_being_there() {
        let t0 = Instant::now();
        let later = t0 + Duration::from_secs(4);
        assert_eq!(refreshed(t0, later, true), later);
        assert_eq!(refreshed(t0, later, false), t0, "a stranger's packets must not keep a session alive");
        assert_eq!(refreshed(later, t0, true), later, "the clock never goes backwards");
        // The same through a real Rtc: junk from a tailnet address is not accepted.
        let mut rtc = RtcConfig::new().build(Instant::now());
        let mut last_rx = t0;
        let local: SocketAddr = "127.0.0.1:40000".parse().unwrap();
        let source: SocketAddr = "100.64.0.99:51000".parse().unwrap();
        on_datagram(&mut rtc, &mut last_rx, later, source, local, &[0x17; 40]).unwrap();
        assert_eq!(last_rx, t0, "junk is not the peer");
    }

    #[test]
    fn a_failing_socket_logs_a_line_a_second_not_one_per_packet() {
        let t0 = Instant::now();
        let mut limiter = LogLimiter::default();
        assert_eq!(limited(&mut limiter, t0, "[peer] send_to error: x").as_deref(), Some("[peer] send_to error: x"));
        for i in 1..=50 {
            assert_eq!(limited(&mut limiter, t0 + Duration::from_millis(i), "[peer] send_to error: x"), None);
        }
        assert_eq!(
            limited(&mut limiter, t0 + Duration::from_secs(2), "[peer] send_to error: x").as_deref(),
            Some("[peer] send_to error: x (and 50 more since the last line)")
        );
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
