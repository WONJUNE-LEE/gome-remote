//! Clipboard sync between the page and the Mac pasteboard (spec: clipboard-sync design).
//! This file holds the platform-independent types and the `Board` seam; the state machine
//! that decides what to send and what to write joins it later.
use crate::protocol;
use std::time::Duration;

/// The longest clipboard text either side sends, in UTF-8 bytes.
pub const MAX_TEXT: usize = protocol::MAX_CLIPBOARD_TEXT;
/// How often the pasteboard's change count is looked at while the page is watching.
pub const POLL: Duration = Duration::from_millis(300);

/// What macOS lets this process do with the pasteboard (`NSPasteboard.accessBehavior`,
/// macOS 15.4+; older systems never ask, so they report `AlwaysAllow`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    AlwaysAllow,
    Ask,
    AlwaysDeny,
}

/// The outcome of reading the pasteboard's text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PasteRead {
    /// Text, and whether its owner marked it concealed (`org.nspasteboard.ConcealedType`).
    Text { text: String, concealed: bool },
    /// The pasteboard holds nothing that is text.
    NoText,
    /// The system refused the read (the user's pasteboard-access setting).
    Denied,
}

/// The type `Board::write` sets and `read` asks for.
pub const TEXT_TYPE: &str = "public.utf8-plain-text";
/// Other string flavours `stringForType:` converts from; their presence means text exists.
pub const OTHER_TEXT_TYPES: [&str; 2] = ["public.plain-text", "NSStringPboardType"];
/// The community convention password managers use to mark a copy as secret.
pub const CONCEALED_TYPE: &str = "org.nspasteboard.ConcealedType";

/// Turns what a pasteboard read produced (the text if any, the declared types, the access
/// setting) into a `PasteRead`. An empty pasteboard is `NoText` whatever the access is, so
/// it never shows as a refusal.
pub fn classify(text: Option<String>, types: &[String], access: Access) -> PasteRead {
    match text {
        Some(text) if text.is_empty() => PasteRead::NoText,
        Some(text) => PasteRead::Text { text, concealed: types.iter().any(|t| t == CONCEALED_TYPE) },
        None => {
            let has_text_type = types.iter().any(|t| t == TEXT_TYPE || OTHER_TEXT_TYPES.contains(&t.as_str()));
            if has_text_type && access != Access::AlwaysAllow {
                PasteRead::Denied
            } else {
                PasteRead::NoText
            }
        }
    }
}

/// The pasteboard and the console lock, as the clipboard sync sees them.
pub trait Board: Send + Sync {
    /// Never prompts.
    fn change_count(&self) -> i64;
    /// `NSPasteboard.accessBehavior`; macOS before 15.4 gives `AlwaysAllow`.
    fn access(&self) -> Access;
    /// Only called after a change while the page is watching.
    fn read(&self) -> PasteRead;
    /// Replaces the pasteboard text for this Mac only (no Universal Clipboard); returns the
    /// change count after the write.
    fn write(&self, text: &str, concealed: bool) -> i64;
    /// `IOConsoleLocked` (D5), not the CGS screen-lock flag.
    fn console_locked(&self) -> bool;
}

/// A board a test drives: every answer is settable and every call is recorded. One fake
/// serves the sessions' `FakePlatform` and the clipboard state machine's tests.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct FakeBoard {
    count: std::sync::atomic::AtomicI64,
    access: std::sync::Mutex<Option<Access>>,
    read: std::sync::Mutex<Option<PasteRead>>,
    locked: std::sync::atomic::AtomicBool,
    writes: std::sync::Mutex<Vec<(String, bool)>>,
    reads: std::sync::atomic::AtomicUsize,
}

