//! One WebRTC peer (str0m, sans-IO) per session: sends the H.264 track, receives the
//! `input` data channel. Ported from the spike's `peer.rs`; the pacer, the click trace
//! and the shared statistics are gone, and these are new: tailnet-only candidates and
//! source addresses, bandwidth estimation, a 10 s idle close, and the release hook.
use crate::bitrate::estimator_restart;
use crate::frame::{EncodedFrame, FrameTarget};
use crate::http::LogLimiter;
use crate::protocol::NOTICE_REPLACED;
use crate::silence::{Silence, RELEASE_AFTER};
use crate::tailnet::{filter_offer_candidates, is_tailnet_ip};
use anyhow::{anyhow, Result};
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::atomic::{
    AtomicBool,
    Ordering::{Acquire, Relaxed, Release},
};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::Arc;
use std::time::{Duration, Instant};
use str0m::bwe::{Bitrate, BweKind};
use str0m::change::SdpOffer;
use str0m::channel::ChannelId;
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

/// The limit is a parameter so a test can use a short one; the peer thread passes `IDLE_LIMIT`.
pub fn idle_expired(limit: Duration, last_rx: Instant, now: Instant) -> bool {
    now.saturating_duration_since(last_rx) > limit
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
    /// Nothing at all has arrived from the page for `RELEASE_AFTER`: whatever it held down
    /// is released, the session stays (the idle close decides whether it ends).
    fn silent(&self) {}
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
    /// Set (before `alive` is cleared) when a newer session took this one's place: the
    /// peer thread then tells the page before it goes (`NOTICE_REPLACED`).
    replaced: Arc<AtomicBool>,
}
impl PeerHandle {
    pub fn is_alive(&self) -> bool {
        self.alive.load(Relaxed)
    }
    pub fn close(&self) {
        self.alive.store(false, Relaxed);
    }
    /// Closes the peer because another session took over: the page is told, so it does not
    /// have to wait for its connection check to fail.
    pub fn close_replaced(&self) {
        self.replaced.store(true, Release);
        self.alive.store(false, Release);
    }
    /// Whether the peer was closed by a take-over.
    #[cfg(test)]
    pub(crate) fn is_replaced(&self) -> bool {
        self.replaced.load(Relaxed)
    }
    /// A handle with no peer behind it, for tests of whatever holds handles.
    #[cfg(test)]
    pub fn detached() -> PeerHandle {
        PeerHandle {
            alive: Arc::new(AtomicBool::new(true)),
            frames: sync_channel(1).0,
            repair: Arc::default(),
            replaced: Arc::default(),
        }
    }
    /// Like `detached`, but the queue's other end is returned so a test can look into it.
    #[cfg(test)]
    fn detached_with_queue(capacity: usize) -> (PeerHandle, std::sync::mpsc::Receiver<Msg>) {
        let (frames, rx) = sync_channel(capacity);
        (
            PeerHandle {
                alive: Arc::new(AtomicBool::new(true)),
                frames,
                repair: Arc::default(),
                replaced: Arc::default(),
            },
            rx,
        )
    }
    /// A handle whose frame queue a test (of whatever holds handles) can look into.
    #[cfg(test)]
    pub(crate) fn observed(capacity: usize) -> (PeerHandle, QueueProbe) {
        let (handle, rx) = PeerHandle::detached_with_queue(capacity);
        (handle, QueueProbe(rx))
    }
}

