//! The agent proper, free of the macOS frameworks so its decisions can be tested anywhere:
//! which requests are refused, how a session is installed, replaced and ended, and what
//! each session's hooks may touch (spec D3, D4, D5). `mac::agent` plugs the real capture,
//! input and system calls into it.
use crate::bitrate::BitrateController;
use crate::frame::FrameTarget;
use crate::http::{Backend, SessionFailure, SessionRequest};
use crate::peer::{PeerHandle, PeerHooks, PeerParams};
use crate::protocol::{self, InputMsg};
use crate::size::{bitrate_cap, fit_to_display, Size};
use crate::slot::{Closer, Slot};
use crate::status::{Accessibility, DisplayState, Screen, Status, REFUSE_WHEN_LOCKED};
use std::any::Any;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, Mutex, MutexGuard};

const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Used when the display's size cannot be read.
const FALLBACK_DISPLAY: Size = Size { w: 3840, h: 2160 };

/// Capture, encoder and sender (`mac::pipeline::Pipeline`).
pub trait Capture: Send + Sync + 'static {
    fn start(&self, size: Size, bitrate: u32, target: Arc<dyn FrameTarget>) -> Result<(), String>;
    fn resize(&self, size: Size, bitrate_cap: u32) -> Result<(), String>;
    fn stop(&self);
    fn request_keyframe(&self);
    fn set_bitrate(&self, bps: u32);
    /// Only content-free frames for a while.
    fn suspect(&self) -> bool;
    /// Seconds since the epoch of the last frame with content. A still screen delivers no
    /// frames, so this does not advance then; it is reported, never judged.
    fn last_capture_at(&self) -> Option<u64>;
}

/// Event injection (`mac::inject::Injector`).
pub trait Input: Send + Sync + 'static {
    fn handle(&self, message: InputMsg);
    fn release_all(&self);
}

/// What the system says (permissions, display, lock screen).
pub trait Platform: Send + Sync + 'static {
    fn screen_recording_granted(&self) -> bool;
    fn accessibility_granted(&self) -> bool;
    fn display_state(&self) -> DisplayState;
    fn screen_locked(&self) -> bool;
    fn native_pixels(&self) -> Option<Size>;
    /// Wakes the display (waiting a little for it) and keeps it awake until the returned
    /// guard is dropped (spec D3).
    fn wake_display(&self) -> Box<dyn Any + Send>;
}

pub type Accept =
    Box<dyn Fn(&str, PeerParams, Arc<dyn PeerHooks>) -> anyhow::Result<(String, PeerHandle)> + Send + Sync>;

pub struct Parts {
    pub bind: IpAddr,
    pub platform: Box<dyn Platform>,
    pub capture: Box<dyn Capture>,
    pub input: Box<dyn Input>,
    pub accept: Accept,
}

/// What the slot keeps for the running session. Dropping it releases the wake lock.
struct SessionHandle {
    peer: PeerHandle,
    _wake: Box<dyn Any + Send>,
}
impl Closer for SessionHandle {
    fn close(&self) {
        self.peer.close();
    }
}

struct Core {
    parts: Parts,
    slot: Slot<SessionHandle>,
    /// Serialises the steps that change what runs (install, capture start, capture stop), so
    /// a session's cleanup cannot interleave with its replacement's set-up. The slot's own
    /// lock is taken inside it, never the other way round.
    lifecycle: Mutex<()>,
}

impl Core {
    fn lifecycle(&self) -> MutexGuard<'_, ()> {
        self.lifecycle.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub struct Sessions {
    core: Arc<Core>,
}

impl Sessions {
    pub fn new(parts: Parts) -> Sessions {
        Sessions { core: Arc::new(Core { parts, slot: Slot::default(), lifecycle: Mutex::new(()) }) }
    }
}

/// One session's side of its peer. Every call is checked against the slot: once the session
/// has been replaced or has ended, it can touch nothing.
struct Hooks {
    core: Arc<Core>,
    /// The slot's number for this session; 0 until it is installed (nothing is current then).
    id: AtomicU64,
    controller: Mutex<BitrateController>,
    display_px: Size,
    /// The stream size the page last asked for, for a capture that starts after the request.
    size: Mutex<Size>,
}

impl Hooks {
    fn id(&self) -> u64 {
        self.id.load(Relaxed)
    }
}

impl PeerHooks for Hooks {
    fn request_keyframe(&self) {
        self.core.slot.with_current(self.id(), || self.core.parts.capture.request_keyframe());
    }

