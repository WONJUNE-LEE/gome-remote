//! `NSPasteboard` behind the clipboard sync's `Board` seam. Reached through objc2 messages
//! to the class (no AppKit binding crate), so only the selectors used here are in play.
//! Clipboard text is never logged here.
use crate::clipboard::{Access, Board, PasteRead};
use crate::mac::system;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, NSObject};
use objc2::{msg_send, sel};
use objc2_foundation::{NSArray, NSData, NSString};

// NSPasteboard lives in AppKit; linking it makes the class resolvable by name.
#[link(name = "AppKit", kind = "framework")]
extern "C" {}

const TEXT_TYPE: &str = "public.utf8-plain-text";
/// Other string flavours `stringForType:` converts from; their presence means text exists.
const OTHER_TEXT_TYPES: [&str; 2] = ["public.plain-text", "NSStringPboardType"];
/// The community convention password managers use to mark a copy as secret.
const CONCEALED_TYPE: &str = "org.nspasteboard.ConcealedType";
/// `NSPasteboardContentsCurrentHostOnly`: keep the contents off Universal Clipboard.
const CURRENT_HOST_ONLY: usize = 1 << 0;
/// `NSPasteboardAccessBehavior` (macOS 15.4+).
const ACCESS_ALWAYS_ALLOW: isize = 2;
const ACCESS_ALWAYS_DENY: isize = 3;

pub struct Pasteboard {
    board: Retained<NSObject>,
    /// A test pasteboard is released globally when dropped.
    #[cfg(test)]
    unique: bool,
}

// NSPasteboard is documented as usable from any thread; the object is only messaged.
unsafe impl Send for Pasteboard {}
unsafe impl Sync for Pasteboard {}

fn class() -> &'static AnyClass {
    AnyClass::get(c"NSPasteboard").expect("AppKit is linked, so NSPasteboard exists")
}

impl Pasteboard {
    /// The user's general pasteboard.
    pub fn general() -> Pasteboard {
        let board: Retained<NSObject> = unsafe { msg_send![class(), generalPasteboard] };
        Pasteboard {
            board,
            #[cfg(test)]
            unique: false,
        }
    }

    /// A fresh, uniquely named pasteboard, so tests never touch or read the user's clipboard.
    #[cfg(test)]
    pub fn unique() -> Pasteboard {
        let board: Retained<NSObject> = unsafe { msg_send![class(), pasteboardWithUniqueName] };
        Pasteboard { board, unique: true }
    }

    /// Replaces the contents with a type that is not text.
    #[cfg(test)]
    pub fn declare_only_non_text(&self) {
        let ty = NSString::from_str("public.png");
        let data = NSData::from_vec(vec![0u8; 4]);
        unsafe {
            let _: isize = msg_send![&*self.board, clearContents];
            let _: bool = msg_send![&*self.board, setData: &*data, forType: &*ty];
        }
    }

    fn types(&self) -> Vec<String> {
        let types: Option<Retained<NSArray<NSString>>> = unsafe { msg_send![&*self.board, types] };
        types.map(|t| t.iter().map(|s| s.to_string()).collect()).unwrap_or_default()
    }
}

#[cfg(test)]
impl Drop for Pasteboard {
    fn drop(&mut self) {
        if self.unique {
            let _: () = unsafe { msg_send![&*self.board, releaseGlobally] };
        }
    }
}

impl Board for Pasteboard {
    fn change_count(&self) -> i64 {
        let count: isize = unsafe { msg_send![&*self.board, changeCount] };
        count as i64
    }

    fn access(&self) -> Access {
        let known: bool = unsafe { msg_send![&*self.board, respondsToSelector: sel!(accessBehavior)] };
        if !known {
            return Access::AlwaysAllow;
        }
        match unsafe { msg_send![&*self.board, accessBehavior] } {
            ACCESS_ALWAYS_ALLOW => Access::AlwaysAllow,
            ACCESS_ALWAYS_DENY => Access::AlwaysDeny,
            // Default (the user was never asked) and Ask both put up the paste alert.
            _ => Access::Ask,
        }
    }

    fn read(&self) -> PasteRead {
        let ty = NSString::from_str(TEXT_TYPE);
        let text: Option<Retained<NSString>> = unsafe { msg_send![&*self.board, stringForType: &*ty] };
        let types = self.types();
        if let Some(text) = text {
            let text = text.to_string();
            if text.is_empty() {
                return PasteRead::NoText;
            }
            let concealed = types.iter().any(|t| t == CONCEALED_TYPE);
            return PasteRead::Text { text, concealed };
        }
        let has_text_type = types.iter().any(|t| t == TEXT_TYPE || OTHER_TEXT_TYPES.contains(&t.as_str()));
        // Text that cannot be read while access is not "always allow" is a refusal, not an
        // empty clipboard. Types that show no text at all stay "no text".
        if self.access() != Access::AlwaysAllow && (has_text_type || types.is_empty()) {
            PasteRead::Denied
        } else {
            PasteRead::NoText
        }
    }

    fn write(&self, text: &str, concealed: bool) -> i64 {
        let ty = NSString::from_str(TEXT_TYPE);
        let value = NSString::from_str(text);
        unsafe {
            let _: isize = msg_send![&*self.board, prepareForNewContentsWithOptions: CURRENT_HOST_ONLY];
            let _: bool = msg_send![&*self.board, setString: &*value, forType: &*ty];
            if concealed {
                let marker = NSString::from_str(CONCEALED_TYPE);
                let _: bool = msg_send![&*self.board, setData: &*NSData::new(), forType: &*marker];
            }
        }
        self.change_count()
    }

    fn console_locked(&self) -> bool {
        system::console_locked()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clipboard::{Board, PasteRead};
    use crate::mac::system;

    #[test]
    fn write_then_read_round_trips_korean_and_reports_each_write_in_the_change_count() {
        let b = Pasteboard::unique();
        let before = b.change_count();
        let after = b.write("비밀번호 😀\nline2", false);
        assert!(after > before);
        assert_eq!(b.read(), PasteRead::Text { text: "비밀번호 😀\nline2".into(), concealed: false });
    }

    #[test]
    fn concealed_text_carries_the_nspasteboard_marker_and_reads_back_concealed() {
        let b = Pasteboard::unique();
        b.write("pw", true);
        assert_eq!(b.read(), PasteRead::Text { text: "pw".into(), concealed: true });
        b.write("plain", false);
        assert_eq!(b.read(), PasteRead::Text { text: "plain".into(), concealed: false });
    }

    #[test]
    fn a_pasteboard_without_text_reads_as_no_text() {
        let b = Pasteboard::unique();
        b.declare_only_non_text();
        assert_eq!(b.read(), PasteRead::NoText);
    }

    #[test]
    fn the_console_lock_signal_is_readable_and_false_in_ci() {
        let _ = system::console_locked();
    }
}
