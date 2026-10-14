//! "One session per agent; a new offer closes the old one and takes over" (spec D5).
use std::sync::{Mutex, MutexGuard};

pub trait Closer {
    fn close(&self);
}

pub struct Slot<T: Closer> {
    inner: Mutex<(u64, Option<(u64, T)>)>,
}

impl<T: Closer> Default for Slot<T> {
    fn default() -> Self {
        Slot { inner: Mutex::new((0, None)) }
    }
}

impl<T: Closer> Slot<T> {
    /// A panic elsewhere must not leave sessions impossible to replace or end.
    fn lock(&self) -> MutexGuard<'_, (u64, Option<(u64, T)>)> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Installs `session`, closing the one it replaces. Returns the new session's number
    /// (numbers start at 1; 0 never names a session).
    pub fn take_over(&self, session: T) -> u64 {
        let mut inner = self.lock();
        inner.0 += 1;
        let id = inner.0;
        if let Some((_, old)) = inner.1.replace((id, session)) {
            old.close();
        }
        id
    }
    /// The session `id` is over: forget it unless a newer one already replaced it.
    /// Returns true when the slot is now empty (capture can stop).
    pub fn finished(&self, id: u64) -> bool {
        let mut inner = self.lock();
        if matches!(&inner.1, Some((current, _)) if *current == id) {
            inner.1 = None;
            return true;
        }
        false
    }
    pub fn is_current(&self, id: u64) -> bool {
        matches!(&self.lock().1, Some((current, _)) if *current == id)
    }
    pub fn is_empty(&self) -> bool {
        self.lock().1.is_none()
    }
    /// Runs `f` on the current session, if any.
    pub fn with<R>(&self, f: impl FnOnce(&T) -> R) -> Option<R> {
        self.lock().1.as_ref().map(|(_, s)| f(s))
    }
    /// Runs `f` only if session `id` is the current one, and keeps every take-over waiting
    /// until `f` is done: whatever `f` does cannot land after the replacement's cleanup.
    pub fn with_current<R>(&self, id: u64, f: impl FnOnce() -> R) -> Option<R> {
        let inner = self.lock();
        match &inner.1 {
            Some((current, _)) if *current == id => Some(f()),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
    use std::sync::Arc;

    struct Probe(Arc<AtomicUsize>);
    impl Closer for Probe {
        fn close(&self) {
            self.0.fetch_add(1, SeqCst);
        }
    }

    #[test]
    fn a_new_session_closes_the_previous_one() {
        let slot = Slot::default();
        let (a, b) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let first = slot.take_over(Probe(a.clone()));
        assert!(slot.is_current(first));
        let second = slot.take_over(Probe(b.clone()));
        assert_eq!((a.load(SeqCst), b.load(SeqCst)), (1, 0));
        assert!(!slot.is_current(first));
        assert!(slot.is_current(second));
    }

    #[test]
    fn a_replaced_session_ending_late_does_not_empty_the_slot() {
        let slot = Slot::default();
        let first = slot.take_over(Probe(Arc::new(AtomicUsize::new(0))));
        let second = slot.take_over(Probe(Arc::new(AtomicUsize::new(0))));
        assert!(!slot.finished(first), "the old session's cleanup must not stop the new one's capture");
        assert!(!slot.is_empty());
        assert!(slot.finished(second));
        assert!(slot.is_empty());
        assert!(!slot.finished(second), "finishing twice is harmless");
    }

    #[test]
    fn with_reaches_only_the_current_session() {
        let slot: Slot<Probe> = Slot::default();
        assert_eq!(slot.with(|_| 1), None);
        let count = Arc::new(AtomicUsize::new(0));
        slot.take_over(Probe(count.clone()));
        assert_eq!(slot.with(|p| p.0.load(SeqCst)), Some(0));
    }

    #[test]
    fn with_current_runs_only_for_the_session_that_is_current() {
        let slot: Slot<Probe> = Slot::default();
        let first = slot.take_over(Probe(Arc::new(AtomicUsize::new(0))));
        assert_eq!(slot.with_current(first, || 1), Some(1));
        let second = slot.take_over(Probe(Arc::new(AtomicUsize::new(0))));
        assert_eq!(slot.with_current(first, || 1), None, "a replaced session is not current");
        assert_eq!(slot.with_current(second, || 2), Some(2));
        slot.finished(second);
        assert_eq!(slot.with_current(second, || 2), None, "nor is a finished one");
        assert_eq!(slot.with_current(0, || 3), None, "session 0 is the one not yet numbered");
    }
}
