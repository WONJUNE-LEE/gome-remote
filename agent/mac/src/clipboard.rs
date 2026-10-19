//! Clipboard sync between the page and the Mac pasteboard (spec: clipboard-sync design).
//! This file holds the platform-independent types and the `Board` seam; the state machine
//! that decides what to send and what to write joins it later.
use crate::keymap::{modifier_flag, KeyAction};
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

/// The virtual key code of V.
const KEY_V: u16 = 9;
/// The modifier bitmask of Command alone.
const COMMAND_ONLY: u64 = 0x0010_0000;

/// What the session does with one key event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyAct {
    /// Post the key as usual.
    Inject,
    /// Post nothing.
    Swallow,
    /// Post nothing for the key; type this text instead (the lock screen's paste).
    Type(String),
}

/// A key's fate, and a `clipboard-skipped` notice to send the page if the decision calls for one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyDecision {
    pub act: KeyAct,
    pub notice: Option<String>,
}

impl KeyDecision {
    fn inject() -> Self {
        KeyDecision { act: KeyAct::Inject, notice: None }
    }
    fn swallow() -> Self {
        KeyDecision { act: KeyAct::Swallow, notice: None }
    }
}

/// The clipboard sync's decisions for one session. It owns no clock, thread or log of clipboard
/// text: the caller ticks it every `POLL` and hands it the `Board` each time.
#[derive(Default)]
pub struct ClipState {
    watching: bool,
    /// The change count already dealt with.
    baseline: i64,
    /// The change count this agent's own write produced.
    own_write: Option<i64>,
    /// The lock state the page was last told of (`None`: not yet, or the notice was lost).
    last_lock: Option<bool>,
    /// Client text received while the console is locked. Memory only, never the pasteboard.
    held: Option<String>,
    modifiers: u64,
    /// A Command+V was decided and not yet released: repeats and the up of V are swallowed.
    swallowed_v: bool,
    /// A Command+V found nothing held on the locked console and told the page so; the autorepeat
    /// downs of that V (which are still posted) do not tell it again before V comes up.
    told_empty: bool,
}

impl ClipState {
    pub fn new() -> Self {
        Self::default()
    }

    /// The page asks for pasteboard updates (or stops asking). Turning on takes the current
    /// change count as the baseline without reading; staying on keeps the old one.
    pub fn watch(&mut self, board: &dyn Board, on: bool) {
        if on && !self.watching {
            self.baseline = board.change_count();
        }
        self.watching = on;
    }

    /// One poll. The messages for the page, in order: the lock change, then the clipboard.
    pub fn tick(&mut self, board: &dyn Board) -> Vec<String> {
        let mut out = Vec::new();
        let locked = board.console_locked();
        if self.last_lock != Some(locked) {
            self.last_lock = Some(locked);
            if !locked {
                self.held = None;
            }
            out.push(protocol::lock_notice(locked));
        }
        if self.watching {
            let count = board.change_count();
            if count != self.baseline {
                self.baseline = count;
                if self.own_write == Some(count) {
                    self.own_write = None;
                } else {
                    out.extend(Self::read_for_page(board));
                }
            }
        }
        out
    }

    fn read_for_page(board: &dyn Board) -> Option<String> {
        let skipped = |reason: protocol::SkipReason, len: Option<usize>| {
            match len {
                Some(len) => eprintln!("[clipboard] not sent: {} ({len} bytes)", reason.as_str()),
                None => eprintln!("[clipboard] not sent: {}", reason.as_str()),
            }
            Some(protocol::skipped_notice(reason))
        };
        if board.access() == Access::AlwaysDeny {
            return skipped(protocol::SkipReason::ReadDenied, None);
        }
        match board.read() {
            PasteRead::Denied => skipped(protocol::SkipReason::ReadDenied, None),
            PasteRead::NoText => None,
            PasteRead::Text { text, .. } if text.is_empty() => None,
            PasteRead::Text { text, .. } if text.len() > MAX_TEXT => {
                skipped(protocol::SkipReason::TooLarge, Some(text.len()))
            }
            PasteRead::Text { text, concealed } => Some(protocol::clipboard_notice(&text, concealed)),
        }
    }

