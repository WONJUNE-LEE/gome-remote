//! Detects "permission lapsed, but ScreenCaptureKit keeps delivering empty frames" (P4):
//! the status then reads `suspect` and `lastCaptureAt` stops moving.
use crate::status::Screen;
use std::time::{Duration, Instant};

/// Only content-free frames for this long make the screen suspect.
pub const SUSPECT_AFTER: Duration = Duration::from_secs(5);
/// 16 is video-range black in NV12 luma; allow a little noise above it.
const BLACK_MAX: u8 = 20;

/// Samples a 32 x 18 grid of an NV12 luma plane (`stride` bytes per row). A plane that is
/// too small for its stated size counts as black rather than panicking.
pub fn luma_is_black(luma: &[u8], width: usize, height: usize, stride: usize) -> bool {
    if width == 0 || height == 0 || stride < width || luma.len() < stride * (height - 1) + width {
        return true;
    }
    for gy in 0..18 {
        let y = (gy * (height - 1)) / 17;
        for gx in 0..32 {
            let x = (gx * (width - 1)) / 31;
            if luma[y * stride + x] > BLACK_MAX {
                return false;
            }
        }
    }
    true
}

#[derive(Default)]
pub struct BlackDetector {
    black_since: Option<Instant>,
    last_content: Option<Instant>,
}

impl BlackDetector {
    /// Call for every frame ScreenCaptureKit delivers.
    pub fn observe(&mut self, now: Instant, black: bool) {
        if black {
            self.black_since.get_or_insert(now);
        } else {
            self.black_since = None;
            self.last_content = Some(now);
        }
    }
    /// A new session starts from a clean slate.
    pub fn reset(&mut self) {
        *self = BlackDetector::default();
    }
    pub fn suspect(&self, now: Instant) -> bool {
        self.black_since.map(|since| now.saturating_duration_since(since) >= SUSPECT_AFTER).unwrap_or(false)
    }
    /// The last time a frame with content arrived (the status' `lastCaptureAt`).
    pub fn last_content(&self) -> Option<Instant> {
        self.last_content
    }
}

/// The black-frame check reads a few hundred bytes; once per 250 ms is plenty.
pub const CHECK_EVERY: Duration = Duration::from_millis(250);

/// The evidence of one capture session, and the verdict it leaves behind. `begin` wipes both:
/// a new session re-checks from scratch. `end` drops the evidence in progress but keeps a
/// suspect verdict, so the tile (seen when no session runs) can show it, unless the screen was
/// locked then (lock screens are black by design). Either way a Mac that was black once never
/// stays suspect past the next session start.
#[derive(Default)]
pub struct BlackWatch {
    active: bool,
    detector: BlackDetector,
    last_check: Option<Instant>,
    /// A suspect verdict kept from the last session (black frames, or a stream the system stopped).
    kept: bool,
}