#[cfg(test)]
impl FakeBoard {
    /// Pretends another program copied: the change count advances.
    pub(crate) fn bump(&self) -> i64 {
        self.count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
    }
    pub(crate) fn set_access(&self, access: Access) {
        *self.access.lock().unwrap() = Some(access);
    }
    pub(crate) fn set_read(&self, read: PasteRead) {
        *self.read.lock().unwrap() = Some(read);
    }
    pub(crate) fn set_locked(&self, locked: bool) {
        self.locked.store(locked, std::sync::atomic::Ordering::SeqCst);
    }
    /// Every `write` so far: text and the concealed flag.
    pub(crate) fn writes(&self) -> Vec<(String, bool)> {
        self.writes.lock().unwrap().clone()
    }
    /// How many times `read` was called.
    pub(crate) fn reads(&self) -> usize {
        self.reads.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[cfg(test)]
impl Board for FakeBoard {
    fn change_count(&self) -> i64 {
        self.count.load(std::sync::atomic::Ordering::SeqCst)
    }
    fn access(&self) -> Access {
        self.access.lock().unwrap().unwrap_or(Access::AlwaysAllow)
    }
    fn read(&self) -> PasteRead {
        self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.read.lock().unwrap().clone().unwrap_or(PasteRead::NoText)
    }
    fn write(&self, text: &str, concealed: bool) -> i64 {
        self.writes.lock().unwrap().push((text.to_string(), concealed));
        self.bump()
    }
    fn console_locked(&self) -> bool {
        self.locked.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn types(list: &[&str]) -> Vec<String> {
        list.iter().map(|t| t.to_string()).collect()
    }

    #[test]
    fn classify_plain_text_is_text_and_not_concealed() {
        let read = classify(Some("hi".into()), &types(&[TEXT_TYPE]), Access::AlwaysAllow);
        assert_eq!(read, PasteRead::Text { text: "hi".into(), concealed: false });
    }

    #[test]
    fn classify_text_with_the_marker_is_concealed() {
        let read = classify(Some("pw".into()), &types(&[TEXT_TYPE, CONCEALED_TYPE]), Access::Ask);
        assert_eq!(read, PasteRead::Text { text: "pw".into(), concealed: true });
    }

    #[test]
    fn classify_empty_text_is_no_text() {
        assert_eq!(classify(Some(String::new()), &types(&[TEXT_TYPE]), Access::AlwaysAllow), PasteRead::NoText);
    }

    #[test]
    fn classify_unreadable_text_is_denied_unless_access_is_always_allow() {
        for ty in [TEXT_TYPE, "NSStringPboardType", "public.plain-text"] {
            assert_eq!(classify(None, &types(&[ty]), Access::Ask), PasteRead::Denied, "{ty}");
            assert_eq!(classify(None, &types(&[ty]), Access::AlwaysDeny), PasteRead::Denied, "{ty}");
            assert_eq!(classify(None, &types(&[ty]), Access::AlwaysAllow), PasteRead::NoText, "{ty}");
        }
    }

    #[test]
    fn classify_a_pasteboard_without_a_text_type_is_no_text_under_every_access() {
        for access in [Access::AlwaysAllow, Access::Ask, Access::AlwaysDeny] {
            assert_eq!(classify(None, &types(&["public.png"]), access), PasteRead::NoText);
        }
    }

    #[test]
    fn classify_an_empty_pasteboard_is_no_text_never_denied() {
        for access in [Access::AlwaysAllow, Access::Ask, Access::AlwaysDeny] {
            assert_eq!(classify(None, &[], access), PasteRead::NoText);
        }
    }

    #[test]
    fn the_fake_board_counts_every_write_and_logs_it_without_a_read() {
        let board = FakeBoard::default();
        let before = board.change_count();
        let after = board.write("hello", true);
        assert_eq!(after, before + 1);
        assert_eq!(board.change_count(), after);
        assert_eq!(board.writes(), vec![("hello".to_string(), true)]);
        assert_eq!(board.reads(), 0);
    }

    #[test]
    fn the_fake_board_serves_the_configured_read_and_counts_reads() {
        let board = FakeBoard::default();
        assert_eq!(board.read(), PasteRead::NoText);
        board.set_read(PasteRead::Text { text: "x".into(), concealed: false });
        assert_eq!(board.read(), PasteRead::Text { text: "x".into(), concealed: false });
        assert_eq!(board.reads(), 2);
    }

    #[test]
    fn the_fake_board_access_and_lock_are_settable() {
        let board = FakeBoard::default();
        assert_eq!(board.access(), Access::AlwaysAllow);
        assert!(!board.console_locked());
        board.set_access(Access::Ask);
        board.set_locked(true);
        assert_eq!(board.access(), Access::Ask);
        assert!(board.console_locked());
    }
}
