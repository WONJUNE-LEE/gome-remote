//! The `[stats]` line the pipeline prints every ten seconds while someone watches (never per
//! frame). The counters run across sessions, so a report starts from their values at the time
//! it begins and not from zero.
use std::time::{Duration, Instant};

pub const INTERVAL: Duration = Duration::from_secs(10);

#[derive(Debug)]
pub struct StatsReport {
    since: Instant,
    frames: u64,
    bytes: u64,
}

impl StatsReport {
    /// A report window starting now, with the counters' current values.
    pub fn new(now: Instant, frames: u64, bytes: u64) -> Self {
        StatsReport { since: now, frames, bytes }
    }

    /// The line for the window that ended at `now`, once [`INTERVAL`] has passed; the next
    /// window then starts from these counters.
    pub fn poll(&mut self, now: Instant, frames: u64, bytes: u64) -> Option<String> {
        let elapsed = now.saturating_duration_since(self.since);
        if elapsed < INTERVAL {
            return None;
        }
        let secs = elapsed.as_secs_f64();
        let line = format!(
            "[stats] sent_fps={:.1} kbps={:.0}",
            frames.saturating_sub(self.frames) as f64 / secs,
            bytes.saturating_sub(self.bytes) as f64 * 8.0 / 1000.0 / secs
        );
        *self = StatsReport::new(now, frames, bytes);
        Some(line)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_reported_before_ten_seconds() {
        let t0 = Instant::now();
        let mut report = StatsReport::new(t0, 0, 0);
        assert_eq!(report.poll(t0 + Duration::from_millis(9_999), 600, 1_000_000), None);
    }

    #[test]
    fn the_first_report_after_a_session_starts_counts_from_the_counters_current_values() {
        let t0 = Instant::now();
        // Earlier sessions sent 1 000 000 frames and 5 GB; this window sends 600 frames and 1.25 MB in 10 s.
        let mut report = StatsReport::new(t0, 1_000_000, 5_000_000_000);
        let line = report.poll(t0 + Duration::from_secs(10), 1_000_600, 5_001_250_000).unwrap();
        assert_eq!(line, "[stats] sent_fps=60.0 kbps=1000");
    }

    #[test]
    fn the_next_window_starts_where_the_last_ended() {
        let t0 = Instant::now();
        let mut report = StatsReport::new(t0, 0, 0);
        let t1 = t0 + Duration::from_secs(10);
        assert!(report.poll(t1, 600, 1_250_000).is_some());
        assert_eq!(report.poll(t1 + Duration::from_secs(5), 900, 2_000_000), None);
        let line = report.poll(t1 + Duration::from_secs(10), 1_200, 2_500_000).unwrap();
        assert_eq!(line, "[stats] sent_fps=60.0 kbps=1000", "only the second window's frames and bytes");
    }
}
