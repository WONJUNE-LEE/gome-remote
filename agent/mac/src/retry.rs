//! Keeps a failing setup (the encoder session) from being retried by every captured frame
//! and every keepalive tick: after a failure nothing is tried again for `WINDOW`, so the
//! failure is also logged at most once per window.
use std::time::{Duration, Instant};

pub const WINDOW: Duration = Duration::from_secs(2);

#[derive(Default)]
pub struct RetryGate {
    failed_at: Option<Instant>,
}

impl RetryGate {
    /// May an attempt be made now?
    pub fn ready(&self, now: Instant) -> bool {
        self.failed_at.is_none_or(|at| now.saturating_duration_since(at) >= WINDOW)
    }
    pub fn failed(&mut self, now: Instant) {
        self.failed_at = Some(now);
    }
    pub fn succeeded(&mut self) {
        self.failed_at = None;
    }
    /// A new session starts with a clean slate.
    pub fn reset(&mut self) {
        self.failed_at = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_attempt_blocks_new_ones_until_the_window_has_passed() {
        let t0 = Instant::now();
        let mut gate = RetryGate::default();
        assert!(gate.ready(t0), "nothing failed yet");
        gate.failed(t0);
        assert!(!gate.ready(t0));
        assert!(!gate.ready(t0 + Duration::from_millis(1999)), "every captured frame asks; none may retry");
        assert!(gate.ready(t0 + WINDOW));
    }

    #[test]
    fn a_new_failure_starts_a_new_window() {
        let t0 = Instant::now();
        let mut gate = RetryGate::default();
        gate.failed(t0);
        let t1 = t0 + WINDOW;
        assert!(gate.ready(t1));
        gate.failed(t1);
        assert!(!gate.ready(t1 + Duration::from_secs(1)));
        assert!(gate.ready(t1 + WINDOW));
    }

    #[test]
    fn success_and_reset_open_the_gate_at_once() {
        let t0 = Instant::now();
        let mut gate = RetryGate::default();
        gate.failed(t0);
        gate.succeeded();
        assert!(gate.ready(t0));
        gate.failed(t0);
        gate.reset();
        assert!(gate.ready(t0));
    }
}