    /// Text from the page: held while the console is locked (a fresh reading), else written.
    pub fn inbound(&mut self, board: &dyn Board, text: &str, concealed: bool) {
        if board.console_locked() {
            self.held = Some(text.to_string());
        } else {
            self.held = None;
            self.own_write = Some(board.write(text, concealed));
        }
    }

    /// Decides one key event. Only Command+V on a locked console is anything but `Inject`.
    pub fn on_key(&mut self, board: &dyn Board, action: KeyAction, down: bool) -> KeyDecision {
        let KeyAction::Code(code) = action else {
            return KeyDecision::inject();
        };
        if let Some(flag) = modifier_flag(code) {
            if down {
                self.modifiers |= flag;
            } else {
                self.modifiers &= !flag;
            }
            return KeyDecision::inject();
        }
        if code != KEY_V {
            return KeyDecision::inject();
        }
        if self.swallowed_v {
            if !down {
                self.swallowed_v = false;
            }
            return KeyDecision::swallow();
        }
        if self.told_empty {
            self.told_empty = down;
            return KeyDecision::inject();
        }
        if !down || self.modifiers != COMMAND_ONLY {
            return KeyDecision::inject();
        }
        if !board.console_locked() {
            self.held = None;
            return KeyDecision::inject();
        }
        let held = self.held.as_deref().unwrap_or("");
        let text = held
            .strip_suffix("\r\n")
            .or_else(|| held.strip_suffix('\n'))
            .or_else(|| held.strip_suffix('\r'))
            .unwrap_or(held);
        if text.is_empty() {
            self.told_empty = true;
            return KeyDecision {
                act: KeyAct::Inject,
                notice: Some(protocol::skipped_notice(protocol::SkipReason::LockedEmpty)),
            };
        }
        self.swallowed_v = true;
        if text.contains(['\r', '\n']) {
            KeyDecision {
                act: KeyAct::Swallow,
                notice: Some(protocol::skipped_notice(protocol::SkipReason::LockedMultiline)),
            }
        } else {
            KeyDecision { act: KeyAct::Type(text.to_string()), notice: None }
        }
    }

    /// Forgets the modifiers and a swallowed V (Release, channel closed, input silence).
    pub fn release(&mut self) {
        self.modifiers = 0;
        self.swallowed_v = false;
        self.told_empty = false;
    }

    /// The session is over: the held text goes.
    pub fn end(&mut self) {
        self.held = None;
        self.release();
    }

