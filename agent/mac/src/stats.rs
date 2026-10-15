//! The `[stats]` line the pipeline prints every ten seconds while someone watches (never per
//! frame). The counters run across sessions, so a report starts from their values at the time
//! it begins and not from zero.
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::{Duration, Instant};

pub const INTERVAL: Duration = Duration::from_secs(10);

/// What has been sent to the viewer since the process started.
#[derive(Debug, Default)]
pub struct Counters {
    frames: AtomicU64,
    bytes: AtomicU64,
}

impl Counters {
    /// One frame of `bytes` bytes went out.
    pub fn sent(&self, bytes: u64) {
        self.frames.fetch_add(1, Relaxed);
        self.bytes.fetch_add(bytes, Relaxed);
    }

    fn load(&self) -> (u64, u64) {
        (self.frames.load(Relaxed), self.bytes.load(Relaxed))
    }
}

#[derive(Debug)]
pub struct StatsReport {
    since: Instant,
    frames: u64,
    bytes: u64,
}

impl StatsReport {
    /// A report window starting at `now`, from the counters' current values.
    pub fn begin(now: Instant, counters: &Counters) -> Self {
        let (frames, bytes) = counters.load();
        StatsReport { since: now, frames, bytes }
    }

    /// The line for the window that ended at `now`, once [`INTERVAL`] has passed; the next
    /// window then starts from the counters' values at `now`.
    pub fn poll(&mut self, now: Instant, counters: &Counters) -> Option<String> {
        let elapsed = now.saturating_duration_since(self.since);
        if elapsed < INTERVAL {
            return None;
        }
        let (frames, bytes) = counters.load();
        let secs = elapsed.as_secs_f64();
        let line = format!(
            "[stats] sent_fps={:.1} kbps={:.0}",
            frames.saturating_sub(self.frames) as f64 / secs,
            bytes.saturating_sub(self.bytes) as f64 * 8.0 / 1000.0 / secs
        );
        *self = StatsReport { since: now, frames, bytes };
        Some(line)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn send(counters: &Counters, frames: u64, bytes_each: u64) {
        for _ in 0..frames {
            counters.sent(bytes_each);
        }
    }

    #[test]
    fn nothing_is_reported_before_ten_seconds() {
        let t0 = Instant::now();
        let counters = Counters::default();
        let mut report = StatsReport::begin(t0, &counters);
        send(&counters, 600, 2_000);
        assert_eq!(report.poll(t0 + Duration::from_millis(9_999), &counters), None);
    }

    #[test]
    fn the_first_report_after_a_session_starts_counts_from_the_counters_current_values() {
        let t0 = Instant::now();
        // Earlier sessions sent 1 000 frames of 5 000 bytes; this window sends 600 frames of
        // about 2 083 bytes (1.25 MB) in 10 s.
        let counters = Counters::default();
        send(&counters, 1_000, 5_000);
        let mut report = StatsReport::begin(t0, &counters);
        send(&counters, 600, 2_083);
        let line = report.poll(t0 + Duration::from_secs(10), &counters).unwrap();
        assert_eq!(line, "[stats] sent_fps=60.0 kbps=1000");
    }

    #[test]
    fn the_next_window_starts_where_the_last_ended() {
        let t0 = Instant::now();
        let counters = Counters::default();
        let mut report = StatsReport::begin(t0, &counters);
        send(&counters, 600, 2_083);
        let t1 = t0 + Duration::from_secs(10);
        assert!(report.poll(t1, &counters).is_some());
        send(&counters, 300, 2_083);
        assert_eq!(report.poll(t1 + Duration::from_secs(5), &counters), None);
        send(&counters, 300, 2_083);
        let line = report.poll(t1 + Duration::from_secs(10), &counters).unwrap();
        assert_eq!(line, "[stats] sent_fps=60.0 kbps=1000", "only the second window's frames and bytes");
    }
}
