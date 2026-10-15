//! One sharper picture for a screen that stands still (spec D3, "정지 화면 정제"). The
//! encoder works at the congestion controller's average rate, which is tuned for motion; once
//! nothing has changed for [`STILL`] the last frame is encoded once more as a keyframe with
//! the bitrate raised for that frame, then the previous rate is restored. A new captured
//! frame ends the still period, so the next one gets its own refresh.
use std::time::Duration;

/// No new captured frame for this long counts as a still screen.
pub const STILL: Duration = Duration::from_millis(300);
/// How long the raised bitrate stays after the refresh frame went to the encoder, so that
/// frame is encoded with it and the 100 ms keepalive repeats after it are not.
pub const HOLD: Duration = Duration::from_millis(40);

/// The bitrate for the refresh frame: twice the current target, at most 1.5 times the ceiling.
pub fn boost_bps(target: u32, cap: u32) -> u32 {
    let wanted = target as u64 * 2;
    let limit = cap as u64 * 3 / 2;
    wanted.min(limit).min(u32::MAX as u64) as u32
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Nothing,
    /// Raise the bitrate, request a keyframe and submit the last frame again.
    Boost,
    /// Put the bitrate back to the current target.
    Restore,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// Waiting for the screen to stand still.
    Watching,
    /// The refresh went out when the last capture was this old.
    Boosted(Duration),
    /// Refreshed; waits for a new captured frame.
    Refined,
}

#[derive(Debug)]
pub struct Refine {
    state: State,
}

impl Default for Refine {
    fn default() -> Self {
        Refine { state: State::Watching }
    }
}

impl Refine {
    /// Called often with the age of the last captured frame.
    pub fn poll(&mut self, since_capture: Duration) -> Step {
        match self.state {
            State::Watching if since_capture >= STILL => {
                self.state = State::Boosted(since_capture);
                Step::Boost
            }
            State::Watching => Step::Nothing,
            State::Boosted(at) if since_capture < at => {
                // A new frame arrived during the hold: the raised rate must not outlive it.
                self.state = State::Watching;
                Step::Restore
            }
            State::Boosted(at) if since_capture >= at + HOLD => {
                self.state = State::Refined;
                Step::Restore
            }
            State::Boosted(_) => Step::Nothing,
            State::Refined => {
                if since_capture < STILL {
                    self.state = State::Watching;
                }
                Step::Nothing
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn a_screen_still_for_299_ms_is_left_alone_and_300_ms_gets_one_refresh() {
        let mut r = Refine::default();
        assert_eq!(r.poll(ms(0)), Step::Nothing);
        assert_eq!(r.poll(ms(299)), Step::Nothing);
        assert_eq!(r.poll(ms(300)), Step::Boost);
    }

    #[test]
    fn the_raised_rate_is_restored_after_the_hold_and_not_before() {
        let mut r = Refine::default();
        assert_eq!(r.poll(ms(300)), Step::Boost);
        assert_eq!(r.poll(ms(302)), Step::Nothing);
        assert_eq!(r.poll(ms(339)), Step::Nothing);
        assert_eq!(r.poll(ms(340)), Step::Restore);
    }

    #[test]
    fn a_screen_that_stays_still_is_refreshed_once() {
        let mut r = Refine::default();
        assert_eq!(r.poll(ms(300)), Step::Boost);
        assert_eq!(r.poll(ms(340)), Step::Restore);
        for age in [341, 400, 1_000, 60_000] {
            assert_eq!(r.poll(ms(age)), Step::Nothing, "{age} ms");
        }
    }

    #[test]
    fn a_new_frame_ends_the_still_period_and_the_next_stillness_is_refreshed_again() {
        let mut r = Refine::default();
        assert_eq!(r.poll(ms(300)), Step::Boost);
        assert_eq!(r.poll(ms(340)), Step::Restore);
        // A frame arrives; 299 ms later the screen is not yet still again.
        assert_eq!(r.poll(ms(5)), Step::Nothing);
        assert_eq!(r.poll(ms(299)), Step::Nothing);
        assert_eq!(r.poll(ms(300)), Step::Boost);
        assert_eq!(r.poll(ms(340)), Step::Restore);
    }

    #[test]
    fn a_frame_during_the_hold_restores_at_once_and_a_later_stillness_refreshes_again() {
        let mut r = Refine::default();
        assert_eq!(r.poll(ms(1_000)), Step::Boost);
        assert_eq!(r.poll(ms(1_010)), Step::Nothing);
        assert_eq!(r.poll(ms(3)), Step::Restore, "the screen moved while the rate was raised");
        assert_eq!(r.poll(ms(100)), Step::Nothing);
        assert_eq!(r.poll(ms(300)), Step::Boost);
    }

    #[test]
    fn a_busy_screen_is_never_refreshed() {
        let mut r = Refine::default();
        for _ in 0..1_000 {
            assert_eq!(r.poll(ms(16)), Step::Nothing);
        }
    }

    #[test]
    fn the_refresh_rate_is_double_the_target_but_at_most_one_and_a_half_ceilings() {
        assert_eq!(boost_bps(6_000_000, 20_000_000), 12_000_000);
        assert_eq!(boost_bps(10_000_000, 20_000_000), 20_000_000);
        assert_eq!(boost_bps(14_000_000, 20_000_000), 28_000_000);
        assert_eq!(boost_bps(15_000_000, 20_000_000), 30_000_000, "exactly 1.5 x the ceiling");
        assert_eq!(boost_bps(20_000_000, 20_000_000), 30_000_000, "capped");
        assert_eq!(boost_bps(35_000_000, 35_000_000), 52_500_000);
        assert_eq!(boost_bps(u32::MAX, u32::MAX), u32::MAX, "no overflow");
    }
}
