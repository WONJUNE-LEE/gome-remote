//! Encoder bitrate from the sender-side bandwidth estimate (str0m's TWCC, spec D3):
//! follow the estimate down at once, climb back more carefully, never below the floor or
//! above the pixel-count ceiling.

pub const FLOOR_BPS: u32 = 2_000_000;
/// What a session starts at before the first estimate: below any ceiling, so a slow path
/// is not flooded while the estimator is still learning.
pub const START_BPS: u32 = 6_000_000;
/// Headroom left under the estimate for retransmissions and keyframes.
const USE_FRACTION: f64 = 0.85;
/// A change smaller than this is not worth reconfiguring the encoder for.
const MIN_STEP: f64 = 0.10;

pub struct BitrateController {
    cap: u32,
    current: u32,
}

impl BitrateController {
    pub fn new(cap: u32) -> Self {
        BitrateController { cap: cap.max(FLOOR_BPS), current: START_BPS.clamp(FLOOR_BPS, cap.max(FLOOR_BPS)) }
    }
    pub fn current(&self) -> u32 {
        self.current
    }
    pub fn cap(&self) -> u32 {
        self.cap
    }

    /// A new estimate arrived. Returns the bitrate to set when it changes meaningfully.
    pub fn on_estimate(&mut self, estimate_bps: u64) -> Option<u32> {
        let wanted = ((estimate_bps as f64 * USE_FRACTION) as u64).clamp(FLOOR_BPS as u64, self.cap as u64) as u32;
        let step = (wanted as f64 - self.current as f64).abs() / self.current as f64;
        // A change under 10 % is not worth reconfiguring the encoder for, unless it reaches the
        // floor or the ceiling.
        if wanted == self.current || step < MIN_STEP && wanted != FLOOR_BPS && wanted != self.cap {
            return None;
        }
        self.current = wanted;
        Some(wanted)
    }

    /// The stream size changed, and with it the ceiling.
    pub fn set_cap(&mut self, cap: u32) -> Option<u32> {
        self.cap = cap.max(FLOOR_BPS);
        if self.current > self.cap {
            self.current = self.cap;
            return Some(self.current);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_starts_below_the_ceiling_and_never_above_it() {
        assert_eq!(BitrateController::new(12_000_000).current(), START_BPS);
        assert_eq!(BitrateController::new(4_000_000).current(), 4_000_000);
    }

    #[test]
    fn a_low_estimate_cuts_the_bitrate_to_the_floor_and_no_lower() {
        let mut c = BitrateController::new(12_000_000);
        assert_eq!(c.on_estimate(500_000), Some(FLOOR_BPS));
        assert_eq!(c.on_estimate(100_000), None, "already at the floor");
        assert_eq!(c.current(), FLOOR_BPS);
    }

    #[test]
    fn the_bitrate_follows_the_estimate_with_headroom_and_stops_at_the_ceiling() {
        let mut c = BitrateController::new(12_000_000);
        assert_eq!(c.on_estimate(10_000_000), Some(8_500_000));
        assert_eq!(c.on_estimate(80_000_000), Some(12_000_000));
        assert_eq!(c.on_estimate(90_000_000), None);
    }

    #[test]
    fn small_changes_do_not_reconfigure_the_encoder() {
        let mut c = BitrateController::new(12_000_000);
        c.on_estimate(10_000_000);
        assert_eq!(c.on_estimate(10_400_000), None);
        assert_eq!(c.on_estimate(9_700_000), None);
        assert_eq!(c.current(), 8_500_000);
    }

    #[test]
    fn a_smaller_stream_lowers_the_ceiling_and_the_current_rate() {
        let mut c = BitrateController::new(20_000_000);
        c.on_estimate(60_000_000);
        assert_eq!(c.current(), 20_000_000);
        assert_eq!(c.set_cap(12_000_000), Some(12_000_000));
        assert_eq!(c.set_cap(20_000_000), None, "raising the ceiling waits for an estimate");
        assert_eq!(c.current(), 12_000_000);
    }
}