    fn estimate(&self, bps: u64) {
        self.core.slot.with_current(self.id(), || {
            if let Some(next) = self.controller.lock().unwrap().on_estimate(bps) {
                self.core.parts.capture.set_bitrate(next);
            }
        });
    }

    fn input(&self, data: &[u8]) {
        // Runs inside the slot's lock: a take-over (and the release that follows it) waits
        // for this message, so a replaced session cannot leave a key down behind its release.
        self.core.slot.with_current(self.id(), || match protocol::parse(data) {
            Some(InputMsg::Size(requested)) => {
                let size = fit_to_display(requested, self.display_px);
                let cap = bitrate_cap(size);
                *self.size.lock().unwrap() = size;
                if let Some(next) = self.controller.lock().unwrap().set_cap(cap) {
                    self.core.parts.capture.set_bitrate(next);
                }
                if let Err(e) = self.core.parts.capture.resize(size, cap) {
                    eprintln!("[session] resize failed: {e}");
                }
            }
            Some(message) => self.core.parts.input.handle(message),
            None => {}
        });
    }

    fn input_closed(&self) {
        self.core.slot.with_current(self.id(), || self.core.parts.input.release_all());
    }

    fn closed(&self) {
        let _life = self.core.lifecycle();
        // A replaced session's late end is a no-op: its keys were released when it was
        // replaced, and the capture belongs to the session that replaced it.
        if self.core.slot.finished(self.id()) {
            self.core.parts.input.release_all();
            self.core.parts.capture.stop();
            println!("[session] ended; capture stopped");
        }
    }
}

/// Starts (or re-targets) the capture for session `id`, after its answer has gone out.
fn begin_capture(core: &Core, hooks: &Hooks, id: u64, peer: &PeerHandle) {
    let _life = core.lifecycle();
    let started = core.slot.with_current(id, || {
        if !peer.is_alive() {
            return Err("the peer ended before capture started".to_string());
        }
        let size = *hooks.size.lock().unwrap();
        let bitrate = hooks.controller.lock().unwrap().current();
        core.parts.capture.start(size, bitrate, Arc::new(peer.clone()))
    });
    match started {
        Some(Ok(())) => {}
        // Replaced or ended meanwhile: whoever replaced it starts the capture for itself.
        None => {}
        Some(Err(e)) => {
            eprintln!("[session] capture did not start: {e}");
            peer.close();
            // Nothing may keep capturing without a session.
            if core.slot.finished(id) {
                core.parts.input.release_all();
                core.parts.capture.stop();
            }
        }
    }
}

impl Backend for Sessions {
    fn status(&self) -> Status {
        let parts = &self.core.parts;
        let screen = if !parts.platform.screen_recording_granted() {
            Screen::Denied
        } else if parts.capture.suspect() {
            Screen::Suspect
        } else {
            Screen::Granted
        };
        Status {
            screen,
            accessibility: if parts.platform.accessibility_granted() {
                Accessibility::Granted
            } else {
                Accessibility::Denied
            },
            display: parts.platform.display_state(),
            locked: parts.platform.screen_locked(),
            last_capture_at: parts.capture.last_capture_at(),
            version: VERSION,
        }
    }

