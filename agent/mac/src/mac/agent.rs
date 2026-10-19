//! The agent proper on macOS: the real capture pipeline, event injection and system calls
//! plugged into `session::Sessions`, which holds the decisions (spec D5).
use super::inject::Injector;
use super::pasteboard::Pasteboard;
use super::pipeline::Pipeline;
use super::system;
use super::wake::WakeLock;
use crate::clipboard::{Access, Board, PasteRead};
use crate::frame::FrameTarget;
use crate::http::{Backend, SessionFailure, SessionRequest};
use crate::peer;
use crate::protocol::InputMsg;
use crate::session::{Capture, Input, Parts, Platform, Sessions};
use crate::size::Size;
use crate::status::{DisplayState, Status};
use std::any::Any;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

/// How long a session start waits for a sleeping display to wake (spec D3).
const DISPLAY_WAKE_WAIT: Duration = Duration::from_secs(3);

impl Capture for Pipeline {
    fn start(&self, size: Size, bitrate: u32, target: Arc<dyn FrameTarget>) -> Result<(), String> {
        Pipeline::start(self, size, bitrate, target)
    }
    fn resize(&self, size: Size, bitrate_cap: u32) -> Result<(), String> {
        Pipeline::resize(self, size, bitrate_cap)
    }
    fn stop(&self) {
        Pipeline::stop(self)
    }
    fn request_keyframe(&self) {
        Pipeline::request_keyframe(self)
    }
    fn set_bitrate(&self, bps: u32) {
        Pipeline::set_bitrate(self, bps)
    }
    fn suspect(&self) -> bool {
        Pipeline::suspect(self)
    }
    fn last_capture_at(&self) -> Option<u64> {
        Pipeline::last_capture_at(self)
    }
}

impl Input for Injector {
    fn handle(&self, message: InputMsg) {
        Injector::handle(self, message)
    }
    fn release_all(&self) {
        Injector::release_all(self)
    }
    fn type_keys(&self, text: &str) {
        Injector::type_keys(self, text)
    }
}

struct System {
    board: Pasteboard,
}

impl Board for System {
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
        system::console_locked()
    }
}

impl Platform for System {
    fn screen_recording_granted(&self) -> bool {
        system::screen_recording_granted()
    }
    fn accessibility_granted(&self) -> bool {
        system::accessibility_granted()
    }
    fn display_state(&self) -> DisplayState {
        system::display_state()
    }
    fn screen_locked(&self) -> bool {
        system::screen_locked()
    }
    fn native_pixels(&self) -> Option<Size> {
        system::native_pixels()
    }
    fn wake_display(&self) -> Box<dyn Any + Send> {
        let lock = WakeLock::acquire();
        if !WakeLock::wait_for_display(DISPLAY_WAKE_WAIT) {
            eprintln!("[session] the display did not wake within {DISPLAY_WAKE_WAIT:?}");
        }
        Box::new(lock)
    }
}

pub struct Agent {
    sessions: Sessions,
}

impl Agent {
    pub fn new(bind: IpAddr) -> Agent {
        Agent {
            sessions: Sessions::new(Parts {
                bind,
                platform: Box::new(System { board: Pasteboard::general() }),
                capture: Box::new(Pipeline::default()),
                input: Box::new(Injector::default()),
                accept: Box::new(peer::accept),
            }),
        }
    }
}

impl Backend for Agent {
    fn status(&self) -> Status {
        self.sessions.status()
    }
    fn start_session(&self, request: SessionRequest) -> Result<String, SessionFailure> {
        self.sessions.start_session(request)
    }
}
