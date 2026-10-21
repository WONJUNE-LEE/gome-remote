//! The agent proper, free of the macOS frameworks so its decisions can be tested anywhere:
//! which requests are refused, how a session is installed, replaced and ended, and what
//! each session's hooks may touch (spec D3, D4, D5). `mac::agent` plugs the real capture,
//! input and system calls into it.
use crate::bitrate::BitrateController;
use crate::clipboard::{self, Access, Board, ClipState, KeyAct, PasteRead};
use crate::frame::{EncodedFrame, FrameTarget};
use crate::http::{Backend, SessionFailure, SessionRequest};
use crate::peer::{PeerHandle, PeerHooks, PeerParams};
use crate::protocol::{self, InputMsg};
use crate::size::{bitrate_cap, fit_to_display, Size};
use crate::slot::{Closer, Slot};
use crate::status::{screen_of, Accessibility, DisplayState, Status, REFUSE_WHEN_LOCKED};
use std::any::Any;
use std::collections::VecDeque;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::{Duration, Instant};

const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Used when the display's size cannot be read.
const FALLBACK_DISPLAY: Size = Size { w: 3840, h: 2160 };
/// How many times a session's capture is restarted after the system stopped it, within
/// `RESTARTS_WITHIN`. One more and the session ends: something keeps stopping the stream.
const RESTARTS_MAX: usize = 3;
const RESTARTS_WITHIN: Duration = Duration::from_secs(60);

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
    /// Types single-line text as key codes (the lock screen), Unicode for what they cannot type.
    fn type_keys(&self, text: &str);
}

/// What the system says (permissions, display, lock screen), and the pasteboard (`Board`).
pub trait Platform: Board + Send + Sync + 'static {
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
        // The slot closes a session only to replace it.
        self.peer.close_replaced();
    }
}

struct Core {
    parts: Parts,
    slot: Slot<SessionHandle>,
    /// Held only for the short steps that install a session or end one, never across anything
    /// slow. The slot's own lock is taken inside it, never the other way round.
    lifecycle: Mutex<()>,
    /// Serialises the capture's own start and stop (which can take many seconds), so they
    /// never overlap. Only the threads that start or stop the capture wait on it: answers,
    /// the peers' hooks and the slot do not. Holds whether the capture may be running.
    /// Taken before `lifecycle` or the slot, never while holding either.
    capture_on: Mutex<bool>,
    /// Whether a locked screen refuses a session (P1's switch, `REFUSE_WHEN_LOCKED`).
    refuse_when_locked: bool,
    /// How often a session's ticker looks at the lock and the pasteboard (`clipboard::POLL`).
    poll: Duration,
}

/// `Platform` seen as the `Board` it contains (a trait object cannot be upcast on the
/// toolchain this crate supports).
struct PlatformBoard<'a>(&'a dyn Platform);
impl Board for PlatformBoard<'_> {
    fn change_count(&self) -> i64 {
        self.0.change_count()
    }
    fn access(&self) -> Access {
        self.0.access()
    }
    fn read(&self) -> PasteRead {
        self.0.read()
    }
    fn write(&self, text: &str, concealed: bool) -> i64 {
        self.0.write(text, concealed)
    }
    fn console_locked(&self) -> bool {
        self.0.console_locked()
    }
}

impl Core {
    fn board(&self) -> PlatformBoard<'_> {
        PlatformBoard(&*self.parts.platform)
    }

    fn lifecycle(&self) -> MutexGuard<'_, ()> {
        self.lifecycle.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub struct Sessions {
    core: Arc<Core>,
}

impl Sessions {
    pub fn new(parts: Parts) -> Sessions {
        Sessions::with_lock_policy(parts, REFUSE_WHEN_LOCKED)
    }

    /// `new` with P1's lock-screen switch given, so both of its values can be exercised.
    fn with_lock_policy(parts: Parts, refuse_when_locked: bool) -> Sessions {
        Sessions::with_options(parts, refuse_when_locked, clipboard::POLL)
    }

    /// `with_lock_policy` with the clipboard ticker's period given too, so a test need not wait 300 ms.
    fn with_options(parts: Parts, refuse_when_locked: bool, poll: Duration) -> Sessions {
        Sessions {
            core: Arc::new(Core {
                parts,
                slot: Slot::default(),
                lifecycle: Mutex::new(()),
                capture_on: Mutex::new(false),
                refuse_when_locked,
                poll,
            }),
        }
    }
}

/// One session's side of its peer. Every call is checked against the slot: once the session
/// has been replaced or has ended, it can touch nothing.
struct Hooks {
    core: Arc<Core>,
    /// The slot's number for this session; 0 until it is installed (nothing is current then).
    id: AtomicU64,
    controller: Mutex<BitrateController>,
    /// The display's pixels now: read when the session starts and again whenever the system
    /// stops the stream (a display that wakes up may change its mode a few seconds later).
    display_px: Mutex<Size>,
    /// The size the page last asked for, before it is fitted to the display.
    requested: Mutex<Size>,
    /// The stream size that request comes to on the display, for a capture that starts after the request.
    size: Mutex<Size>,
    /// When the capture was restarted after the system stopped it.
    restarts: Mutex<RestartBudget>,
    /// The clipboard sync's state. Only touched inside the slot's lock (or after the session is over).
    clip: Mutex<ClipState>,
    /// Set once the accepted peer is known, before the session is installed.
    peer: OnceLock<PeerHandle>,
    /// This session's hooks, for the ticker thread to hold weakly.
    me: Weak<Hooks>,
    /// Whether this session's ticker thread was started (one per session).
    ticking: AtomicBool,
}

impl Hooks {
    fn id(&self) -> u64 {
        self.id.load(Relaxed)
    }

    /// Releases every key the page held down, and the clipboard sync's memory of them.
    fn release_held(&self) {
        self.core.slot.with_current(self.id(), || {
            self.clip().release();
            self.core.parts.input.release_all();
        });
    }

    fn clip(&self) -> MutexGuard<'_, ClipState> {
        self.clip.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Sends the page what the clipboard sync decided to say. A `lock` notice that could not be
    /// queued is announced again at the next tick: a lost one would bring back a stale paste.
    fn send(&self, clip: &mut ClipState, texts: Vec<String>) {
        let Some(peer) = self.peer.get() else { return };
        for text in texts {
            let is_lock = text == protocol::lock_notice(true) || text == protocol::lock_notice(false);
            if !peer.send_text(text) && is_lock {
                clip.forget_lock();
            }
        }
    }

    /// One poll of the lock and the pasteboard. False when this session is over (replaced,
    /// ended, or its peer gone), which ends the ticker.
    ///
    /// The pasteboard read runs between two short stretches under the slot's and the clip
    /// state's locks: a macOS paste-privacy alert can hold the read until the user answers it
    /// through the very view whose input needs those locks.
    fn tick(&self) -> bool {
        if !self.peer.get().is_some_and(PeerHandle::is_alive) {
            return false;
        }
        let Some(read) = self.core.slot.with_current(self.id(), || {
            let mut clip = self.clip();
            let step = clip.tick_begin(&self.core.board());
            self.send(&mut clip, step.texts);
            step.read
        }) else {
            return false;
        };
        let Some(ticket) = read else { return true };
        let message = ClipState::read_for_page(&self.core.board());
        // The session may have been replaced meanwhile; the state may have moved on (a stale
        // read is dropped by `tick_finish`).
        self.core
            .slot
            .with_current(self.id(), || {
                let mut clip = self.clip();
                let message = clip.tick_finish(ticket, message);
                self.send(&mut clip, message.into_iter().collect());
            })
            .is_some()
    }
}