    fn start_session(&self, request: SessionRequest) -> Result<String, SessionFailure> {
        let core = &self.core;
        let parts = &core.parts;
        // Only permission and (by P1's choice) a locked screen refuse. A black-frame suspicion
        // and a stale `lastCaptureAt` do not: a session is how they are cleared.
        self.status().gate(REFUSE_WHEN_LOCKED).map_err(SessionFailure::Gate)?;
        let wake = parts.platform.wake_display();
        let display_px = parts.platform.native_pixels().unwrap_or(FALLBACK_DISPLAY);
        let size = fit_to_display(request.size, display_px);
        let cap = bitrate_cap(size);
        let controller = BitrateController::new(cap);
        let params = PeerParams { bind_ip: parts.bind, initial_bitrate: controller.current(), desired_bitrate: cap };
        let hooks = Arc::new(Hooks {
            core: core.clone(),
            id: AtomicU64::new(0),
            controller: Mutex::new(controller),
            display_px,
            size: Mutex::new(size),
        });
        // The offer is accepted before anything else changes: a bad offer must not end a good session.
        let (answer, peer) = (parts.accept)(&request.sdp, params, hooks.clone())
            .map_err(|e| SessionFailure::BadOffer(format!("{e:#}")))?;
        {
            let _life = core.lifecycle();
            // The previous session's peer is closed by the take-over; what it still held down is
            // released here, once, and its late `closed()` will find it is no longer current.
            let id = core.slot.take_over(SessionHandle { peer: peer.clone(), _wake: wake });
            hooks.id.store(id, Relaxed);
            parts.input.release_all();
        }
        // The answer goes out now. Capture start-up (which can take a while the first time)
        // must not eat into the gateway's 10 s; the encoder opens with a keyframe when it starts.
        let (core, id) = (core.clone(), hooks.id());
        std::thread::spawn(move || begin_capture(&core, &hooks, id, &peer));
        Ok(answer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status::Gate;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
    use std::time::{Duration, Instant};

    #[derive(Default)]
    struct Log(Mutex<Vec<String>>);
    impl Log {
        fn add(&self, line: impl Into<String>) {
            self.0.lock().unwrap().push(line.into());
        }
        fn count(&self, prefix: &str) -> usize {
            self.0.lock().unwrap().iter().filter(|l| l.starts_with(prefix)).count()
        }
        fn all(&self) -> Vec<String> {
            self.0.lock().unwrap().clone()
        }
    }

    struct FakeCapture {
        log: Arc<Log>,
        fail_start: AtomicBool,
        start_delay: Mutex<Duration>,
        suspect: AtomicBool,
        last_capture: Mutex<Option<u64>>,
    }
    impl Capture for Arc<FakeCapture> {
        fn start(&self, size: Size, bitrate: u32, _target: Arc<dyn FrameTarget>) -> Result<(), String> {
            std::thread::sleep(*self.start_delay.lock().unwrap());
            self.log.add(format!("start {}x{} {bitrate}", size.w, size.h));
            if self.fail_start.load(SeqCst) {
                Err("no displays".into())
            } else {
                Ok(())
            }
        }
        fn resize(&self, size: Size, cap: u32) -> Result<(), String> {
            self.log.add(format!("resize {}x{} {cap}", size.w, size.h));
            Ok(())
        }
        fn stop(&self) {
            self.log.add("stop");
        }
        fn request_keyframe(&self) {
            self.log.add("keyframe");
        }
        fn set_bitrate(&self, bps: u32) {
            self.log.add(format!("bitrate {bps}"));
        }
        fn suspect(&self) -> bool {
            self.suspect.load(SeqCst)
        }
        fn last_capture_at(&self) -> Option<u64> {
            *self.last_capture.lock().unwrap()
        }
    }

    struct FakeInput(Arc<Log>);
    impl Input for FakeInput {
        fn handle(&self, message: InputMsg) {
            self.0.add(format!("input {message:?}"));
        }
        fn release_all(&self) {
            self.0.add("release_all");
        }
    }

    struct FakePlatform {
        screen: AtomicBool,
        accessibility: AtomicBool,
        locked: AtomicBool,
        wakes_held: Arc<AtomicUsize>,
    }
    struct WakeGuard(Arc<AtomicUsize>);
    impl Drop for WakeGuard {
        fn drop(&mut self) {
            self.0.fetch_sub(1, SeqCst);
        }
    }
    impl Platform for Arc<FakePlatform> {
        fn screen_recording_granted(&self) -> bool {
            self.screen.load(SeqCst)
        }
        fn accessibility_granted(&self) -> bool {
            self.accessibility.load(SeqCst)
        }
        fn display_state(&self) -> DisplayState {
            DisplayState::Ok
        }
        fn screen_locked(&self) -> bool {
            self.locked.load(SeqCst)
        }
        fn native_pixels(&self) -> Option<Size> {
            Some(Size { w: 2560, h: 1440 })
        }
        fn wake_display(&self) -> Box<dyn Any + Send> {
            self.wakes_held.fetch_add(1, SeqCst);
            Box::new(WakeGuard(self.wakes_held.clone()))
        }
    }

    type Peers = Arc<Mutex<Vec<(Arc<dyn PeerHooks>, PeerHandle)>>>;

    /// The test's grip on one agent: fakes for everything outside it, and the hooks of every
    /// peer it accepted (a test calls them the way the peer thread would).
    struct Rig {
        agent: Sessions,
        log: Arc<Log>,
        capture: Arc<FakeCapture>,
        platform: Arc<FakePlatform>,
        peers: Peers,
    }

    fn rig() -> Rig {
        let log = Arc::new(Log::default());
        let capture = Arc::new(FakeCapture {
            log: log.clone(),
            fail_start: AtomicBool::new(false),
            start_delay: Mutex::new(Duration::ZERO),
            suspect: AtomicBool::new(false),
            last_capture: Mutex::new(None),
        });
        let platform = Arc::new(FakePlatform {
            screen: AtomicBool::new(true),
            accessibility: AtomicBool::new(true),
            locked: AtomicBool::new(false),
            wakes_held: Arc::new(AtomicUsize::new(0)),
        });
        let peers: Peers = Arc::default();
        let recorded = peers.clone();
        let accept_log = log.clone();
        let accept: Accept = Box::new(move |sdp, _params, hooks| {
            accept_log.add("accept");
            if sdp != "v=0 offer" {
                anyhow::bail!("bad offer");
            }
            let handle = PeerHandle::detached();
            recorded.lock().unwrap().push((hooks, handle.clone()));
            Ok(("v=0 answer".to_string(), handle))
        });
        let agent = Sessions::new(Parts {
            bind: "127.0.0.1".parse().unwrap(),
            platform: Box::new(platform.clone()),
            capture: Box::new(capture.clone()),
            input: Box::new(FakeInput(log.clone())),
            accept,
        });
        Rig { agent, log, capture, platform, peers }
    }

    impl Rig {
        fn offer(&self) -> SessionRequest {
            SessionRequest { size: Size { w: 1280, h: 720 }, sdp: "v=0 offer".into() }
        }
        /// A new session; returns the hooks and the handle of the peer it was given.
        fn open(&self) -> (Arc<dyn PeerHooks>, PeerHandle) {
            assert!(self.agent.start_session(self.offer()).is_ok(), "the session was refused");
            self.peers.lock().unwrap().last().cloned().unwrap()
        }
        /// Waits for a capture start thread to have done its work.
        fn settle(&self, expected: impl Fn(&Log) -> bool) {
            let deadline = Instant::now() + Duration::from_secs(3);
            while !expected(&self.log) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            assert!(expected(&self.log), "gave up waiting; log: {:?}", self.log.all());
        }
    }

    const KEY_A: &[u8] = br#"{"type":"key","code":"KeyA","down":true}"#;

    fn refused(result: Result<String, SessionFailure>) -> Gate {
        match result {
            Err(SessionFailure::Gate(gate)) => gate,
            Err(_) => panic!("refused for another reason"),
            Ok(_) => panic!("the session was not refused"),
        }
    }

    #[test]
    fn a_missing_permission_refuses_before_anything_starts() {
        let rig = rig();
        for (screen, accessibility) in [(false, true), (true, false), (false, false)] {
            rig.platform.screen.store(screen, SeqCst);
            rig.platform.accessibility.store(accessibility, SeqCst);
            assert_eq!(refused(rig.agent.start_session(rig.offer())), Gate::Permission);
        }
        assert_eq!(rig.platform.wakes_held.load(SeqCst), 0, "the display is not woken for a refused request");
        assert!(rig.log.all().is_empty(), "nothing was accepted or started: {:?}", rig.log.all());
    }

    #[test]
    fn a_locked_screen_refuses_with_locked_and_permission_wins_over_it() {
        #[allow(clippy::assertions_on_constants)] // the test is about the value P1 will change
        {
            assert!(REFUSE_WHEN_LOCKED, "P1 has flipped it: this test follows the new value");
        }
        let rig = rig();
        rig.platform.locked.store(true, SeqCst);
        assert_eq!(refused(rig.agent.start_session(rig.offer())), Gate::Locked);
        rig.platform.screen.store(false, SeqCst);
        assert_eq!(refused(rig.agent.start_session(rig.offer())), Gate::Permission);
        assert!(rig.log.all().is_empty());
    }

    #[test]
    fn a_black_frame_suspicion_and_a_stale_last_capture_do_not_refuse_a_session() {
        let rig = rig();
        rig.capture.suspect.store(true, SeqCst);
        *rig.capture.last_capture.lock().unwrap() = Some(1); // the screen has been still since 1970
        let status = rig.agent.status();
        assert_eq!(status.screen, Screen::Suspect);
        assert_eq!(status.last_capture_at, Some(1), "reported as it is, not judged");
        assert!(rig.agent.start_session(rig.offer()).is_ok(), "a session was refused");
        rig.settle(|log| log.count("start") == 1);
    }

    #[test]
    fn the_status_reports_the_system_as_it_is() {
        let rig = rig();
        rig.platform.screen.store(false, SeqCst);
        rig.platform.accessibility.store(false, SeqCst);
        rig.platform.locked.store(true, SeqCst);
        let status = rig.agent.status();
        assert_eq!((status.screen, status.accessibility, status.locked), (Screen::Denied, Accessibility::Denied, true));
        assert_eq!(status.last_capture_at, None);
    }

    #[test]
    fn the_answer_does_not_wait_for_the_capture_to_start() {
        let rig = rig();
        *rig.capture.start_delay.lock().unwrap() = Duration::from_millis(800);
        let began = Instant::now();
        let answer = rig.agent.start_session(rig.offer()).ok().expect("a session");
        assert_eq!(answer, "v=0 answer");
        assert!(began.elapsed() < Duration::from_millis(400), "the answer waited: {:?}", began.elapsed());
        assert_eq!(rig.log.count("start"), 0, "capture was still starting");
        rig.settle(|log| log.count("start") == 1);
    }

    #[test]
    fn the_capture_starts_at_the_requested_size_fitted_to_the_screen() {
        let rig = rig();
        rig.open();
        rig.settle(|log| log.count("start") == 1);
        // 1280x720 on a 2560x1440 screen: the same aspect, so exactly the request; 6 Mbps to begin with.
        assert!(rig.log.all().contains(&"start 1280x720 6000000".to_string()), "{:?}", rig.log.all());
    }

    #[test]
    fn a_bad_offer_leaves_the_running_session_alone() {
        let rig = rig();
        let (_hooks, first) = rig.open();
        rig.settle(|log| log.count("start") == 1);
        let bad = SessionRequest { size: Size { w: 1280, h: 720 }, sdp: "garbage".into() };
        assert!(matches!(rig.agent.start_session(bad), Err(SessionFailure::BadOffer(_))));
        assert!(first.is_alive(), "the good session survived");
        assert_eq!(rig.platform.wakes_held.load(SeqCst), 1, "and only its wake lock is held");
        assert_eq!(rig.log.count("stop"), 0);
        assert_eq!(rig.log.count("release_all"), 1, "only the first session's own install released anything");
    }

    #[test]
    fn a_new_offer_takes_over_without_stopping_the_capture() {
        let rig = rig();
        let (_first_hooks, first) = rig.open();
        rig.settle(|log| log.count("start") == 1);
        let (_second_hooks, second) = rig.open();
        rig.settle(|log| log.count("start") == 2);
        assert!(!first.is_alive(), "the old peer was closed");
        assert!(second.is_alive());
        assert_eq!(rig.log.count("stop"), 0, "no gap in the capture");
        assert_eq!(rig.platform.wakes_held.load(SeqCst), 1, "the old session's wake lock went with it");
    }

    #[test]
    fn a_replaced_session_has_what_it_held_released_when_it_is_replaced() {
        let rig = rig();
        let (hooks, _first) = rig.open();
        rig.settle(|log| log.count("start") == 1);
        hooks.input(KEY_A);
        let before = rig.log.count("release_all");
        rig.open();
        assert_eq!(rig.log.count("release_all"), before + 1);
        let log = rig.log.all();
        let pressed = log.iter().position(|l| l.starts_with("input")).unwrap();
        let released = log.iter().rposition(|l| l == "release_all").unwrap();
        assert!(pressed < released, "the key was pressed, then released: {log:?}");
    }

    #[test]
    fn the_late_end_of_a_replaced_session_touches_neither_the_new_sessions_keys_nor_its_capture() {
        let rig = rig();
        let (old_hooks, _old) = rig.open();
        rig.settle(|log| log.count("start") == 1);
        let (new_hooks, new) = rig.open();
        rig.settle(|log| log.count("start") == 2);
        new_hooks.input(KEY_A);
        let (released, stopped) = (rig.log.count("release_all"), rig.log.count("stop"));
        old_hooks.input_closed();
        old_hooks.closed(); // the old peer thread ends after the new session is installed
        assert_eq!(rig.log.count("release_all"), released, "the new session's held keys stay down");
        assert_eq!(rig.log.count("stop"), stopped, "and its capture keeps running");
        assert!(new.is_alive());
        new_hooks.input(KEY_A);
        assert_eq!(rig.log.count("input"), 2, "the new session still injects");
    }

    #[test]
    fn a_replaced_session_can_no_longer_inject_resize_or_steer_the_encoder() {
        let rig = rig();
        let (old_hooks, _old) = rig.open();
        rig.settle(|log| log.count("start") == 1);
        rig.open();
        rig.settle(|log| log.count("start") == 2);
        old_hooks.input(KEY_A);
        old_hooks.input(br#"{"type":"size","w":1920,"h":1080}"#);
        old_hooks.estimate(2_000_000);
        old_hooks.request_keyframe();
        assert_eq!(rig.log.count("input"), 0);
        assert_eq!(rig.log.count("resize"), 0);
        assert_eq!(rig.log.count("bitrate"), 0);
        assert_eq!(rig.log.count("keyframe"), 0);
    }

    #[test]
    fn hooks_of_a_session_that_is_not_installed_yet_touch_nothing() {
        // The hooks exist from the moment the peer does; the slot number comes a moment later.
        let rig = rig();
        rig.open();
        rig.settle(|log| log.count("start") == 1);
        let stray = Hooks {
            core: rig.agent.core.clone(),
            id: AtomicU64::new(0),
            controller: Mutex::new(BitrateController::new(12_000_000)),
            display_px: Size { w: 2560, h: 1440 },
            size: Mutex::new(Size { w: 1280, h: 720 }),
        };
        let before = rig.log.all();
        stray.input(KEY_A);
        stray.input_closed();
        stray.estimate(2_000_000);
        stray.closed();
        assert_eq!(rig.log.all(), before);
    }

    #[test]
    fn the_current_sessions_end_releases_input_and_stops_capture_and_wake_once() {
        let rig = rig();
        let (hooks, _peer) = rig.open();
        rig.settle(|log| log.count("start") == 1);
        let released = rig.log.count("release_all");
        hooks.closed();
        assert_eq!(rig.log.count("release_all"), released + 1);
        assert_eq!(rig.log.count("stop"), 1);
        assert_eq!(rig.platform.wakes_held.load(SeqCst), 0, "the wake lock is released with the session");
        hooks.closed();
        assert_eq!(rig.log.count("stop"), 1, "a second end changes nothing");
        // And a new session starts the capture again.
        rig.open();
        rig.settle(|log| log.count("start") == 2);
    }

    #[test]
    fn closing_the_input_channel_releases_everything_but_leaves_the_session_up() {
        let rig = rig();
        let (hooks, peer) = rig.open();
        rig.settle(|log| log.count("start") == 1);
        let released = rig.log.count("release_all");
        hooks.input_closed();
        assert_eq!(rig.log.count("release_all"), released + 1);
        assert!(peer.is_alive());
        assert_eq!(rig.log.count("stop"), 0);
    }

    #[test]
    fn a_size_message_resizes_the_stream_to_the_fitted_size_and_ceiling() {
        let rig = rig();
        let (hooks, _peer) = rig.open();
        rig.settle(|log| log.count("start") == 1);
        // 1500x900 on a 2560x1440 screen: the screen's aspect ratio (16:9), even sides.
        hooks.input(br#"{"type":"size","w":1500,"h":900}"#);
        assert!(rig.log.all().contains(&"resize 1500x842 12000000".to_string()), "{:?}", rig.log.all());
        // Out of range sizes never reach the capture.
        hooks.input(br#"{"type":"size","w":100,"h":100}"#);
        assert_eq!(rig.log.count("resize"), 1);
    }

    #[test]
    fn a_resize_that_arrives_before_the_capture_starts_is_not_lost() {
        let rig = rig();
        *rig.capture.start_delay.lock().unwrap() = Duration::from_millis(300);
        let (hooks, _peer) = rig.open();
        hooks.input(br#"{"type":"size","w":1920,"h":1080}"#);
        rig.settle(|log| log.count("start") == 1);
        assert!(rig.log.all().contains(&"start 1920x1080 6000000".to_string()), "{:?}", rig.log.all());
    }

    #[test]
    fn bandwidth_estimates_steer_the_encoder_of_the_current_session() {
        let rig = rig();
        let (hooks, _peer) = rig.open();
        rig.settle(|log| log.count("start") == 1);
        hooks.estimate(3_000_000);
        assert!(rig.log.all().contains(&"bitrate 2550000".to_string()), "{:?}", rig.log.all());
        hooks.request_keyframe();
        assert_eq!(rig.log.count("keyframe"), 1);
    }

    #[test]
    fn a_capture_that_fails_to_start_ends_the_session_and_stops_the_capture() {
        let rig = rig();
        rig.capture.fail_start.store(true, SeqCst);
        let (hooks, peer) = rig.open();
        rig.settle(|log| log.count("stop") == 1);
        assert!(!peer.is_alive(), "the peer is closed");
        assert_eq!(rig.platform.wakes_held.load(SeqCst), 0);
        hooks.closed(); // the peer thread's own end, a moment later
        assert_eq!(rig.log.count("stop"), 1);
    }

    #[test]
    fn a_failed_retarget_stops_the_capture_that_is_already_running() {
        let rig = rig();
        let (_first_hooks, first) = rig.open();
        rig.settle(|log| log.count("start") == 1);
        rig.capture.fail_start.store(true, SeqCst); // the retarget for the second offer fails
        let (_second_hooks, second) = rig.open();
        rig.settle(|log| log.count("stop") == 1);
        assert!(!first.is_alive() && !second.is_alive());
        assert_eq!(rig.platform.wakes_held.load(SeqCst), 0);
        // The agent is usable again afterwards.
        rig.capture.fail_start.store(false, SeqCst);
        rig.open();
        rig.settle(|log| log.count("start") == 3);
    }

    #[test]
    fn a_peer_that_is_dead_when_the_capture_step_runs_leaves_no_capture_running() {
        let rig = rig();
        let (_hooks, peer) = rig.open();
        rig.settle(|log| log.count("start") == 1);
        // The peer dies, and the capture step of its session (number 1) runs only now.
        peer.close();
        let core = rig.agent.core.clone();
        let late = Hooks {
            core: core.clone(),
            id: AtomicU64::new(1),
            controller: Mutex::new(BitrateController::new(12_000_000)),
            display_px: Size { w: 2560, h: 1440 },
            size: Mutex::new(Size { w: 1280, h: 720 }),
        };
        begin_capture(&core, &late, 1, &peer);
        assert_eq!(rig.log.count("start"), 1, "no second start for a dead peer");
        assert_eq!(rig.log.count("stop"), 1, "the capture of the dead session is stopped");
        assert!(core.slot.is_empty());
    }
}