/// What a test sees of the frames that reached one peer's queue.
#[cfg(test)]
pub(crate) struct QueueProbe(Receiver<Msg>);
#[cfg(test)]
impl QueueProbe {
    /// The payload of every frame that arrived since the last call.
    pub(crate) fn frames(&self) -> Vec<Vec<u8>> {
        self.0
            .try_iter()
            .filter_map(|m| match m {
                Msg::Frame(frame) => Some(frame.data),
                Msg::Udp(..) => None,
            })
            .collect()
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

/// The agent's side of a connection before any negotiation: H.264 only, RTX history, and
/// the bandwidth estimator started and capped as the session asks.
fn new_rtc(params: &PeerParams) -> Rtc {
    let mut rtc = RtcConfig::new()
        .clear_codecs()
        .enable_h264(true)
        .set_send_buffer_video(RTX_PACKETS)
        .enable_bwe(Some(Bitrate::bps(params.initial_bitrate as u64)))
        .set_stats_interval(Some(Duration::from_secs(1)))
        .build(Instant::now());
    rtc.bwe().set_desired_bitrate(Bitrate::bps(params.desired_bitrate as u64));
    rtc
}

/// Handles an SDP offer: returns the answer and a handle to feed frames and close the peer.
pub fn accept(offer_sdp: &str, params: PeerParams, hooks: Arc<dyn PeerHooks>) -> Result<(String, PeerHandle)> {
    let offer = prepare_offer(offer_sdp)?;
    let mut rtc = new_rtc(&params);

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
    let replaced = Arc::new(AtomicBool::new(false));
    let handle = PeerHandle { alive: alive.clone(), frames: tx, repair: repair.clone(), replaced: replaced.clone() };
    let thread_alive = alive.clone();
    let thread_replaced = replaced;
    std::thread::spawn(move || {
        // The guard runs `closed` on every way out, a panic included, exactly once.
        let _released = ReleaseOnDrop { alive: thread_alive.clone(), hooks: hooks.clone() };
        let signals = Signals::production(&thread_alive, &repair, &thread_replaced);
        if let Err(e) = run(rtc, socket, local, rx, signals, hooks.as_ref()) {
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

/// What the peer thread watches besides its queue.
#[derive(Clone, Copy)]
struct Signals<'a> {
    /// Cleared to end the peer.
    alive: &'a AtomicBool,
    /// Set when a frame was dropped (see `PeerHandle::repair`).
    repair: &'a AtomicBool,
    /// Set when the peer was closed by a take-over (see `PeerHandle::replaced`).
    replaced: &'a AtomicBool,
    /// How long without an accepted datagram ends the session (`IDLE_LIMIT`).
    idle_limit: Duration,
    /// How long without an accepted datagram releases what the page held (`RELEASE_AFTER`).
    release_after: Duration,
}

impl<'a> Signals<'a> {
    /// The limits a real session runs with.
    fn production(alive: &'a AtomicBool, repair: &'a AtomicBool, replaced: &'a AtomicBool) -> Self {
        Signals { alive, repair, replaced, idle_limit: IDLE_LIMIT, release_after: RELEASE_AFTER }
    }
}

/// The one thing `handle_estimate` asks of the session's bandwidth estimator, so a test can see
/// that it was asked. str0m's `reset` keeps the desired bitrate set at the start (`Bwe` holds it
/// outside the estimator state that is replaced), so a restart needs nothing else.
trait Estimator {
    /// Discard the estimator state and start estimating again from `bps`.
    fn restart(&mut self, bps: u32);
}

impl Estimator for Rtc {
    fn restart(&mut self, bps: u32) {
        self.bwe().reset(Bitrate::bps(bps as u64));
    }
}

/// A new sender-side estimate: it steers the encoder, and one under the encoder's floor is
/// not believed (see `estimator_restart`): str0m's estimator starts over at the floor.
fn handle_estimate(estimator: &mut impl Estimator, hooks: &dyn PeerHooks, restart_log: &mut LogLimiter, bps: u64) {
    hooks.estimate(bps);
    if let Some(restart) = estimator_restart(bps) {
        estimator.restart(restart);
        let note = format!("[peer] bandwidth estimate {bps} bps restarted at {restart}");
        if let Some(line) = limited(restart_log, Instant::now(), &note) {
            println!("{line}");
        }
    }
}

/// Tells the page that another device took the session over, puts that on the wire, and
/// shuts the connection down. (str0m's `disconnect` is silent: the notice is the page's only
/// signal, and the page ends at once on receiving it.)
fn dismiss(rtc: &mut Rtc, channel: Option<ChannelId>, socket: &UdpSocket) {
    if let Some(mut channel) = channel.and_then(|id| rtc.channel(id)) {
        let _ = channel.write(false, NOTICE_REPLACED.as_bytes());
    }
    // A few rounds: the first moves the message into SCTP, the next puts it on the wire.
    for _ in 0..3 {
        loop {
            match rtc.poll_output() {
                Ok(Output::Transmit(t)) => {
                    let _ = socket.send_to(&t.contents, t.destination);
                }
                Ok(Output::Event(_)) => {}
                Ok(Output::Timeout(_)) | Err(_) => break,
            }
        }
        if rtc.handle_input(Input::Timeout(Instant::now())).is_err() {
            break;
        }
    }
    rtc.disconnect();
}

fn run(
    mut rtc: Rtc,
    socket: UdpSocket,
    local: SocketAddr,
    rx: Receiver<Msg>,
    signals: Signals<'_>,
    hooks: &dyn PeerHooks,
) -> Result<()> {
    let Signals { alive, repair, replaced, idle_limit, release_after } = signals;
    let epoch = Instant::now();
    let mut mid: Option<Mid> = None;
    let mut payload_type = None;
    let mut connected = false;
    let mut sent_key = false;
    let mut rtx_configured = false;
    let mut last_rx = Instant::now();
    let mut channel: Option<ChannelId> = None;
    let mut silence = Silence::default();
    // A socket that fails does so for every packet: a line a second, not a line per packet.
    let (mut send_log, mut write_log, mut restart_log) =
        (LogLimiter::default(), LogLimiter::default(), LogLimiter::default());
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
                        handle_estimate(&mut rtc, hooks, &mut restart_log, estimate.as_u64());
                    }
                    Event::ChannelOpen(id, _) => channel = Some(id),
                    Event::ChannelData(data) => hooks.input(&data.data),
                    Event::ChannelClose(_) => hooks.input_closed(),
                    Event::Closed => return Ok(()),
                    _ => {}
                },
            }
        };
        if !rtc.is_alive() {
            return Ok(());
        }
        if !alive.load(Acquire) {
            if replaced.load(Acquire) {
                dismiss(&mut rtc, channel, &socket);
            }
            return Ok(());
        }
        if idle_expired(idle_limit, last_rx, Instant::now()) {
            println!("[peer] idle for {idle_limit:?}, closing");
            return Ok(());
        }
        if silence.release_due(release_after, last_rx, Instant::now()) {
            println!("[peer] nothing from the page for {release_after:?}, releasing its keys");
            hooks.silent();
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
        assert!(!idle_expired(IDLE_LIMIT, t0, t0 + Duration::from_secs(10)));
        assert!(idle_expired(IDLE_LIMIT, t0, t0 + Duration::from_secs(10) + Duration::from_millis(1)));
        assert!(!idle_expired(IDLE_LIMIT, t0 + Duration::from_secs(5), t0), "a clock that went backwards is not idle");
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

    // ---- a whole session against a second str0m playing the browser ----

    use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
    use std::sync::Mutex;
    use str0m::channel::ChannelId;
    use str0m::media::{Direction, KeyframeRequestKind, MediaKind};

    /// What the peer thread told its session.
    #[derive(Default)]
    struct Recorder {
        keyframes: AtomicUsize,
        estimates: Mutex<Vec<u64>>,
        inputs: Mutex<Vec<Vec<u8>>>,
        input_closed: AtomicUsize,
        silent: AtomicUsize,
        closed: AtomicUsize,
    }
    impl PeerHooks for Recorder {
        fn request_keyframe(&self) {
            self.keyframes.fetch_add(1, SeqCst);
        }
        fn estimate(&self, bps: u64) {
            self.estimates.lock().unwrap().push(bps);
        }
        fn input(&self, data: &[u8]) {
            self.inputs.lock().unwrap().push(data.to_vec());
        }
        fn input_closed(&self) {
            self.input_closed.fetch_add(1, SeqCst);
        }
        fn silent(&self) {
            self.silent.fetch_add(1, SeqCst);
        }
        fn closed(&self) {
            self.closed.fetch_add(1, SeqCst);
        }
    }

    /// The browser's side: a str0m of its own on a real loopback socket.
    struct Browser {
        rtc: Rtc,
        socket: UdpSocket,
        addr: SocketAddr,
        channel: ChannelId,
        mid: Mid,
        connected: bool,
        channel_open: bool,
        pictures: usize,
        /// Every message the agent sent over the data channel, as text.
        notices: Vec<String>,
        /// Whether each of them arrived as a binary frame (`ChannelData::binary`); the page reads text only.
        notice_binary: Vec<bool>,
    }

    /// The agent's peer thread (`run`, exactly as production runs it, with a short idle limit)
    /// and the browser, joined by two loopback sockets that the test pumps by hand.
    struct Call {
        browser: Browser,
        /// The agent's socket as the test reads it (the peer thread only sends on its own copy).
        agent_socket: UdpSocket,
        queue: SyncSender<Msg>,
        hooks: Arc<Recorder>,
        alive: Arc<AtomicBool>,
        /// The handle the session holds, to close the peer the way a take-over does.
        handle: PeerHandle,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Call {
        fn start(idle_limit: Duration) -> Call {
            Call::start_with(idle_limit, RELEASE_AFTER)
        }

        fn start_with(idle_limit: Duration, release_after: Duration) -> Call {
            let params = PeerParams {
                bind_ip: "127.0.0.1".parse().unwrap(),
                initial_bitrate: 6_000_000,
                desired_bitrate: 12_000_000,
            };
            let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
            socket.set_nonblocking(true).unwrap();
            let addr = socket.local_addr().unwrap();
            let mut rtc = RtcConfig::new().clear_codecs().enable_h264(true).build(Instant::now());
            rtc.add_local_candidate(Candidate::host(addr, "udp").unwrap());
            let mut api = rtc.sdp_api();
            let mid = api.add_media(MediaKind::Video, Direction::RecvOnly, None, None, None);
            let channel = api.add_channel("input".to_string());
            let (offer, pending) = api.apply().expect("an offer");

            let mut agent = new_rtc(&params);
            let agent_socket = UdpSocket::bind("127.0.0.1:0").unwrap();
            let local = agent_socket.local_addr().unwrap();
            agent.add_local_candidate(Candidate::host(local, "udp").unwrap());
            let answer = agent.sdp_api().accept_offer(offer).expect("an answer");
            rtc.sdp_api().accept_answer(pending, answer).expect("the answer is accepted");

            let (queue, rx) = sync_channel::<Msg>(QUEUE_CAPACITY);
            let (alive, repair) = (Arc::new(AtomicBool::new(true)), Arc::new(AtomicBool::new(false)));
            let replaced = Arc::new(AtomicBool::new(false));
            let handle = PeerHandle {
                alive: alive.clone(),
                frames: queue.clone(),
                repair: repair.clone(),
                replaced: replaced.clone(),
            };
            let hooks = Arc::new(Recorder::default());
            let sender = agent_socket.try_clone().unwrap();
            agent_socket.set_read_timeout(Some(Duration::from_millis(2))).unwrap();
            let thread = {
                let (alive, repair, hooks) = (alive.clone(), repair.clone(), hooks.clone());
                std::thread::spawn(move || {
                    let signals =
                        Signals { alive: &alive, repair: &repair, replaced: &replaced, idle_limit, release_after };
                    let result = run(agent, sender, local, rx, signals, hooks.as_ref());
                    if let Err(e) = result {
                        eprintln!("[test peer] ended with error: {e:?}");
                    }
                    hooks.closed();
                })
            };
            let browser = Browser {
                rtc,
                socket,
                addr,
                channel,
                mid,
                connected: false,
                channel_open: false,
                pictures: 0,
                notices: Vec::new(),
                notice_binary: Vec::new(),
            };
            Call { browser, agent_socket, queue, hooks, alive, handle, thread: Some(thread) }
        }

        /// One round: the browser's output and timers, then every datagram either side has waiting.
        fn step(&mut self) {
            let b = &mut self.browser;
            loop {
                match b.rtc.poll_output().expect("the browser's str0m") {
                    Output::Timeout(_) => break,
                    Output::Transmit(t) => {
                        let _ = b.socket.send_to(&t.contents, t.destination);
                    }
                    Output::Event(Event::Connected) => b.connected = true,
                    Output::Event(Event::ChannelOpen(..)) => b.channel_open = true,
                    Output::Event(Event::MediaData(_)) => b.pictures += 1,
                    Output::Event(Event::ChannelData(data)) => {
                        b.notices.push(String::from_utf8_lossy(&data.data).into_owned());
                        b.notice_binary.push(data.binary);
                    }
                    Output::Event(_) => {}
                }
            }
            let mut buf = vec![0u8; 2048];
            while let Ok((n, source)) = b.socket.recv_from(&mut buf) {
                let contents = buf[..n].try_into().unwrap();
                let input = Input::Receive(
                    Instant::now(),
                    Receive { proto: Protocol::Udp, source, destination: b.addr, contents },
                );
                b.rtc.handle_input(input).unwrap();
            }
            b.rtc.handle_input(Input::Timeout(Instant::now())).unwrap();
            // The datagrams reach the peer thread as the read thread would hand them over, apart
            // from the tailnet source check, which has its own tests (`forward`).
            while let Ok((n, source)) = self.agent_socket.recv_from(&mut buf) {
                let _ = self.queue.try_send(Msg::Udp(Instant::now(), source, buf[..n].to_vec()));
            }
        }

        /// Pumps until `done` or the time is up; says which.
        fn until(&mut self, within: Duration, mut done: impl FnMut(&Call) -> bool) -> bool {
            let deadline = Instant::now() + within;
            while Instant::now() < deadline {
                self.step();
                if done(self) {
                    return true;
                }
            }
            false
        }

        fn connect(&mut self) {
            assert!(
                self.until(Duration::from_secs(10), |c| c.browser.connected && c.browser.channel_open),
                "the browser never connected"
            );
        }

        fn send_text(&mut self, text: &str) {
            let id = self.browser.channel;
            let accepted = self.browser.rtc.channel(id).expect("the channel").write(false, text.as_bytes());
            assert!(accepted.unwrap(), "the data channel took the message");
        }

        fn finished(&self) -> bool {
            self.hooks.closed.load(SeqCst) > 0
        }
    }
    impl Drop for Call {
        fn drop(&mut self) {
            self.alive.store(false, SeqCst);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    fn picture(key: bool) -> EncodedFrame {
        // Annex B: SPS, PPS and an IDR slice for a keyframe, a non-IDR slice otherwise.
        let mut data = Vec::new();
        if key {
            data.extend_from_slice(&[0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0x8c, 0x8d, 0x40]);
            data.extend_from_slice(&[0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80]);
            data.extend_from_slice(&[0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00, 0x33, 0xff]);
        } else {
            data.extend_from_slice(&[0, 0, 0, 1, 0x41, 0x9a, 0x24, 0x6c, 0x41, 0xff]);
        }
        EncodedFrame { data, key, submitted: Instant::now() }
    }

    #[test]
    fn a_session_connects_asks_for_a_keyframe_and_hands_the_pages_messages_to_its_session() {
        let mut call = Call::start(IDLE_LIMIT);
        call.connect();
        assert_eq!(call.hooks.keyframes.load(SeqCst), 1, "a new viewer wants a keyframe");

        let message = r#"{"type":"key","code":"KeyA","down":true}"#;
        call.send_text(message);
        assert!(call.until(Duration::from_secs(5), |c| !c.hooks.inputs.lock().unwrap().is_empty()));
        assert_eq!(*call.hooks.inputs.lock().unwrap(), vec![message.as_bytes().to_vec()]);
        assert_eq!(call.hooks.input_closed.load(SeqCst), 0);

        // Closing the channel (not the peer) is reported once, and the peer lives on.
        let channel = call.browser.channel;
        call.browser.rtc.direct_api().close_data_channel(channel);
        assert!(call.until(Duration::from_secs(5), |c| c.hooks.input_closed.load(SeqCst) > 0));
        assert_eq!(call.hooks.input_closed.load(SeqCst), 1);
        assert!(!call.finished(), "the session outlives its input channel");
    }

    #[test]
    fn frames_sent_to_a_connected_peer_reach_the_page_and_its_picture_loss_request_reaches_the_session() {
        let mut call = Call::start(IDLE_LIMIT);
        // Before the connection is up a frame is not sent anywhere (the peer waits for a keyframe).
        call.connect();
        let before = call.hooks.keyframes.load(SeqCst);
        let mut seen = false;
        let deadline = Instant::now() + Duration::from_secs(10);
        while !seen && Instant::now() < deadline {
            call.queue.send(Msg::Frame(picture(true))).unwrap();
            seen = call.until(Duration::from_millis(100), |c| c.browser.pictures > 0);
        }
        assert!(seen, "no picture reached the browser");

        let mid = call.browser.mid;
        call.browser.rtc.writer(mid).expect("the video").request_keyframe(None, KeyframeRequestKind::Pli).unwrap();
        assert!(
            call.until(Duration::from_secs(5), |c| c.hooks.keyframes.load(SeqCst) > before),
            "the page's picture loss indication never reached the session"
        );
    }

    #[test]
    fn the_bandwidth_estimate_str0m_reports_reaches_the_session() {
        let mut call = Call::start(IDLE_LIMIT);
        call.connect();
        let deadline = Instant::now() + Duration::from_secs(20);
        // A steady stream of large keyframes gives the estimator feedback to work with.
        let mut data = picture(true).data;
        data.resize(6000, 0x55);
        while call.hooks.estimates.lock().unwrap().is_empty() && Instant::now() < deadline {
            let frame = EncodedFrame { data: data.clone(), key: true, submitted: Instant::now() };
            let _ = call.queue.try_send(Msg::Frame(frame));
            call.until(Duration::from_millis(15), |_| false);
        }
        let estimates = call.hooks.estimates.lock().unwrap().clone();
        assert!(!estimates.is_empty(), "no bandwidth estimate reached the session");
        assert!(estimates.iter().all(|&bps| bps > 0), "{estimates:?}");
    }

    #[test]
    fn every_estimate_reaches_the_session_and_one_under_the_floor_also_restarts_the_estimator() {
        let params = PeerParams {
            bind_ip: "127.0.0.1".parse().unwrap(),
            initial_bitrate: 6_000_000,
            desired_bitrate: 12_000_000,
        };
        let mut rtc = new_rtc(&params);
        let hooks = Recorder::default();
        let mut log = LogLimiter::default();
        for bps in [4_500_000, 66_000, 10_000, 3_000_000] {
            handle_estimate(&mut rtc, &hooks, &mut log, bps);
        }
        assert_eq!(*hooks.estimates.lock().unwrap(), vec![4_500_000, 66_000, 10_000, 3_000_000]);
        assert!(rtc.is_alive(), "restarting the estimator must leave the connection as it was");
    }

    #[derive(Default)]
    struct Restarts(Vec<u32>);
    impl Estimator for Restarts {
        fn restart(&mut self, bps: u32) {
            self.0.push(bps);
        }
    }

    fn restarts_for(estimates: &[u64]) -> (Vec<u32>, Vec<u64>) {
        let mut estimator = Restarts::default();
        let hooks = Recorder::default();
        let mut log = LogLimiter::default();
        for &bps in estimates {
            handle_estimate(&mut estimator, &hooks, &mut log, bps);
        }
        let seen = hooks.estimates.lock().unwrap().clone();
        (estimator.0, seen)
    }

    #[test]
    fn an_estimate_under_the_floor_restarts_the_estimator_at_the_floor_each_time() {
        let (restarts, seen) = restarts_for(&[66_000, 10_000]);
        assert_eq!(restarts, vec![crate::bitrate::FLOOR_BPS; 2], "one restart at the floor per low estimate");
        assert_eq!(seen, vec![66_000, 10_000], "the encoder still hears every estimate");
    }

    #[test]
    fn estimates_at_or_over_the_floor_leave_the_estimator_alone() {
        let (restarts, seen) = restarts_for(&[4_500_000, 3_000_000]);
        assert!(restarts.is_empty(), "restarted on a usable estimate: {restarts:?}");
        assert_eq!(seen, vec![4_500_000, 3_000_000]);
    }

    #[test]
    fn accepted_datagrams_keep_a_session_alive_and_silence_ends_it() {
        let limit = Duration::from_secs(2);
        let mut call = Call::start(limit);
        call.connect();
        // Four limits' worth of traffic from the page: the session stays.
        let began = Instant::now();
        while began.elapsed() < limit * 2 {
            call.send_text(r#"{"type":"pointer","x":0.5,"y":0.5}"#);
            call.until(Duration::from_millis(100), |_| false);
            assert!(!call.finished(), "the session closed while the page was sending ({:?})", began.elapsed());
        }
        // Nothing more is pumped: the page is gone, and the session ends by itself.
        let silent_since = Instant::now();
        while !call.finished() && silent_since.elapsed() < limit * 4 {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(call.finished(), "silence did not end the session");
        assert!(silent_since.elapsed() >= limit / 2, "it ended at once, not after the idle limit");
    }

    #[test]
    fn a_silent_peer_has_its_keys_released_but_keeps_its_session_and_can_be_released_again() {
        let mut call = Call::start_with(Duration::from_secs(30), Duration::from_millis(400));
        call.connect();
        let before = call.hooks.silent.load(SeqCst);
        // Nothing is pumped: the page is gone. The release comes once, the session stays.
        let quiet_since = Instant::now();
        while call.hooks.silent.load(SeqCst) == before && quiet_since.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(call.hooks.silent.load(SeqCst), before + 1, "silence did not release");
        assert!(quiet_since.elapsed() >= Duration::from_millis(300), "released at once, not after the silence");
        std::thread::sleep(Duration::from_millis(900));
        assert_eq!(call.hooks.silent.load(SeqCst), before + 1, "released again within the same silence");
        assert!(!call.finished(), "the release ended the session");
        // The page is back (its packets are accepted), then gone again: one more release.
        call.send_text(r#"{"type":"pointer","x":0.5,"y":0.5}"#);
        call.until(Duration::from_millis(150), |_| false);
        let resumed = call.hooks.silent.load(SeqCst);
        let again_since = Instant::now();
        while call.hooks.silent.load(SeqCst) == resumed && again_since.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(call.hooks.silent.load(SeqCst), resumed + 1, "the second silence did not release");
        assert!(!call.finished());
    }

    #[test]
    fn a_replaced_peer_tells_the_page_and_then_ends() {
        let mut call = Call::start(IDLE_LIMIT);
        call.connect();
        call.handle.close_replaced();
        let began = Instant::now();
        assert!(
            call.until(Duration::from_secs(3), |c| c.finished()
                && c.browser.notices.iter().any(|n| n == NOTICE_REPLACED)),
            "the page heard {:?}, finished: {}",
            call.browser.notices,
            call.finished()
        );
        assert!(began.elapsed() < Duration::from_secs(1), "the replaced peer took {:?} to go", began.elapsed());
        assert_eq!(call.browser.notices, vec![NOTICE_REPLACED.to_string()]);
        assert_eq!(serde_json::from_str::<serde_json::Value>(NOTICE_REPLACED).unwrap()["type"], "replaced");
        // The page's parseNotice reads strings only: the frame kind is part of the contract.
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../tests/fixtures/contract.json")).unwrap();
        assert_eq!(fixture["noticeFrame"], "text");
        assert_eq!(
            call.browser.notice_binary,
            vec![fixture["noticeFrame"] == "binary"],
            "the notice must be a text frame"
        );
    }

    #[test]
    fn a_real_session_runs_with_the_production_limits() {
        let (alive, repair, replaced) = (AtomicBool::new(true), AtomicBool::new(false), AtomicBool::new(false));
        let signals = Signals::production(&alive, &repair, &replaced);
        assert_eq!(signals.idle_limit, IDLE_LIMIT);
        assert_eq!(signals.release_after, RELEASE_AFTER);
    }

    #[test]
    fn a_peer_that_is_closed_for_any_other_reason_sends_no_notice() {
        let mut call = Call::start(IDLE_LIMIT);
        call.connect();
        call.handle.close();
        assert!(call.until(Duration::from_secs(3), |c| c.finished()));
        call.until(Duration::from_millis(200), |_| false);
        assert!(call.browser.notices.is_empty(), "{:?}", call.browser.notices);
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