    /// The lock notice did not reach the page: the next tick announces the state again.
    pub fn forget_lock(&mut self) {
        self.last_lock = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::SkipReason;

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

    // ---- ClipState ----

    const CMD: u16 = 55;
    const SHIFT: u16 = 56;
    const CONTROL: u16 = 59;
    const KEY_V: u16 = 9;

    fn text(t: &str) -> PasteRead {
        PasteRead::Text { text: t.into(), concealed: false }
    }

    fn key(state: &mut ClipState, board: &FakeBoard, code: u16, down: bool) -> KeyDecision {
        state.on_key(board, KeyAction::Code(code), down)
    }

    /// Locked, with `held` as the client text and Command held.
    fn locked_with(held: &str) -> (ClipState, FakeBoard) {
        let board = FakeBoard::default();
        board.set_locked(true);
        let mut state = ClipState::new();
        state.inbound(&board, held, false);
        key(&mut state, &board, CMD, true);
        (state, board)
    }

    #[test]
    fn watch_on_takes_the_baseline_without_reading_and_a_change_before_it_is_never_sent() {
        let board = FakeBoard::default();
        for _ in 0..5 {
            board.bump();
        }
        board.set_read(text("old"));
        board.bump(); // 6: a copy before watch-on
        let mut state = ClipState::new();
        state.tick(&board); // session-open lock notice
        state.watch(&board, true);
        assert!(state.tick(&board).is_empty());
        assert_eq!(board.reads(), 0);
        board.set_read(text("new"));
        board.bump(); // 7
        assert_eq!(state.tick(&board), vec![protocol::clipboard_notice("new", false)]);
        assert_eq!(board.reads(), 1);
        assert!(state.tick(&board).is_empty());
        assert_eq!(board.reads(), 1);
    }

    #[test]
    fn a_second_watch_on_keeps_the_baseline_and_watch_off_stops_polling_and_reading() {
        let board = FakeBoard::default();
        let mut state = ClipState::new();
        state.tick(&board);
        state.watch(&board, true);
        board.set_read(text("a"));
        board.bump();
        state.watch(&board, true); // on -> on keeps the baseline: the copy is still pending
        assert_eq!(state.tick(&board), vec![protocol::clipboard_notice("a", false)]);
        state.watch(&board, false);
        board.bump();
        assert!(state.tick(&board).is_empty());
        assert_eq!(board.reads(), 1);
        state.watch(&board, true); // off -> on: the copy made while off is not sent
        assert!(state.tick(&board).is_empty());
        assert_eq!(board.reads(), 1);
    }

    #[test]
    fn the_agents_own_write_is_not_sent_back_but_the_next_user_copy_is() {
        let board = FakeBoard::default();
        for _ in 0..8 {
            board.bump();
        }
        let mut state = ClipState::new();
        state.tick(&board);
        state.watch(&board, true);
        state.inbound(&board, "from page", false);
        assert_eq!(board.change_count(), 9);
        assert!(state.tick(&board).is_empty());
        assert_eq!(board.reads(), 0);
        board.set_read(text("user copy"));
        board.bump(); // 10
        assert_eq!(state.tick(&board), vec![protocol::clipboard_notice("user copy", false)]);
    }

    #[test]
    fn access_deny_skips_without_reading_and_a_refused_read_is_read_denied() {
        let board = FakeBoard::default();
        let mut state = ClipState::new();
        state.tick(&board);
        state.watch(&board, true);
        board.set_access(Access::AlwaysDeny);
        board.bump();
        assert_eq!(state.tick(&board), vec![protocol::skipped_notice(SkipReason::ReadDenied)]);
        assert_eq!(board.reads(), 0);
        board.set_access(Access::Ask);
        board.set_read(PasteRead::Denied);
        board.bump();
        assert_eq!(state.tick(&board), vec![protocol::skipped_notice(SkipReason::ReadDenied)]);
        assert_eq!(board.reads(), 1);
    }

    #[test]
    fn no_text_and_empty_text_are_silent() {
        let board = FakeBoard::default();
        let mut state = ClipState::new();
        state.tick(&board);
        state.watch(&board, true);
        board.set_read(PasteRead::NoText);
        board.bump();
        assert!(state.tick(&board).is_empty());
        board.set_read(text(""));
        board.bump();
        assert!(state.tick(&board).is_empty());
        assert_eq!(board.reads(), 2);
    }

    #[test]
    fn text_over_64_kib_is_skipped_as_too_large_and_one_byte_under_is_sent() {
        let board = FakeBoard::default();
        let mut state = ClipState::new();
        state.tick(&board);
        state.watch(&board, true);
        let fits = "a".repeat(65_536);
        board.set_read(text(&fits));
        board.bump();
        assert_eq!(state.tick(&board), vec![protocol::clipboard_notice(&fits, false)]);
        board.set_read(text(&"a".repeat(65_537)));
        board.bump();
        assert_eq!(state.tick(&board), vec![protocol::skipped_notice(SkipReason::TooLarge)]);
        // Korean: 3 bytes each, 21 845 fit (65 535 bytes), 21 846 do not (65 538).
        let korean = "한".repeat(21_845);
        board.set_read(text(&korean));
        board.bump();
        assert_eq!(state.tick(&board), vec![protocol::clipboard_notice(&korean, false)]);
        board.set_read(text(&"한".repeat(21_846)));
        board.bump();
        assert_eq!(state.tick(&board), vec![protocol::skipped_notice(SkipReason::TooLarge)]);
    }

    #[test]
    fn concealed_flag_passes_through_to_the_notice() {
        let board = FakeBoard::default();
        let mut state = ClipState::new();
        state.tick(&board);
        state.watch(&board, true);
        board.set_read(PasteRead::Text { text: "pw".into(), concealed: true });
        board.bump();
        assert_eq!(state.tick(&board), vec![protocol::clipboard_notice("pw", true)]);
    }

    #[test]
    fn the_first_tick_announces_the_lock_state_and_each_change_once() {
        let board = FakeBoard::default();
        let mut state = ClipState::new();
        assert_eq!(state.tick(&board), vec![protocol::lock_notice(false)]);
        assert!(state.tick(&board).is_empty());
        board.set_locked(true);
        assert_eq!(state.tick(&board), vec![protocol::lock_notice(true)]);
        assert!(state.tick(&board).is_empty());
        board.set_locked(false);
        assert_eq!(state.tick(&board), vec![protocol::lock_notice(false)]);
        assert!(state.tick(&board).is_empty());
    }

    #[test]
    fn the_lock_notice_comes_before_the_clipboard_in_one_tick() {
        let board = FakeBoard::default();
        let mut state = ClipState::new();
        state.tick(&board);
        state.watch(&board, true);
        board.set_read(text("x"));
        board.bump();
        board.set_locked(true);
        assert_eq!(state.tick(&board), vec![protocol::lock_notice(true), protocol::clipboard_notice("x", false)]);
    }

    #[test]
    fn forget_lock_makes_the_next_tick_announce_the_state_again() {
        let board = FakeBoard::default();
        board.set_locked(true);
        let mut state = ClipState::new();
        assert_eq!(state.tick(&board), vec![protocol::lock_notice(true)]);
        assert!(state.tick(&board).is_empty());
        state.forget_lock();
        assert_eq!(state.tick(&board), vec![protocol::lock_notice(true)]);
        assert!(state.tick(&board).is_empty());
    }

    #[test]
    fn unlock_drops_the_held_text() {
        let (mut state, board) = locked_with("pw");
        state.tick(&board);
        board.set_locked(false);
        state.tick(&board);
        board.set_locked(true);
        state.tick(&board);
        let d = key(&mut state, &board, KEY_V, true);
        assert_eq!(
            d,
            KeyDecision { act: KeyAct::Inject, notice: Some(protocol::skipped_notice(SkipReason::LockedEmpty)) }
        );
    }

    #[test]
    fn inbound_when_unlocked_writes_with_the_concealed_flag_and_when_locked_holds_without_writing() {
        let board = FakeBoard::default();
        let mut state = ClipState::new();
        state.inbound(&board, "open", false);
        state.inbound(&board, "secret", true);
        assert_eq!(board.writes(), vec![("open".to_string(), false), ("secret".to_string(), true)]);
        board.set_locked(true);
        state.inbound(&board, "held", false);
        assert_eq!(board.writes().len(), 2);
        board.set_locked(false);
        state.tick(&board);
        assert_eq!(board.writes().len(), 2, "the Mac pasteboard never receives lock-screen text");
    }

    #[test]
    fn locked_command_v_types_the_held_text_and_injects_no_v() {
        let (mut state, board) = locked_with("pw");
        let d = key(&mut state, &board, KEY_V, true);
        assert_eq!(d, KeyDecision { act: KeyAct::Type("pw".into()), notice: None });
        assert!(board.writes().is_empty());
    }

    #[test]
    fn locked_paste_decision_matrix() {
        for held in ["pw\n", "pw\r\n", "pw\r"] {
            let (mut state, board) = locked_with(held);
            assert_eq!(key(&mut state, &board, KEY_V, true).act, KeyAct::Type("pw".into()), "{held:?}");
        }
        // Only one trailing line break is stripped; one that remains is multi-line.
        for held in ["a\nb", "a\n\n", "a\r\nb\r\n"] {
            let (mut state, board) = locked_with(held);
            let d = key(&mut state, &board, KEY_V, true);
            assert_eq!(
                d,
                KeyDecision {
                    act: KeyAct::Swallow,
                    notice: Some(protocol::skipped_notice(SkipReason::LockedMultiline))
                },
                "{held:?}"
            );
        }
        let (mut state, board) = locked_with("\n");
        let d = key(&mut state, &board, KEY_V, true);
        assert_eq!(
            d,
            KeyDecision { act: KeyAct::Inject, notice: Some(protocol::skipped_notice(SkipReason::LockedEmpty)) }
        );
        // No held text at all.
        let board = FakeBoard::default();
        board.set_locked(true);
        let mut state = ClipState::new();
        key(&mut state, &board, CMD, true);
        let d = key(&mut state, &board, KEY_V, true);
        assert_eq!(
            d,
            KeyDecision { act: KeyAct::Inject, notice: Some(protocol::skipped_notice(SkipReason::LockedEmpty)) }
        );
    }

    #[test]
    fn the_locked_empty_notice_is_sent_on_the_first_down_of_v_only() {
        let notice =
            KeyDecision { act: KeyAct::Inject, notice: Some(protocol::skipped_notice(SkipReason::LockedEmpty)) };
        let plain = KeyDecision { act: KeyAct::Inject, notice: None };
        let board = FakeBoard::default();
        board.set_locked(true);
        let mut state = ClipState::new();
        key(&mut state, &board, CMD, true);
        assert_eq!(key(&mut state, &board, KEY_V, true), notice);
        assert_eq!(key(&mut state, &board, KEY_V, true), plain, "autorepeat still injects, silently");
        assert_eq!(key(&mut state, &board, KEY_V, true), plain);
        assert_eq!(key(&mut state, &board, KEY_V, false), plain);
        assert_eq!(key(&mut state, &board, KEY_V, true), notice, "the next press tells the page again");
        // A release (channel closed) forgets it too.
        state.release();
        key(&mut state, &board, CMD, true);
        assert_eq!(key(&mut state, &board, KEY_V, true), notice);
    }

    #[test]
    fn other_chords_and_an_unlocked_command_v_inject_without_a_notice() {
        let plain = KeyDecision { act: KeyAct::Inject, notice: None };
        // Command+Shift+V and Control+V.
        for extra in [SHIFT, CONTROL] {
            let (mut state, board) = locked_with("pw");
            key(&mut state, &board, extra, true);
            assert_eq!(key(&mut state, &board, KEY_V, true), plain, "extra {extra}");
        }
        // Control alone, without Command.
        let board = FakeBoard::default();
        board.set_locked(true);
        let mut state = ClipState::new();
        state.inbound(&board, "pw", false);
        key(&mut state, &board, CONTROL, true);
        assert_eq!(key(&mut state, &board, KEY_V, true), plain);
        // Bare V.
        let mut state = ClipState::new();
        state.inbound(&board, "pw", false);
        assert_eq!(key(&mut state, &board, KEY_V, true), plain);
        // Unlocked Command+V.
        let board = FakeBoard::default();
        let mut state = ClipState::new();
        key(&mut state, &board, CMD, true);
        assert_eq!(key(&mut state, &board, KEY_V, true), plain);
        // Caps Lock tap and other keys.
        assert_eq!(state.on_key(&board, KeyAction::CapsLockTap, true), plain);
    }

    #[test]
    fn a_modifier_released_before_v_no_longer_counts() {
        let (mut state, board) = locked_with("pw");
        key(&mut state, &board, CMD, false);
        assert_eq!(key(&mut state, &board, KEY_V, true).act, KeyAct::Inject);
    }

    #[test]
    fn repeat_and_release_of_a_swallowed_v_are_swallowed_and_the_next_v_decides_again() {
        let (mut state, board) = locked_with("pw");
        assert_eq!(key(&mut state, &board, KEY_V, true).act, KeyAct::Type("pw".into()));
        assert_eq!(key(&mut state, &board, KEY_V, true).act, KeyAct::Swallow, "autorepeat");
        assert_eq!(key(&mut state, &board, KEY_V, true).act, KeyAct::Swallow, "autorepeat");
        key(&mut state, &board, CMD, false); // Command comes up before V
        assert_eq!(key(&mut state, &board, KEY_V, false).act, KeyAct::Swallow, "the matching up");
        key(&mut state, &board, CMD, true);
        assert_eq!(key(&mut state, &board, KEY_V, true).act, KeyAct::Type("pw".into()), "decided again");
        // A multi-line Swallow does the same.
        let (mut state, board) = locked_with("a\nb");
        assert_eq!(key(&mut state, &board, KEY_V, true).act, KeyAct::Swallow);
        let repeat = key(&mut state, &board, KEY_V, true);
        assert_eq!(repeat, KeyDecision { act: KeyAct::Swallow, notice: None }, "no second notice");
        assert_eq!(key(&mut state, &board, KEY_V, false).act, KeyAct::Swallow);
        assert_eq!(key(&mut state, &board, KEY_V, false).act, KeyAct::Inject, "only the one up");
    }

    #[test]
    fn lock_flapping_around_a_paste_uses_the_fresh_signal() {
        let (mut state, board) = locked_with("pw");
        state.tick(&board);
        board.set_locked(false); // no tick has seen it
        assert_eq!(key(&mut state, &board, KEY_V, true), KeyDecision { act: KeyAct::Inject, notice: None });
        key(&mut state, &board, KEY_V, false);
        board.set_locked(true);
        state.inbound(&board, "pw2", false);
        assert!(board.writes().is_empty());
        assert_eq!(key(&mut state, &board, KEY_V, true).act, KeyAct::Type("pw2".into()), "held was replaced");
        key(&mut state, &board, KEY_V, false);
        board.set_locked(false);
        assert_eq!(state.tick(&board), vec![protocol::lock_notice(false)]);
        board.set_locked(true);
        assert_eq!(state.tick(&board), vec![protocol::lock_notice(true)]);
        assert_eq!(
            key(&mut state, &board, KEY_V, true).notice,
            Some(protocol::skipped_notice(SkipReason::LockedEmpty)),
            "the unlock dropped the held text"
        );
    }

    #[test]
    fn a_flap_with_no_tick_in_between_still_drops_the_held_text() {
        let (mut state, board) = locked_with("pw");
        state.tick(&board);
        board.set_locked(false);
        assert_eq!(key(&mut state, &board, KEY_V, true).act, KeyAct::Inject); // fresh unlocked seen
        key(&mut state, &board, KEY_V, false);
        board.set_locked(true);
        assert_eq!(
            key(&mut state, &board, KEY_V, true).notice,
            Some(protocol::skipped_notice(SkipReason::LockedEmpty))
        );
    }

    #[test]
    fn release_forgets_the_modifiers_so_a_stuck_command_cannot_make_a_later_v_a_paste() {
        let (mut state, board) = locked_with("pw");
        state.release();
        assert_eq!(key(&mut state, &board, KEY_V, true), KeyDecision { act: KeyAct::Inject, notice: None });
    }

    #[test]
    fn release_forgets_a_swallowed_v() {
        let (mut state, board) = locked_with("pw");
        assert_eq!(key(&mut state, &board, KEY_V, true).act, KeyAct::Type("pw".into()));
        state.release();
        assert_eq!(key(&mut state, &board, KEY_V, true).act, KeyAct::Inject);
    }

    #[test]
    fn end_drops_the_held_text() {
        let (mut state, board) = locked_with("pw");
        state.end();
        key(&mut state, &board, CMD, true); // end forgot the modifiers too
        assert_eq!(
            key(&mut state, &board, KEY_V, true).notice,
            Some(protocol::skipped_notice(SkipReason::LockedEmpty))
        );
    }
}
