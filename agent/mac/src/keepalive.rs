//! When the capture side re-submits the last frame (spec D3, "정지 화면"). ScreenCaptureKit
//! only delivers a frame when the screen changes, so a static screen would send nothing.
//! The spike found that with a 1 s repeat 10-15 % of the first frames after a still period
//! sat 250-700 ms in Chrome's software decoder; a 100 ms repeat (about 10 tiny frames a
//! second, 0.35-0.9 Mbps) hides that. P2 may change the constant, nothing else.
use std::time::Duration;

pub const KEEPALIVE: Duration = Duration::from_millis(100);
/// A requested keyframe (new viewer, PLI/FIR) waits at most this long for a real frame
/// before the last one is re-encoded as a keyframe.
pub const KEYFRAME_WAIT: Duration = Duration::from_millis(40);

pub struct Ages {
    /// Since the last frame ScreenCaptureKit delivered.
    pub since_capture: Duration,
    /// Since the last time anything (captured or repeated) went to the encoder.
    pub since_submit: Duration,
    pub keyframe_pending: bool,
}

pub fn should_resubmit(ages: &Ages) -> bool {
    let age = ages.since_capture.min(ages.since_submit);
    (ages.keyframe_pending && age > KEYFRAME_WAIT) || age > KEEPALIVE
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ages(capture_ms: u64, submit_ms: u64, key: bool) -> Ages {
        Ages {
            since_capture: Duration::from_millis(capture_ms),
            since_submit: Duration::from_millis(submit_ms),
            keyframe_pending: key,
        }
    }

    #[test]
    fn a_busy_screen_never_repeats() {
        assert!(!should_resubmit(&ages(8, 8, false)));
        assert!(!should_resubmit(&ages(100, 3, false)));
    }

    #[test]
    fn a_still_screen_repeats_after_100_ms_and_no_faster() {
        assert!(!should_resubmit(&ages(100, 100, false)));
        assert!(should_resubmit(&ages(101, 101, false)));
        // Just repeated: wait another interval even though the capture is old.
        assert!(!should_resubmit(&ages(900, 5, false)));
    }

    #[test]
    fn a_pending_keyframe_does_not_wait_for_the_interval() {
        assert!(!should_resubmit(&ages(30, 30, true)));
        assert!(should_resubmit(&ages(41, 41, true)));
        assert!(!should_resubmit(&ages(41, 41, false)));
    }
}