impl BlackWatch {
    pub fn begin(&mut self) {
        *self = BlackWatch { active: true, ..BlackWatch::default() };
    }
    /// The session is over. `locked`: the screen is locked now.
    pub fn end(&mut self, now: Instant, locked: bool) {
        let kept = self.kept || (!locked && self.detector.suspect(now));
        *self = BlackWatch { kept, ..BlackWatch::default() };
    }
    /// The system stopped the stream (`stream:didStopWithError:`). With the permission gone the
    /// status reads `Denied` from the system and nothing is kept; otherwise the screen is
    /// `Suspect` until the next session start or a frame with content.
    pub fn stream_stopped(&mut self, permission_granted: bool) -> Screen {
        if permission_granted {
            self.kept = true;
            Screen::Suspect
        } else {
            Screen::Denied
        }
    }
    /// A frame arrived. `is_black` runs only when this frame is due for a sample (the first
    /// frame of a session always is) and returns the sample, or `None` when none was taken
    /// (not due, or no session: a late frame of a stopped stream counts for nothing).
    pub fn frame(&mut self, now: Instant, is_black: impl FnOnce() -> bool) -> Option<bool> {
        if !self.active || self.last_check.is_some_and(|at| now.saturating_duration_since(at) < CHECK_EVERY) {
            return None;
        }
        self.last_check = Some(now);
        let black = is_black();
        self.detector.observe(now, black);
        if !black {
            self.kept = false;
        }
        Some(black)
    }
    pub fn suspect(&self, now: Instant) -> bool {
        self.kept || self.detector.suspect(now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_uniformly_dark_plane_is_black_and_any_bright_sample_is_not() {
        let (w, h) = (64, 36);
        let mut plane = vec![16u8; w * h];
        assert!(luma_is_black(&plane, w, h, w));
        plane[(h - 1) * w + (w - 1)] = 200; // the last grid sample is the bottom-right pixel
        assert!(!luma_is_black(&plane, w, h, w));
        plane[(h - 1) * w + (w - 1)] = 20;
        assert!(luma_is_black(&plane, w, h, w), "20 is still within the noise allowance");
        plane[0] = 21;
        assert!(!luma_is_black(&plane, w, h, w));
    }

    #[test]
    fn a_row_stride_wider_than_the_width_is_respected() {
        let (w, h, stride) = (64, 36, 80);
        let mut plane = vec![255u8; stride * h]; // padding bytes are bright and must be ignored
        for y in 0..h {
            for x in 0..w {
                plane[y * stride + x] = 16;
            }
        }
        assert!(luma_is_black(&plane, w, h, stride));
    }

    #[test]
    fn a_plane_that_is_too_small_does_not_panic() {
        assert!(luma_is_black(&[], 64, 36, 64));
        assert!(luma_is_black(&[0u8; 10], 64, 36, 64));
        assert!(luma_is_black(&[0u8; 64 * 36], 0, 36, 64));
        assert!(luma_is_black(&[0u8; 64 * 36], 64, 36, 32), "stride smaller than width");
    }

    #[test]
    fn only_five_seconds_of_unbroken_black_is_suspect() {
        let t0 = Instant::now();
        let mut d = BlackDetector::default();
        d.observe(t0, false);
        d.observe(t0 + Duration::from_secs(1), true);
        assert!(!d.suspect(t0 + Duration::from_secs(5)));
        assert!(d.suspect(t0 + Duration::from_secs(6)));
        d.observe(t0 + Duration::from_secs(7), true);
        assert!(d.suspect(t0 + Duration::from_secs(7)), "black_since keeps the first black frame");
        d.observe(t0 + Duration::from_secs(8), false);
        assert!(!d.suspect(t0 + Duration::from_secs(60)));
        assert_eq!(d.last_content(), Some(t0 + Duration::from_secs(8)));
    }

    #[test]
    fn reset_forgets_everything() {
        let t0 = Instant::now();
        let mut d = BlackDetector::default();
        d.observe(t0, true);
        d.reset();
        assert!(!d.suspect(t0 + Duration::from_secs(60)));
        assert_eq!(d.last_content(), None);
    }

    #[test]
    fn a_suspect_verdict_outlives_the_session_but_not_the_next_start() {
        let t0 = Instant::now();
        let mut w = BlackWatch::default();
        // First session: black for longer than the limit.
        w.begin();
        for ms in (0..7000).step_by(250) {
            w.frame(t0 + Duration::from_millis(ms), || true);
        }
        assert!(w.suspect(t0 + Duration::from_secs(7)));
        // Stopped (screen not locked): the verdict stays, so the tile can show it while nobody
        // watches; a late frame of the dying stream still counts for nothing.
        w.end(t0 + Duration::from_secs(7), false);
        assert!(w.suspect(t0 + Duration::from_secs(8)));
        assert!(w.suspect(t0 + Duration::from_secs(600)));
        assert_eq!(w.frame(t0 + Duration::from_secs(8), || false), None);
        assert!(w.suspect(t0 + Duration::from_secs(9)));
        // Started again: clean until new evidence has been black for the full limit.
        w.begin();
        assert!(!w.suspect(t0 + Duration::from_secs(61)));
        assert_eq!(w.frame(t0 + Duration::from_secs(61), || true), Some(true), "the first frame is checked at once");
        assert!(!w.suspect(t0 + Duration::from_secs(65)));
        assert!(w.suspect(t0 + Duration::from_secs(66)));
    }

    #[test]
    fn the_black_frame_counter_in_progress_is_dropped_at_stop() {
        let t0 = Instant::now();
        let mut w = BlackWatch::default();
        w.begin();
        w.frame(t0, || true);
        assert!(!w.suspect(t0 + Duration::from_secs(4)));
        // Stopped after 4 s of black: not yet a verdict, and it never becomes one by waiting.
        w.end(t0 + Duration::from_secs(4), false);
        assert!(!w.suspect(t0 + Duration::from_secs(60)));
    }

    #[test]
    fn a_session_that_ends_on_a_locked_screen_keeps_no_verdict() {
        let t0 = Instant::now();
        let mut w = BlackWatch::default();
        w.begin();
        for ms in (0..7000).step_by(250) {
            w.frame(t0 + Duration::from_millis(ms), || true);
        }
        assert!(w.suspect(t0 + Duration::from_secs(7)));
        w.end(t0 + Duration::from_secs(7), true); // lock screens are black by design
        assert!(!w.suspect(t0 + Duration::from_secs(8)));
    }

    #[test]
    fn a_stopped_stream_with_permission_still_granted_is_suspect_until_the_next_start() {
        let t0 = Instant::now();
        let mut w = BlackWatch::default();
        w.begin();
        w.frame(t0, || false); // the picture was fine
        assert_eq!(w.stream_stopped(true), Screen::Suspect);
        assert!(w.suspect(t0 + Duration::from_secs(1)));
        // The pipeline's own stop follows; the verdict survives it, even on a locked screen.
        w.end(t0 + Duration::from_secs(1), true);
        assert!(w.suspect(t0 + Duration::from_secs(30)));
        w.begin();
        assert!(!w.suspect(t0 + Duration::from_secs(31)));
    }

    #[test]
    fn a_stopped_stream_without_permission_is_denied_and_needs_no_stored_suspicion() {
        let t0 = Instant::now();
        let mut w = BlackWatch::default();
        w.begin();
        assert_eq!(w.stream_stopped(false), Screen::Denied);
        w.end(t0, false);
        assert!(!w.suspect(t0 + Duration::from_secs(30)), "denied is read from the system, not remembered here");
    }

    #[test]
    fn a_frame_with_content_clears_a_stream_stop_suspicion_within_the_session() {
        let t0 = Instant::now();
        let mut w = BlackWatch::default();
        w.begin();
        w.frame(t0, || false);
        w.stream_stopped(true);
        assert_eq!(w.frame(t0 + Duration::from_secs(1), || false), Some(false));
        assert!(!w.suspect(t0 + Duration::from_secs(2)));
    }

    #[test]
    fn a_session_that_shows_content_is_not_suspect() {
        let t0 = Instant::now();
        let mut w = BlackWatch::default();
        w.begin();
        w.frame(t0, || true);
        w.frame(t0 + Duration::from_secs(3), || false);
        assert!(!w.suspect(t0 + Duration::from_secs(60)));
    }

    #[test]
    fn frames_are_sampled_at_most_every_250_ms() {
        let t0 = Instant::now();
        let mut w = BlackWatch::default();
        w.begin();
        assert_eq!(w.frame(t0, || false), Some(false));
        assert_eq!(w.frame(t0 + Duration::from_millis(100), || panic!("sampled too soon")), None);
        assert_eq!(w.frame(t0 + Duration::from_millis(250), || true), Some(true));
    }
}