/// The session's clipboard ticker: every `poll` until the session is over.
fn run_ticker(hooks: Weak<Hooks>, poll: Duration) {
    loop {
        std::thread::sleep(poll);
        let Some(hooks) = hooks.upgrade() else { return };
        if !hooks.tick() {
            return;
        }
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
                *self.requested.lock().unwrap() = requested;
                let size = fit_to_display(requested, *self.display_px.lock().unwrap());
                let cap = bitrate_cap(size);
                *self.size.lock().unwrap() = size;
                if let Some(next) = self.controller.lock().unwrap().set_cap(cap) {
                    self.core.parts.capture.set_bitrate(next);
                }
                if let Err(e) = self.core.parts.capture.resize(size, cap) {
                    eprintln!("[session] resize failed: {e}");
                }
            }
            Some(InputMsg::Clipboard { text, concealed }) => {
                self.clip().inbound(&self.core.board(), &text, concealed);
            }
            Some(InputMsg::ClipboardWatch(on)) => self.clip().watch(&self.core.board(), on),
            Some(InputMsg::Key { action, down }) => {
                let mut clip = self.clip();
                let decision = clip.on_key(&self.core.board(), action, down);
                // Typing happens here, under the lock that made the decision: the lock state
                // cannot change between deciding to type and typing.
                match decision.act {
                    KeyAct::Inject => self.core.parts.input.handle(InputMsg::Key { action, down }),
                    KeyAct::Swallow => {}
                    KeyAct::Type(text) => self.core.parts.input.type_keys(&text),
                }
                self.send(&mut clip, decision.notice.into_iter().collect());
            }
            Some(InputMsg::Release) => {
                self.clip().release();
                self.core.parts.input.handle(InputMsg::Release);
            }
            Some(message) => self.core.parts.input.handle(message),
            None => {
                if data.len() > protocol::MAX_TEXT_MESSAGE {
                    eprintln!("[clipboard] dropped message ({} bytes)", data.len());
                }
            }
        });
    }

    fn input_closed(&self) {
        self.release_held();
    }

    fn channel_open(&self) {
        // The channel is open now: the first tick's `lock` notice is the first thing the page
        // hears (a text sent before this would have been dropped). A reopened channel is told again.
        self.core.slot.with_current(self.id(), || self.clip().forget_lock());
        self.tick();
        if !self.ticking.swap(true, Relaxed) {
            let (hooks, poll) = (self.me.clone(), self.core.poll);
            std::thread::spawn(move || run_ticker(hooks, poll));
        }
    }

    fn silent(&self) {
        self.release_held();
    }

    fn closed(&self) {
        let core = &self.core;
        // Whatever text this session held goes with it, replaced or not (the state is its own).
        self.clip().end();
        // A replaced session's late end is a no-op: its keys were released when it was
        // replaced, and the capture belongs to the session that replaced it.
        let ended = {
            let _life = core.lifecycle();
            let ended = core.slot.finished(self.id());
            if ended {
                core.parts.input.release_all();
            }
            ended
        };
        if ended {
            // Waits behind a capture start that is still running, then stops what it started.
            let mut on = core.capture_on.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            stop_if_idle(core, &mut on);
        }
    }
}

/// Stops the capture when no session is left to watch it. Caller holds `capture_on`.
fn stop_if_idle(core: &Core, on: &mut bool) {
    if *on && core.slot.is_empty() {
        core.parts.capture.stop();
        *on = false;
        println!("[session] ended; capture stopped");
    }
}

/// What `begin_capture` found when it looked at its session.
enum Plan {
    /// Replaced or ended meanwhile: the session that replaced it starts the capture itself,
    /// and an ended one has stopped it.
    Skip,
    /// Its peer died before the capture started.
    Dead,
    Go(Size, u32),
}

/// Starts (or re-targets) the capture for session `id`, after its answer has gone out.
///
/// No lock is held while the capture starts (ScreenCaptureKit can take tens of seconds when
/// the system is unhappy), apart from the one that keeps captures from starting or stopping
/// at the same time. A takeover that arrives meanwhile answers at once; its own start waits
/// its turn and re-targets the capture this one started.
fn begin_capture(core: &Core, hooks: &Hooks, id: u64, peer: &PeerHandle) {
    let mut on = core.capture_on.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let plan = core
        .slot
        .with_current(id, || {
            if !peer.is_alive() {
                return Plan::Dead;
            }
            Plan::Go(*hooks.size.lock().unwrap(), hooks.controller.lock().unwrap().current())
        })
        .unwrap_or(Plan::Skip);
    let (size, bitrate) = match plan {
        Plan::Skip => return,
        Plan::Dead => {
            end_session(core, hooks, id, &mut on);
            return;
        }
        Plan::Go(size, bitrate) => (size, bitrate),
    };
    *on = true;
    let result = core.parts.capture.start(size, bitrate, hooks.target(peer));
    if let Err(e) = result {
        eprintln!("[session] capture did not start: {e}");
        peer.close();
        end_session(core, hooks, id, &mut on);
        return;
    }
    after_start(core, hooks, id, (size, bitrate), &mut on);
}

/// Session `id` is over for want of a capture (or a peer): finishes it, releases what it held and
/// stops the capture. Caller holds `capture_on`.
fn end_session(core: &Core, hooks: &Hooks, id: u64, on: &mut bool) {
    let ended = {
        let _life = core.lifecycle();
        core.slot.finished(id)
    };
    if ended {
        hooks.clip().end();
        core.parts.input.release_all();
    }
    // Nothing may keep capturing without a session.
    stop_if_idle(core, on);
}

/// What follows a capture start for session `id` that began with `started` (size, bitrate).
/// Caller holds `capture_on`.
fn after_start(core: &Core, hooks: &Hooks, id: u64, started: (Size, u32), on: &mut bool) {
    if core.slot.is_current(id) {
        // The page may have resized or the estimate moved while the capture was starting.
        let (latest, current) = (*hooks.size.lock().unwrap(), hooks.controller.lock().unwrap().current());
        if latest != started.0 {
            core.parts.capture.resize(latest, bitrate_cap(latest)).unwrap_or_else(|e| eprintln!("[session] {e}"));
        }
        if current != started.1 {
            core.parts.capture.set_bitrate(current);
        }
    } else {
        // Superseded or ended while starting: a replacement's own start re-targets this
        // capture when it gets its turn; with no replacement the capture goes at once.
        stop_if_idle(core, on);
    }
}

