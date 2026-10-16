//! Key safety when the peer goes quiet (spec D4/D5). A browser that was killed, a laptop
//! that lost its network: nothing arrives any more, and whatever the page held down stays
//! down on the Mac until the 10 s idle close. A live page always sends something (media
//! feedback, connectivity checks), so a short silence is enough reason to let everything go.
//! The session is not ended by this; the idle close still decides that.
use std::time::{Duration, Instant};

/// No accepted packet for this long releases every held key and button.
pub const RELEASE_AFTER: Duration = Duration::from_secs(3);

/// Says "release now" once per silence: again only after packets came back and went quiet.
#[derive(Default)]
pub struct Silence {
    released: bool,
}

impl Silence {
    /// `last_rx` is when the last datagram of this session arrived. True exactly when the
    /// silence has just reached `after` and nothing was released for it yet.
    pub fn release_due(&mut self, after: Duration, last_rx: Instant, now: Instant) -> bool {
        if now.saturating_duration_since(last_rx) < after {
            self.released = false;
            return false;
        }
        !std::mem::replace(&mut self.released, true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(t0: Instant, ms: u64) -> Instant {
        t0 + Duration::from_millis(ms)
    }

    #[test]
    fn nothing_happens_before_three_seconds_of_silence() {
        let (mut s, t0) = (Silence::default(), Instant::now());
        assert!(!s.release_due(RELEASE_AFTER, t0, at(t0, 0)));
        assert!(!s.release_due(RELEASE_AFTER, t0, at(t0, 2999)));
    }

    #[test]
    fn three_seconds_of_silence_release_once() {
        let (mut s, t0) = (Silence::default(), Instant::now());
        assert!(s.release_due(RELEASE_AFTER, t0, at(t0, 3000)));
        assert!(!s.release_due(RELEASE_AFTER, t0, at(t0, 3200)));
        assert!(!s.release_due(RELEASE_AFTER, t0, at(t0, 9000)));
    }

    #[test]
    fn packets_that_resume_allow_another_release_after_the_next_silence() {
        let (mut s, t0) = (Silence::default(), Instant::now());
        assert!(s.release_due(RELEASE_AFTER, t0, at(t0, 3000)));
        // A packet at 4000 ms: the silence is over.
        let t1 = at(t0, 4000);
        assert!(!s.release_due(RELEASE_AFTER, t1, at(t0, 4100)));
        assert!(!s.release_due(RELEASE_AFTER, t1, at(t0, 6999)));
        assert!(s.release_due(RELEASE_AFTER, t1, at(t0, 7000)));
        assert!(!s.release_due(RELEASE_AFTER, t1, at(t0, 7100)));
    }

    #[test]
    fn a_clock_that_went_backwards_is_not_silence() {
        let (mut s, t0) = (Silence::default(), Instant::now());
        assert!(!s.release_due(RELEASE_AFTER, at(t0, 5000), t0));
    }
}
