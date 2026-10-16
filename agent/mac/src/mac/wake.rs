//! Waking the display and keeping it awake while somebody watches (spec D3).
use super::ffi::*;
use super::system::display_state;
use crate::status::DisplayState;
use std::time::{Duration, Instant};

/// Wakes a sleeping display and keeps it awake until dropped (spec D3). Without it a
/// session started while the display sleeps fails with "no displays".
pub struct WakeLock {
    id: u32,
}

impl WakeLock {
    pub fn acquire() -> WakeLock {
        const USER_ACTIVE_LOCAL: u32 = 0;
        const LEVEL_ON: u32 = 255;
        unsafe {
            let reason = cf_string("Gome Remote session");
            let mut activity = 0u32;
            let _ = IOPMAssertionDeclareUserActivity(reason.0, USER_ACTIVE_LOCAL, &mut activity);
            let kind = cf_string("PreventUserIdleDisplaySleep");
            let mut id = 0u32;
            let status = IOPMAssertionCreateWithName(kind.0, LEVEL_ON, reason.0, &mut id);
            if status != 0 {
                eprintln!("[system] IOPMAssertionCreateWithName: {status}");
            }
            WakeLock { id }
        }
    }

    /// Waits until the display reports awake, at most `limit`.
    pub fn wait_for_display(limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if display_state() == DisplayState::Ok {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        display_state() == DisplayState::Ok
    }
}

impl Drop for WakeLock {
    fn drop(&mut self) {
        if self.id != 0 {
            unsafe { IOPMAssertionRelease(self.id) };
        }
    }
}