/// What `restart_capture` found when it looked at its session.
enum Restart {
    /// Replaced, ended or its peer gone: whoever ended it stops the capture.
    Skip,
    /// The permission is gone, or the stream keeps being stopped: the session ends.
    GiveUp(&'static str),
    Go(Size, u32, usize),
}

/// The system stopped the capture stream under session `hooks` (a display that changes its mode
/// does that): restarts the capture for the same peer at the display's size now, so the session
/// survives. Runs on its own thread, started from ScreenCaptureKit's delegate callback, which a
/// capture start must not block. A session whose stream keeps being stopped, or whose restart
/// fails, ends as it did before restarts existed.
fn restart_capture(hooks: &Hooks) {
    let core = &hooks.core;
    let (id, Some(peer)) = (hooks.id(), hooks.peer.get()) else { return };
    let mut on = core.capture_on.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let granted = core.parts.platform.screen_recording_granted();
    let display = core.parts.platform.native_pixels();
    let plan = core
        .slot
        .with_current(id, || {
            if !peer.is_alive() {
                return Restart::Skip;
            }
            if !granted {
                return Restart::GiveUp("the screen recording permission is gone");
            }
            let Some(n) = hooks.restarts.lock().unwrap().take(Instant::now()) else {
                return Restart::GiveUp("the stream keeps being stopped");
            };
            // Under the slot's lock, like the page's `size` message, which uses the same values.
            let mut display_px = hooks.display_px.lock().unwrap();
            *display_px = display.unwrap_or(*display_px);
            let size = fit_to_display(*hooks.requested.lock().unwrap(), *display_px);
            *hooks.size.lock().unwrap() = size;
            let mut controller = hooks.controller.lock().unwrap();
            controller.set_cap(bitrate_cap(size));
            Restart::Go(size, controller.current(), n)
        })
        .unwrap_or(Restart::Skip);
    let (size, bitrate, n) = match plan {
        Restart::Skip => return,
        Restart::GiveUp(why) => {
            eprintln!("[session] the system stopped the capture; giving up: {why}");
            peer.close();
            end_session(core, hooks, id, &mut on);
            return;
        }
        Restart::Go(size, bitrate, n) => (size, bitrate, n),
    };
    println!("[session] the system stopped the capture; restarting at {}x{} ({n}/{RESTARTS_MAX})", size.w, size.h);
    *on = true;
    if let Err(e) = core.parts.capture.start(size, bitrate, hooks.target(peer)) {
        eprintln!("[session] the system stopped the capture; giving up: it did not restart: {e}");
        peer.close();
        end_session(core, hooks, id, &mut on);
        return;
    }
    after_start(core, hooks, id, (size, bitrate), &mut on);
    // The picture is of another size now: the page needs a keyframe of it at once.
    if core.slot.is_current(id) {
        core.parts.capture.request_keyframe();
    }
}

/// When a session's capture was restarted after the system stopped it.
#[derive(Default)]
struct RestartBudget(VecDeque<Instant>);
impl RestartBudget {
    /// Counts a restart at `now`: its number among those of the last `RESTARTS_WITHIN`, or
    /// `None` (nothing counted) when that would be more than `RESTARTS_MAX`.
    fn take(&mut self, now: Instant) -> Option<usize> {
        self.0.retain(|&at| now.saturating_duration_since(at) < RESTARTS_WITHIN);
        if self.0.len() >= RESTARTS_MAX {
            return None;
        }
        self.0.push_back(now);
        Some(self.0.len())
    }
}

/// Where a session's capture sends its frames: to its peer, which the session also asks what
/// to do when the system stops the stream.
struct SessionTarget {
    peer: PeerHandle,
    hooks: Weak<Hooks>,
}
impl FrameTarget for SessionTarget {
    fn send_frame(&self, frame: EncodedFrame) -> bool {
        self.peer.send_frame(frame)
    }
    fn stream_stopped(&self) {
        // Called on ScreenCaptureKit's delegate thread: the restart gets a thread of its own.
        match self.hooks.upgrade() {
            Some(hooks) => {
                std::thread::spawn(move || restart_capture(&hooks));
            }
            None => self.peer.close(),
        }
    }
}

impl Hooks {
    fn target(&self, peer: &PeerHandle) -> Arc<dyn FrameTarget> {
        Arc::new(SessionTarget { peer: peer.clone(), hooks: self.me.clone() })
    }
}

impl Backend for Sessions {
    fn status(&self) -> Status {
        let parts = &self.core.parts;
        Status {
            screen: screen_of(parts.platform.screen_recording_granted(), parts.capture.suspect()),
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
        self.status().gate(core.refuse_when_locked).map_err(SessionFailure::Gate)?;
        let wake = parts.platform.wake_display();
        let display_px = parts.platform.native_pixels().unwrap_or(FALLBACK_DISPLAY);
        let size = fit_to_display(request.size, display_px);
        let cap = bitrate_cap(size);
        let controller = BitrateController::new(cap);
        let params = PeerParams { bind_ip: parts.bind, initial_bitrate: controller.current(), desired_bitrate: cap };
        let hooks = Arc::new_cyclic(|me| Hooks {
            core: core.clone(),
            id: AtomicU64::new(0),
            controller: Mutex::new(controller),
            display_px: Mutex::new(display_px),
            requested: Mutex::new(request.size),
            size: Mutex::new(size),
            restarts: Mutex::new(RestartBudget::default()),
            clip: Mutex::new(ClipState::new()),
            peer: OnceLock::new(),
            me: me.clone(),
            ticking: AtomicBool::new(false),
        });
        // The offer is accepted before anything else changes: a bad offer must not end a good session.
        let (answer, peer) = (parts.accept)(&request.sdp, params, hooks.clone())
            .map_err(|e| SessionFailure::BadOffer(format!("{e:#}")))?;
        // Known before the session is installed, so no hook can find it missing.
        let _ = hooks.peer.set(peer.clone());
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
    use crate::clipboard::{Access, FakeBoard, PasteRead};
    use crate::frame::EncodedFrame;
    use crate::peer::QueueProbe;
    use crate::status::{Gate, Screen};
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
        /// What the capture is doing now: `None` stopped, else the size it was last started at.
        running: Mutex<Option<Size>>,
        /// Starts and stops in progress; more than one at a time is a bug in the caller.
        busy: AtomicUsize,
        overlapped: AtomicBool,
        /// Where the capture was last told to send its frames (what the real one keeps).
        target: Mutex<Option<Arc<dyn FrameTarget>>>,
    }
    impl FakeCapture {
        fn enter(&self) {
            if self.busy.fetch_add(1, SeqCst) > 0 {
                self.overlapped.store(true, SeqCst);
            }
        }
    }
    impl Capture for Arc<FakeCapture> {
        fn start(&self, size: Size, bitrate: u32, target: Arc<dyn FrameTarget>) -> Result<(), String> {
            self.enter();
            let delay = *self.start_delay.lock().unwrap();
            std::thread::sleep(delay);
            self.log.add(format!("start {}x{} {bitrate}", size.w, size.h));
            let result = if self.fail_start.load(SeqCst) {
                Err("no displays".into())
            } else {
                *self.running.lock().unwrap() = Some(size);
                *self.target.lock().unwrap() = Some(target);
                Ok(())
            };
            self.busy.fetch_sub(1, SeqCst);
            result
        }
        fn resize(&self, size: Size, cap: u32) -> Result<(), String> {
            self.log.add(format!("resize {}x{} {cap}", size.w, size.h));
            Ok(())
        }
        fn stop(&self) {
            self.enter();
            self.log.add("stop");
            *self.running.lock().unwrap() = None;
            self.busy.fetch_sub(1, SeqCst);
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
        fn type_keys(&self, text: &str) {
            self.0.add(format!("type_keys {} chars", text.chars().count()));
        }
    }

    struct FakePlatform {
        screen: AtomicBool,
        accessibility: AtomicBool,
        locked: AtomicBool,
        /// What the display's current mode is, in pixels.
        native: Mutex<Size>,
        wakes_held: Arc<AtomicUsize>,
        board: FakeBoard,
    }
    struct WakeGuard(Arc<AtomicUsize>);
    impl Drop for WakeGuard {
        fn drop(&mut self) {
            self.0.fetch_sub(1, SeqCst);
        }
    }
    impl Board for Arc<FakePlatform> {
        fn change_count(&self) -> i64 {
            self.board.change_count()
        }
        fn access(&self) -> Access {
            self.board.access()
        }
        fn read(&self) -> PasteRead {
            self.board.read()
        }
        fn write(&self, text: &str, concealed: bool) -> i64 {
            self.board.write(text, concealed)
        }
        fn console_locked(&self) -> bool {
            self.board.console_locked()
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
            Some(*self.native.lock().unwrap())
        }
        fn wake_display(&self) -> Box<dyn Any + Send> {
            self.wakes_held.fetch_add(1, SeqCst);
            Box::new(WakeGuard(self.wakes_held.clone()))
        }
    }

    #[test]
    fn the_fake_platform_is_a_board_driven_through_its_fake_board() {
        let platform = Arc::new(FakePlatform {
            screen: AtomicBool::new(true),
            accessibility: AtomicBool::new(true),
            locked: AtomicBool::new(false),
            native: Mutex::new(Size { w: 2560, h: 1440 }),
            wakes_held: Arc::new(AtomicUsize::new(0)),
            board: FakeBoard::default(),
        });
        let as_platform: &dyn Platform = &platform;
        let before = as_platform.change_count();
        assert_eq!(as_platform.write("a", false), before + 1);
        assert_eq!(platform.board.writes(), vec![("a".to_string(), false)]);
        platform.board.set_locked(true);
        assert!(as_platform.console_locked());
        assert!(!as_platform.screen_locked(), "the console lock is a separate signal from the CGS one");
    }

    type Peers = Arc<Mutex<Vec<(Arc<dyn PeerHooks>, PeerHandle, String)>>>;

    /// The test's grip on one agent: fakes for everything outside it, and the hooks of every
    /// peer it accepted (a test calls them the way the peer thread would).
    struct Rig {
        agent: Sessions,
        log: Arc<Log>,
        capture: Arc<FakeCapture>,
        platform: Arc<FakePlatform>,
        peers: Peers,
        /// The frame queue of every peer accepted, in the order of `peers`.
        queues: Arc<Mutex<Vec<QueueProbe>>>,
        /// What every accepted peer was asked to be built with.
        params: Arc<Mutex<Vec<PeerParams>>>,
    }

    fn rig() -> Rig {
        build_rig(None, clipboard::POLL)
    }

    /// An agent whose sessions look at the lock and the pasteboard every few milliseconds.
    fn rig_polling() -> Rig {
        build_rig(None, Duration::from_millis(5))
    }

    /// An agent whose lock-screen switch is set by the test instead of by P1's constant.
    fn rig_with_lock_policy(refuse_when_locked: bool) -> Rig {
        build_rig(Some(refuse_when_locked), clipboard::POLL)
    }

    fn build_rig(lock_policy: Option<bool>, poll: Duration) -> Rig {
        let log = Arc::new(Log::default());
        let capture = Arc::new(FakeCapture {
            log: log.clone(),
            fail_start: AtomicBool::new(false),
            start_delay: Mutex::new(Duration::ZERO),
            suspect: AtomicBool::new(false),
            last_capture: Mutex::new(None),
            running: Mutex::new(None),
            busy: AtomicUsize::new(0),
            overlapped: AtomicBool::new(false),
            target: Mutex::new(None),
        });
        let platform = Arc::new(FakePlatform {
            screen: AtomicBool::new(true),
            accessibility: AtomicBool::new(true),
            locked: AtomicBool::new(false),
            native: Mutex::new(Size { w: 2560, h: 1440 }),
            wakes_held: Arc::new(AtomicUsize::new(0)),
            board: FakeBoard::default(),
        });
        let peers: Peers = Arc::default();
        let queues: Arc<Mutex<Vec<QueueProbe>>> = Arc::default();
        let params: Arc<Mutex<Vec<PeerParams>>> = Arc::default();
        let (recorded, recorded_queues, recorded_params) = (peers.clone(), queues.clone(), params.clone());
        let accept_log = log.clone();
        let accept: Accept = Box::new(move |sdp, peer_params, hooks| {
            accept_log.add("accept");
            if !sdp.starts_with("v=0 offer") {
                anyhow::bail!("bad offer");
            }
            let (handle, queue) = PeerHandle::observed(8);
            recorded_params.lock().unwrap().push(peer_params);
            recorded_queues.lock().unwrap().push(queue);
            recorded.lock().unwrap().push((hooks, handle.clone(), sdp.to_string()));
            Ok(("v=0 answer".to_string(), handle))
        });
        let parts = Parts {
            bind: "127.0.0.1".parse().unwrap(),
            platform: Box::new(platform.clone()),
            capture: Box::new(capture.clone()),
            input: Box::new(FakeInput(log.clone())),
            accept,
        };
        let agent = match lock_policy {
            None if poll == clipboard::POLL => Sessions::new(parts),
            None => Sessions::with_options(parts, REFUSE_WHEN_LOCKED, poll),
            Some(refuse) => Sessions::with_options(parts, refuse, poll),
        };
        Rig { agent, log, capture, platform, peers, queues, params }
    }

    impl Rig {
        /// What peer number `peer` (in the order accepted) was asked to send since the last call.
        fn texts(&self, peer: usize) -> Vec<String> {
            self.queues.lock().unwrap()[peer].texts()
        }
        fn offer(&self) -> SessionRequest {
            self.offer_of_width(1280)
        }
        /// A 16:9 request of the given width; the offer text carries the width so a test can
        /// tell which offer a peer was made for.
        fn offer_of_width(&self, w: u32) -> SessionRequest {
            SessionRequest { size: Size { w, h: w * 9 / 16 }, sdp: format!("v=0 offer {w}") }
        }
        /// A new session; returns the hooks and the handle of the peer it was given.
        fn open(&self) -> (Arc<dyn PeerHooks>, PeerHandle) {
            assert!(self.agent.start_session(self.offer()).is_ok(), "the session was refused");
            self.peers.lock().unwrap().last().cloned().map(|(hooks, peer, _)| (hooks, peer)).unwrap()
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
    fn with_the_switch_on_a_locked_screen_refuses_with_locked_and_permission_wins_over_it() {
        let rig = rig_with_lock_policy(true);
        rig.platform.locked.store(true, SeqCst);
        assert_eq!(refused(rig.agent.start_session(rig.offer())), Gate::Locked);
        rig.platform.screen.store(false, SeqCst);
        assert_eq!(refused(rig.agent.start_session(rig.offer())), Gate::Permission);
        assert!(rig.log.all().is_empty());
    }

    #[test]
    fn with_the_switch_off_a_locked_screen_starts_a_session_and_permission_still_refuses() {
        let rig = rig_with_lock_policy(false);
        rig.platform.locked.store(true, SeqCst);
        assert!(rig.agent.status().locked, "the status still reports the lock");
        assert!(rig.agent.start_session(rig.offer()).is_ok(), "a locked screen refused the session");
        rig.settle(|log| log.count("start") == 1);
        rig.platform.screen.store(false, SeqCst);
        assert_eq!(refused(rig.agent.start_session(rig.offer())), Gate::Permission);
    }

    #[test]
    fn the_agent_is_built_with_the_p1_switch_as_it_stands() {
        // Whichever way P1 sets `REFUSE_WHEN_LOCKED`, `Sessions::new` must pass it on.
        let rig = rig();
        rig.platform.locked.store(true, SeqCst);
        let result = rig.agent.start_session(rig.offer());
        assert_eq!(result.is_err(), REFUSE_WHEN_LOCKED, "Sessions::new must pass the constant on");
        assert!(result.is_ok(), "P1 (2026-10-16): the lock screen is unlocked through the agent");
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
        // 1280x720 on a 2560x1440 screen: the same aspect, so exactly the request; it begins at the 20 Mbps ceiling.
        assert!(rig.log.all().contains(&"start 1280x720 20000000".to_string()), "{:?}", rig.log.all());
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
            display_px: Mutex::new(Size { w: 2560, h: 1440 }),
            requested: Mutex::new(Size { w: 1280, h: 720 }),
            size: Mutex::new(Size { w: 1280, h: 720 }),
            restarts: Mutex::new(RestartBudget::default()),
            clip: Mutex::new(ClipState::new()),
            peer: OnceLock::new(),
            me: Weak::new(),
            ticking: AtomicBool::new(false),
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
    fn a_silent_peer_has_its_keys_released_and_its_session_stays_up() {
        let rig = rig();
        let (hooks, peer) = rig.open();
        rig.settle(|log| log.count("start") == 1);
        let released = rig.log.count("release_all");
        hooks.silent();
        assert_eq!(rig.log.count("release_all"), released + 1);
        assert!(peer.is_alive());
        assert_eq!(rig.log.count("stop"), 0);
    }

    #[test]
    fn a_replaced_sessions_silence_releases_nothing_of_the_new_session() {
        let rig = rig();
        let (old_hooks, _old) = rig.open();
        rig.settle(|log| log.count("start") == 1);
        rig.open();
        rig.settle(|log| log.count("start") == 2);
        let released = rig.log.count("release_all");
        old_hooks.silent();
        assert_eq!(rig.log.count("release_all"), released, "the new session's held keys stay down");
    }

    #[test]
    fn a_take_over_closes_the_old_peer_as_replaced_and_only_that() {
        let rig = rig();
        let (_old_hooks, old) = rig.open();
        rig.settle(|log| log.count("start") == 1);
        assert!(!old.is_replaced());
        let (_new_hooks, new) = rig.open();
        assert!(!old.is_alive() && old.is_replaced(), "the old session is told it was replaced");
        assert!(new.is_alive() && !new.is_replaced());
    }

    #[test]
    fn a_size_message_resizes_the_stream_to_the_fitted_size_and_ceiling() {
        let rig = rig();
        let (hooks, _peer) = rig.open();
        rig.settle(|log| log.count("start") == 1);
        // 1500x900 on a 2560x1440 screen: the screen's aspect ratio (16:9), even sides.
        hooks.input(br#"{"type":"size","w":1500,"h":900}"#);
        assert!(rig.log.all().contains(&"resize 1500x842 20000000".to_string()), "{:?}", rig.log.all());
        // Out of range sizes never reach the capture.
        hooks.input(br#"{"type":"size","w":100,"h":100}"#);
        assert_eq!(rig.log.count("resize"), 1);
    }

    #[test]
    fn a_resize_that_arrives_before_the_capture_starts_is_not_lost() {
        let rig = rig();
        *rig.capture.start_delay.lock().unwrap() = Duration::from_millis(300);
        let (hooks, _peer) = rig.open();
        std::thread::sleep(Duration::from_millis(60)); // the start has read the size it begins with
        hooks.input(br#"{"type":"size","w":1920,"h":1080}"#);
        rig.settle(|log| log.count("start") == 1);
        // The start used the size known when it began; the page's size is applied right after.
        rig.settle(|log| log.all().last().is_some_and(|l| l == "resize 1920x1080 20000000"));
        let log = rig.log.all();
        let started = log.iter().position(|l| l.starts_with("start")).unwrap();
        assert!(log.iter().rposition(|l| l.starts_with("resize")).unwrap() > started, "{log:?}");
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
            display_px: Mutex::new(Size { w: 2560, h: 1440 }),
            requested: Mutex::new(Size { w: 1280, h: 720 }),
            size: Mutex::new(Size { w: 1280, h: 720 }),
            restarts: Mutex::new(RestartBudget::default()),
            clip: Mutex::new(ClipState::new()),
            peer: OnceLock::new(),
            me: Weak::new(),
            ticking: AtomicBool::new(false),
        };
        begin_capture(&core, &late, 1, &peer);
        assert_eq!(rig.log.count("start"), 1, "no second start for a dead peer");
        assert_eq!(rig.log.count("stop"), 1, "the capture of the dead session is stopped");
        assert!(core.slot.is_empty());
    }

    #[test]
    fn a_slow_capture_start_blocks_neither_a_takeover_answer_nor_the_hooks() {
        let rig = rig();
        *rig.capture.start_delay.lock().unwrap() = Duration::from_millis(1000);
        let (first_hooks, first) = rig.open();
        std::thread::sleep(Duration::from_millis(100)); // its capture start is under way
        *rig.capture.start_delay.lock().unwrap() = Duration::ZERO;

        // The first session's own peer thread keeps working while its capture starts.
        let began = Instant::now();
        first_hooks.input(KEY_A);
        first_hooks.estimate(3_000_000);
        first_hooks.request_keyframe();
        assert!(began.elapsed() < Duration::from_millis(300), "the hooks waited: {:?}", began.elapsed());
        assert_eq!(rig.log.count("input"), 1);

        // And a takeover is answered at once, not after the first start.
        let began = Instant::now();
        let answer = rig.agent.start_session(rig.offer_of_width(1920));
        assert!(answer.is_ok());
        assert!(began.elapsed() < Duration::from_millis(400), "the takeover waited: {:?}", began.elapsed());
        assert!(!first.is_alive());
        assert_eq!(rig.log.count("start"), 0, "the first start was still running");

        // Afterwards exactly one capture runs, for the session that took over.
        rig.settle(|log| log.count("start") == 2);
        assert_eq!(rig.log.count("stop"), 0);
        assert_eq!(*rig.capture.running.lock().unwrap(), Some(Size { w: 1920, h: 1080 }));
        assert!(!rig.capture.overlapped.load(SeqCst), "two capture starts or stops overlapped");
        assert_eq!(rig.platform.wakes_held.load(SeqCst), 1);
    }

    #[test]
    fn a_session_that_ends_during_a_slow_start_leaves_no_capture_running() {
        let rig = rig();
        *rig.capture.start_delay.lock().unwrap() = Duration::from_millis(500);
        let (hooks, _peer) = rig.open();
        std::thread::sleep(Duration::from_millis(100));
        // The peer thread's end waits for the start, then stops what it started.
        hooks.closed();
        assert_eq!(rig.log.count("start"), 1);
        rig.settle(|log| log.count("stop") == 1);
        assert_eq!(*rig.capture.running.lock().unwrap(), None);
        assert!(!rig.capture.overlapped.load(SeqCst));
    }

    #[test]
    fn two_offers_arriving_together_end_with_one_peer_one_wake_lock_and_one_capture() {
        for round in 0..5 {
            let rig = rig();
            *rig.capture.start_delay.lock().unwrap() = Duration::from_millis(40);
            let (a, b) = (rig.offer_of_width(1280), rig.offer_of_width(1920));
            std::thread::scope(|scope| {
                scope.spawn(|| assert!(rig.agent.start_session(a).is_ok()));
                scope.spawn(|| assert!(rig.agent.start_session(b).is_ok()));
            });
            // Wait for the capture work of both sessions to be over.
            rig.settle(|_| rig.capture.running.lock().unwrap().is_some());
            std::thread::sleep(Duration::from_millis(250));

            let peers = rig.peers.lock().unwrap().clone();
            let alive: Vec<_> = peers.iter().filter(|(_, peer, _)| peer.is_alive()).collect();
            assert_eq!(alive.len(), 1, "round {round}: exactly one live peer");
            assert_eq!(rig.platform.wakes_held.load(SeqCst), 1, "round {round}: one wake lock");
            assert!(!rig.capture.overlapped.load(SeqCst), "round {round}: capture operations overlapped");
            let width: u32 = alive[0].2.trim_start_matches("v=0 offer ").parse().unwrap();
            assert_eq!(
                rig.capture.running.lock().unwrap().map(|size| size.w),
                Some(width),
                "round {round}: the running capture is the live session's: {:?}",
                rig.log.all()
            );
            // A superseded start is re-targeted by its replacement, never left behind, and no
            // stop was needed while a session was always installed.
            let starts = rig.log.count("start");
            assert!((1..=2).contains(&starts) && rig.log.count("stop") == 0, "round {round}: {:?}", rig.log.all());
        }
    }

    #[test]
    fn the_peer_is_built_for_the_bound_address_the_start_rate_and_the_streams_ceiling() {
        let rig = rig();
        rig.open();
        rig.settle(|log| log.count("start") == 1);
        // A request larger than the screen is fitted to it: 2560x1440 gets the 1440p ceiling.
        assert!(rig.agent.start_session(rig.offer_of_width(3200)).is_ok());
        let params = rig.params.lock().unwrap().clone();
        assert_eq!(params.len(), 2);
        for p in &params {
            assert_eq!(p.bind_ip, rig.agent.core.parts.bind, "the media socket is bound to the agent's own address");
            assert_eq!(p.initial_bitrate, p.desired_bitrate, "a session starts at its ceiling");
        }
        assert_eq!(params[0].desired_bitrate, 20_000_000, "1280x720");
        assert_eq!(params[1].desired_bitrate, 20_000_000, "fitted to the screen first: 2560x1440");
    }

    #[test]
    fn frames_from_the_capture_reach_the_current_sessions_peer_and_after_a_takeover_only_the_new_one() {
        let rig = rig();
        rig.open();
        rig.settle(|log| log.count("start") == 1);
        let frame = |tag: u8| EncodedFrame { data: vec![tag], key: true, submitted: Instant::now() };
        let first = rig.capture.target.lock().unwrap().clone().expect("the capture was given a target");
        assert!(first.send_frame(frame(1)), "the live peer takes the frame");
        {
            let queues = rig.queues.lock().unwrap();
            assert_eq!(queues[0].frames(), vec![vec![1u8]], "the frame is in the first session's queue");
        }

        // A takeover re-targets the capture: its frames go to the new peer and not the old one.
        rig.open();
        rig.settle(|log| log.count("start") == 2);
        let second = rig.capture.target.lock().unwrap().clone().expect("a target");
        assert!(second.send_frame(frame(2)));
        let queues = rig.queues.lock().unwrap();
        assert_eq!(queues[1].frames(), vec![vec![2u8]], "the frame reaches the new session's peer");
        assert!(queues[0].frames().is_empty(), "and nothing reaches the replaced one");
        // The old target, if something still held it, finds a closed peer and says so.
        assert!(!first.send_frame(frame(3)), "a frame for the replaced peer is refused so the sender drops it");
        assert!(queues[0].frames().is_empty());
    }

    // ---- the system stops the capture stream ----

    impl Rig {
        /// A session asking for 4K, on the 2560x1440 display the fake platform starts with.
        fn open_wide(&self) -> (Arc<dyn PeerHooks>, PeerHandle) {
            assert!(self.agent.start_session(self.offer_of_width(3840)).is_ok(), "the session was refused");
            self.peers.lock().unwrap().last().cloned().map(|(hooks, peer, _)| (hooks, peer)).unwrap()
        }
        /// The system stops the stream, as the pipeline tells whatever target the capture holds.
        fn stopped_by_the_system(&self) {
            let target = self.capture.target.lock().unwrap().clone().expect("the capture was given a target");
            target.stream_stopped();
        }
        /// Gives the threads a restart may be running on time to (wrongly) act.
        fn quiet(&self) {
            std::thread::sleep(Duration::from_millis(150));
        }
    }

    #[test]
    fn a_stream_the_system_stopped_restarts_at_the_displays_new_size_and_the_session_stays() {
        let rig = rig();
        let (hooks, peer) = rig.open_wide();
        rig.settle(|log| log.count("start") == 1);
        assert!(rig.log.all().contains(&"start 2560x1440 20000000".to_string()), "{:?}", rig.log.all());
        // The display came up in a transient mode and has now moved to its real one.
        *rig.platform.native.lock().unwrap() = Size { w: 3840, h: 2160 };
        rig.stopped_by_the_system();
        rig.settle(|log| log.count("start") == 2);
        rig.settle(|log| log.all().last().is_some_and(|l| l == "keyframe"));
        let log = rig.log.all();
        assert_eq!(log.iter().filter(|l| l.starts_with("start 3840x2160 ")).count(), 1, "{log:?}");
        assert_eq!(rig.log.count("stop"), 0, "the capture is restarted, not stopped: {log:?}");
        assert!(peer.is_alive(), "the session stays");
        assert!(rig.agent.core.slot.is_current(1));
        assert_eq!(*rig.capture.running.lock().unwrap(), Some(Size { w: 3840, h: 2160 }));
        assert_eq!(rig.platform.wakes_held.load(SeqCst), 1, "the display stays awake for the session");
        // The page's next size message is fitted to the new display, not the one at session start.
        hooks.input(br#"{"type":"size","w":3840,"h":2160}"#);
        assert!(rig.log.all().contains(&"resize 3840x2160 35000000".to_string()), "{:?}", rig.log.all());
    }

    #[test]
    fn a_restart_follows_a_display_that_got_smaller_and_what_the_page_asked_for() {
        let rig = rig();
        let (hooks, peer) = rig.open_wide();
        rig.settle(|log| log.count("start") == 1);
        hooks.input(br#"{"type":"size","w":1920,"h":1080}"#);
        *rig.platform.native.lock().unwrap() = Size { w: 1280, h: 720 };
        rig.stopped_by_the_system();
        rig.settle(|log| log.count("start") == 2);
        assert!(rig.log.all().contains(&"start 1280x720 20000000".to_string()), "{:?}", rig.log.all());
        *rig.platform.native.lock().unwrap() = Size { w: 3840, h: 2160 };
        rig.stopped_by_the_system();
        rig.settle(|log| log.count("start") == 3);
        assert!(
            rig.log.all().contains(&"start 1920x1080 20000000".to_string()),
            "the page's request, not the smaller display, sets the size once the display is big again: {:?}",
            rig.log.all()
        );
        assert!(peer.is_alive());
    }

    #[test]
    fn more_than_three_stops_in_a_minute_end_the_session_as_before() {
        let rig = rig();
        let (hooks, peer) = rig.open();
        rig.settle(|log| log.count("start") == 1);
        for n in 2..=4 {
            rig.stopped_by_the_system();
            rig.settle(|log| log.count("start") == n);
            assert!(peer.is_alive(), "restart {} of 3 keeps the session", n - 1);
        }
        rig.stopped_by_the_system();
        rig.settle(|log| log.count("stop") == 1);
        assert!(!peer.is_alive(), "the fourth stop closes the peer");
        assert_eq!(rig.log.count("start"), 4, "no fifth start");
        assert!(rig.agent.core.slot.is_empty(), "the session is finished");
        assert_eq!(*rig.capture.running.lock().unwrap(), None, "nothing is left capturing");
        assert!(rig.log.count("release_all") >= 2, "{:?}", rig.log.all());
        hooks.closed(); // the peer thread's own end changes nothing more
        assert_eq!(rig.log.count("stop"), 1);
        assert_eq!(rig.platform.wakes_held.load(SeqCst), 0);
    }

    #[test]
    fn a_restart_that_fails_ends_the_session_and_leaves_nothing_capturing() {
        let rig = rig();
        let (_hooks, peer) = rig.open();
        rig.settle(|log| log.count("start") == 1);
        rig.capture.fail_start.store(true, SeqCst);
        rig.stopped_by_the_system();
        rig.settle(|log| log.count("stop") == 1);
        assert!(!peer.is_alive());
        assert!(rig.agent.core.slot.is_empty());
        assert_eq!(*rig.capture.running.lock().unwrap(), None);
        assert_eq!(rig.log.count("start"), 2, "one failed restart and no retry");
        assert_eq!(rig.platform.wakes_held.load(SeqCst), 0);
        assert!(!rig.capture.overlapped.load(SeqCst));
    }

    #[test]
    fn with_the_permission_gone_a_stopped_stream_ends_the_session_without_a_restart() {
        let rig = rig();
        let (_hooks, peer) = rig.open();
        rig.settle(|log| log.count("start") == 1);
        rig.platform.screen.store(false, SeqCst);
        rig.stopped_by_the_system();
        rig.settle(|log| log.count("stop") == 1);
        assert!(!peer.is_alive());
        assert_eq!(rig.log.count("start"), 1);
        assert!(rig.agent.core.slot.is_empty());
        assert_eq!(*rig.capture.running.lock().unwrap(), None);
    }

    #[test]
    fn a_stop_that_comes_after_the_session_ended_starts_no_capture() {
        let rig = rig();
        let (hooks, peer) = rig.open();
        rig.settle(|log| log.count("start") == 1);
        let target = rig.capture.target.lock().unwrap().clone().unwrap();
        peer.close();
        hooks.closed(); // the peer thread's end: the session is finished and the capture stopped
        assert_eq!(rig.log.count("stop"), 1);
        target.stream_stopped();
        rig.quiet();
        assert_eq!(rig.log.count("start"), 1, "{:?}", rig.log.all());
        assert_eq!(*rig.capture.running.lock().unwrap(), None);
    }

    #[test]
    fn a_stop_of_a_replaced_sessions_stream_restarts_nothing_for_it() {
        let rig = rig();
        let (_first_hooks, first) = rig.open();
        rig.settle(|log| log.count("start") == 1);
        let old_target = rig.capture.target.lock().unwrap().clone().unwrap();
        let (_second_hooks, second) = rig.open();
        rig.settle(|log| log.count("start") == 2);
        old_target.stream_stopped();
        rig.quiet();
        assert_eq!(rig.log.count("start"), 2, "{:?}", rig.log.all());
        assert!(!first.is_alive() && second.is_alive(), "the new session is untouched");
        assert_eq!(rig.log.count("stop"), 0);
        assert!(rig.capture.running.lock().unwrap().is_some());
    }

    #[test]
    fn the_restart_budget_allows_three_in_a_minute_and_counts_only_the_last_minute() {
        let mut budget = RestartBudget::default();
        let t0 = Instant::now();
        assert_eq!(budget.take(t0), Some(1));
        assert_eq!(budget.take(t0 + Duration::from_secs(20)), Some(2));
        assert_eq!(budget.take(t0 + Duration::from_secs(59)), Some(3));
        assert_eq!(budget.take(t0 + Duration::from_secs(59)), None, "the fourth within a minute");
        assert_eq!(budget.take(t0 + Duration::from_secs(60)), Some(3), "the first has aged out");
    }

    // ---- clipboard sync and lock notices ----

    const CMD_DOWN: &[u8] = br#"{"type":"key","code":"MetaLeft","down":true}"#;
    const CMD_UP: &[u8] = br#"{"type":"key","code":"MetaLeft","down":false}"#;
    const V_DOWN: &[u8] = br#"{"type":"key","code":"KeyV","down":true}"#;
    const V_UP: &[u8] = br#"{"type":"key","code":"KeyV","down":false}"#;

    fn clipboard_message(text: &str) -> Vec<u8> {
        format!(r#"{{"type":"clipboard","text":"{text}","concealed":false}}"#).into_bytes()
    }

    /// Collects what the peer was asked to send until `done` holds of it all, or gives up.
    fn texts_until(rig: &Rig, peer: usize, done: impl Fn(&[String]) -> bool) -> Vec<String> {
        let mut seen = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            seen.extend(rig.texts(peer));
            if done(&seen) {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        seen
    }

    /// Lets the ticker run for a while and returns everything it sent meanwhile.
    fn texts_after_a_while(rig: &Rig, peer: usize) -> Vec<String> {
        std::thread::sleep(Duration::from_millis(150));
        rig.texts(peer)
    }

    /// How many times the fake input was asked to post the V key.
    fn injected_vs(log: &Log) -> usize {
        log.all().iter().filter(|l| l.starts_with("input") && l.contains("Code(9)")).count()
    }

    #[test]
    fn the_channel_opening_sends_the_lock_state_once() {
        let rig = rig_polling();
        let (hooks, _peer) = rig.open();
        assert!(rig.texts(0).is_empty(), "nothing is sent before the channel is open");
        hooks.channel_open();
        assert_eq!(rig.texts(0), vec![protocol::lock_notice(false)]);
        assert!(texts_after_a_while(&rig, 0).is_empty(), "a tick with no change sends nothing");
    }

    #[test]
    fn a_reopened_channel_is_told_the_lock_state_again() {
        let rig = rig_polling();
        let (hooks, _peer) = rig.open();
        hooks.channel_open();
        assert_eq!(rig.texts(0), vec![protocol::lock_notice(false)]);
        hooks.channel_open(); // the channel closed and opened again: the page has forgotten
        assert_eq!(rig.texts(0), vec![protocol::lock_notice(false)], "announced again on the second opening");
        assert!(texts_after_a_while(&rig, 0).is_empty());
    }

    #[test]
    fn the_end_of_a_session_drops_the_text_it_held() {
        let rig = rig();
        // A session's hooks built by hand, so its clipboard state can be looked at.
        let own = Hooks {
            core: rig.agent.core.clone(),
            id: AtomicU64::new(0),
            controller: Mutex::new(BitrateController::new(12_000_000)),
            display_px: Mutex::new(Size { w: 2560, h: 1440 }),
            requested: Mutex::new(Size { w: 1280, h: 720 }),
            size: Mutex::new(Size { w: 1280, h: 720 }),
            restarts: Mutex::new(RestartBudget::default()),
            clip: Mutex::new(ClipState::new()),
            peer: OnceLock::new(),
            me: Weak::new(),
            ticking: AtomicBool::new(false),
        };
        rig.platform.board.set_locked(true);
        own.clip().inbound(&rig.platform.board, "pw", false);
        assert_eq!(own.clip().held_text(), Some("pw"), "the text is held on the locked console");
        own.closed();
        assert_eq!(own.clip().held_text(), None, "the session's end took the held text with it");
    }

    #[test]
    fn a_lock_change_is_sent_once_within_one_poll() {
        let rig = rig_polling();
        let (hooks, _peer) = rig.open();
        hooks.channel_open();
        rig.texts(0);
        rig.platform.board.set_locked(true);
        let seen = texts_until(&rig, 0, |seen| !seen.is_empty());
        assert_eq!(seen, vec![protocol::lock_notice(true)]);
        assert!(texts_after_a_while(&rig, 0).is_empty(), "exactly one notice");
        rig.platform.board.set_locked(false);
        assert_eq!(texts_until(&rig, 0, |seen| !seen.is_empty()), vec![protocol::lock_notice(false)]);
    }

    #[test]
    fn a_lock_notice_the_peer_could_not_take_is_sent_again() {
        let rig = rig_polling();
        let (hooks, peer) = rig.open();
        for i in 0..8 {
            assert!(peer.send_text(format!("filler {i}")), "the text queue holds 8");
        }
        hooks.channel_open(); // the lock notice finds the queue full
        let mut seen = rig.texts(0);
        assert_eq!(seen.len(), 8);
        seen = texts_until(&rig, 0, |seen| !seen.is_empty());
        assert_eq!(seen, vec![protocol::lock_notice(false)], "announced again at the next tick");
        assert!(texts_after_a_while(&rig, 0).is_empty());
    }

    #[test]
    fn watch_on_then_a_pasteboard_change_sends_the_text_and_watch_off_stops_reading() {
        let rig = rig_polling();
        let (hooks, _peer) = rig.open();
        hooks.channel_open();
        rig.texts(0);
        hooks.input(br#"{"type":"clipboard-watch","on":true}"#);
        rig.platform.board.set_read(PasteRead::Text { text: "from the mac".into(), concealed: false });
        rig.platform.board.bump();
        let seen = texts_until(&rig, 0, |seen| !seen.is_empty());
        assert_eq!(seen, vec![protocol::clipboard_notice("from the mac", false)]);
        hooks.input(br#"{"type":"clipboard-watch","on":false}"#);
        let reads = rig.platform.board.reads();
        rig.platform.board.bump();
        assert!(texts_after_a_while(&rig, 0).is_empty());
        assert_eq!(rig.platform.board.reads(), reads, "no read while the page is not watching");
    }

    /// Runs `f` on another thread and says whether it finished within 2 s (so a deadlock fails the
    /// test instead of hanging it).
    fn finishes_quickly(f: impl FnOnce() + Send + 'static) -> bool {
        let (done, finished) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            f();
            let _ = done.send(());
        });
        finished.recv_timeout(Duration::from_secs(2)).is_ok()
    }

    #[test]
    fn a_pasteboard_read_stuck_on_an_alert_does_not_block_input() {
        let rig = rig_polling();
        let (hooks, _peer) = rig.open();
        hooks.channel_open();
        rig.texts(0);
        hooks.input(br#"{"type":"clipboard-watch","on":true}"#);
        rig.platform.board.set_read(PasteRead::Text { text: "after the alert".into(), concealed: false });
        rig.platform.board.hold_reads();
        rig.platform.board.bump();
        assert!(rig.platform.board.wait_for_blocked_read(), "the ticker never reached the read");
        // The user answers the alert through the very view this input comes from.
        let typed = Arc::clone(&hooks);
        assert!(finishes_quickly(move || typed.input(V_DOWN)), "input is stuck behind the blocked pasteboard read");
        assert_eq!(injected_vs(&rig.log), 1);
        rig.platform.board.release_reads();
        let seen = texts_until(&rig, 0, |seen| !seen.is_empty());
        assert_eq!(seen, vec![protocol::clipboard_notice("after the alert", false)]);
    }

    #[test]
    fn a_read_finished_after_the_page_wrote_or_stopped_watching_is_dropped() {
        for stop in ["page wrote", "watch off"] {
            let rig = rig_polling();
            let (hooks, _peer) = rig.open();
            hooks.channel_open();
            rig.texts(0);
            hooks.input(br#"{"type":"clipboard-watch","on":true}"#);
            rig.platform.board.set_read(PasteRead::Text { text: "stale".into(), concealed: false });
            rig.platform.board.hold_reads();
            rig.platform.board.bump();
            assert!(rig.platform.board.wait_for_blocked_read(), "{stop}");
            let same = Arc::clone(&hooks);
            let acted = if stop == "page wrote" {
                finishes_quickly(move || same.input(&clipboard_message("from the page")))
            } else {
                finishes_quickly(move || same.input(br#"{"type":"clipboard-watch","on":false}"#))
            };
            assert!(acted, "{stop}");
            rig.platform.board.release_reads();
            assert!(texts_after_a_while(&rig, 0).is_empty(), "{stop}: the old text must not be sent");
        }
    }

    #[test]
    fn an_old_page_that_never_sends_watch_never_has_its_pasteboard_read() {
        let rig = rig_polling();
        let (hooks, _peer) = rig.open();
        hooks.channel_open();
        rig.platform.board.set_read(PasteRead::Text { text: "private".into(), concealed: false });
        for _ in 0..10 {
            rig.platform.board.bump();
            std::thread::sleep(Duration::from_millis(12));
        }
        assert_eq!(rig.platform.board.reads(), 0);
        assert_eq!(rig.texts(0), vec![protocol::lock_notice(false)], "only the lock state was sent");
    }

    #[test]
    fn a_clipboard_message_is_written_when_unlocked_and_held_when_locked() {
        let rig = rig();
        let (hooks, _peer) = rig.open();
        hooks.input(&clipboard_message("open"));
        assert_eq!(rig.platform.board.writes(), vec![("open".to_string(), false)]);
        rig.platform.board.set_locked(true);
        hooks.input(&clipboard_message("secret"));
        assert_eq!(rig.platform.board.writes().len(), 1, "nothing is written while locked");
    }

    #[test]
    fn locked_command_v_types_held_text_and_injects_no_v() {
        let rig = rig();
        let (hooks, _peer) = rig.open();
        rig.platform.board.set_locked(true);
        hooks.input(&clipboard_message("pw"));
        for key in [CMD_DOWN, V_DOWN, V_DOWN, V_UP, CMD_UP] {
            hooks.input(key);
        }
        assert_eq!(rig.log.count("type_keys"), 1, "typed once, not per autorepeat: {:?}", rig.log.all());
        assert_eq!(injected_vs(&rig.log), 0, "the V was swallowed: {:?}", rig.log.all());
        assert!(rig.texts(0).is_empty());
        assert!(rig.platform.board.writes().is_empty());

        // Multi-line text is not typed: the page is told, and V is not injected either.
        hooks.input(&clipboard_message("a\\nb"));
        for key in [CMD_DOWN, V_DOWN, V_UP, CMD_UP] {
            hooks.input(key);
        }
        assert_eq!(rig.log.count("type_keys"), 1);
        assert_eq!(injected_vs(&rig.log), 0);
        assert_eq!(rig.texts(0), vec![protocol::skipped_notice(protocol::SkipReason::LockedMultiline)]);
    }

    #[test]
    fn locked_command_v_with_nothing_held_injects_v_and_says_so_once() {
        let rig = rig();
        let (hooks, _peer) = rig.open();
        rig.platform.board.set_locked(true);
        for key in [CMD_DOWN, V_DOWN, V_DOWN, V_DOWN, V_UP, CMD_UP] {
            hooks.input(key);
        }
        assert_eq!(rig.log.count("type_keys"), 0);
        assert_eq!(injected_vs(&rig.log), 4, "every down and the up reach the Mac as before");
        assert_eq!(rig.texts(0), vec![protocol::skipped_notice(protocol::SkipReason::LockedEmpty)]);
    }

    #[test]
    fn held_text_is_dropped_on_unlock_replacement_and_session_end() {
        let rig = rig_polling();
        let paste = |hooks: &Arc<dyn PeerHooks>| {
            for key in [CMD_DOWN, V_DOWN, V_UP, CMD_UP] {
                hooks.input(key);
            }
        };
        rig.platform.board.set_locked(true);
        // Replacement.
        let (first, _) = rig.open();
        first.input(&clipboard_message("pw"));
        let (second, _) = rig.open();
        paste(&second);
        assert_eq!(rig.log.count("type_keys"), 0, "the new session holds nothing");
        // End.
        second.input(&clipboard_message("pw"));
        second.closed();
        let (third, _) = rig.open();
        paste(&third);
        assert_eq!(rig.log.count("type_keys"), 0);
        // Unlock, noticed by the ticker, then lock again.
        third.channel_open();
        third.input(&clipboard_message("pw"));
        rig.platform.board.set_locked(false);
        texts_until(&rig, 2, |seen| seen.contains(&protocol::lock_notice(false)));
        rig.platform.board.set_locked(true);
        texts_until(&rig, 2, |seen| seen.contains(&protocol::lock_notice(true)));
        paste(&third);
        assert_eq!(rig.log.count("type_keys"), 0, "unlocking dropped it");
        third.input(&clipboard_message("pw"));
        paste(&third);
        assert_eq!(rig.log.count("type_keys"), 1, "and text received now is held and typed");
    }

    #[test]
    fn a_replaced_session_sends_no_more_notices() {
        let rig = rig_polling();
        let (old, _peer) = rig.open();
        old.channel_open();
        rig.texts(0);
        rig.open();
        rig.platform.board.set_locked(true);
        old.input(&clipboard_message("late"));
        assert!(texts_after_a_while(&rig, 0).is_empty());
        assert!(rig.platform.board.writes().is_empty(), "and its messages go nowhere");
    }

    #[test]
    fn the_status_reports_version_0_2_0() {
        assert_eq!(rig().agent.status().version, "0.2.0");
    }

    #[test]
    fn release_and_a_closed_channel_forget_a_held_command() {
        let rig = rig();
        let (hooks, _peer) = rig.open();
        rig.platform.board.set_locked(true);
        hooks.input(&clipboard_message("pw"));
        let stuck_command_then = |forget: &dyn Fn()| {
            hooks.input(CMD_DOWN);
            forget();
            let typed = rig.log.count("type_keys");
            hooks.input(V_DOWN);
            hooks.input(V_UP);
            assert_eq!(rig.log.count("type_keys"), typed, "a forgotten Command no longer makes V a paste");
        };
        stuck_command_then(&|| hooks.input(br#"{"type":"release"}"#));
        stuck_command_then(&|| hooks.input_closed());
        stuck_command_then(&|| hooks.silent());
        // A swallowed V is forgotten too: the next Command+V decides again.
        hooks.input(CMD_DOWN);
        hooks.input(V_DOWN);
        assert_eq!(rig.log.count("type_keys"), 1);
        hooks.input_closed();
        hooks.input(CMD_DOWN);
        hooks.input(V_DOWN);
        assert_eq!(rig.log.count("type_keys"), 2);
    }
}
