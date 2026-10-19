//! The `input` data channel (spec D4): one JSON message per data channel message,
//! at most 512 bytes (`text`: 8 KiB, `clipboard`: 256 KiB). Anything out of range, malformed or unknown is
//! dropped, never clamped or guessed at.
use crate::keymap::{self, KeyAction};
use crate::size::{self, Size};
use serde_json::Value;

pub const MAX_MESSAGE: usize = 512;
pub const MAX_TEXT_MESSAGE: usize = 8 * 1024;
/// The clipboard text itself, in UTF-8 bytes (not characters); larger text is never sent, never cut.
pub const MAX_CLIPBOARD_TEXT: usize = 64 * 1024;
/// The whole `clipboard` message: JSON escaping can inflate 64 KiB of control characters, and the
/// data channel carries at most this much in one message.
pub const MAX_CLIPBOARD_MESSAGE: usize = 256 * 1024;
/// What the agent sends over the data channel to a session that another device replaced,
/// just before it closes that peer (spec D5). The page ends its session on it.
pub const NOTICE_REPLACED: &str = r#"{"type":"replaced"}"#;
/// Pixels. Larger wheel deltas are cut to this, in both directions.
pub const MAX_WHEEL: i32 = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, PartialEq)]
pub enum InputMsg {
    Pointer {
        x: f64,
        y: f64,
    },
    Button {
        button: Button,
        down: bool,
        x: f64,
        y: f64,
    },
    /// DOM sign: positive `dy` scrolls the content up (the page moves down the document).
    Wheel {
        dx: i32,
        dy: i32,
    },
    Key {
        action: KeyAction,
        down: bool,
    },
    Text(String),
    Release,
    Size(Size),
    /// The client's clipboard text (non-empty, at most `MAX_CLIPBOARD_TEXT` bytes).
    Clipboard {
        text: String,
        concealed: bool,
    },
    /// The page asks the agent to start or stop reporting Mac pasteboard changes.
    ClipboardWatch(bool),
}

/// Why the agent did not forward or apply a clipboard (the `reason` of a `clipboard-skipped` notice).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    TooLarge,
    ReadDenied,
    LockedMultiline,
    LockedEmpty,
}

impl SkipReason {
    pub fn as_str(self) -> &'static str {
        match self {
            SkipReason::TooLarge => "too-large",
            SkipReason::ReadDenied => "read-denied",
            SkipReason::LockedMultiline => "locked-multiline",
            SkipReason::LockedEmpty => "locked-empty",
        }
    }
}

// The notices are written by hand so that `type` comes first (serde_json's map sorts keys);
// every string that is not a constant goes through serde_json for its escaping.

/// The Mac pasteboard text for the page (a text frame).
pub fn clipboard_notice(text: &str, concealed: bool) -> String {
    let text = Value::from(text);
    format!(r#"{{"type":"clipboard","text":{text},"concealed":{concealed}}}"#)
}

pub fn skipped_notice(reason: SkipReason) -> String {
    format!(r#"{{"type":"clipboard-skipped","reason":"{}"}}"#, reason.as_str())
}

/// Whether the Mac is at its lock screen, as far as pasting is concerned.
pub fn lock_notice(locked: bool) -> String {
    format!(r#"{{"type":"lock","locked":{locked}}}"#)
}

fn unit(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite() && (0.0..=1.0).contains(n))
}
fn flag(v: &Value) -> Option<bool> {
    v.as_bool()
}

pub fn parse(data: &[u8]) -> Option<InputMsg> {
    if data.len() > MAX_CLIPBOARD_MESSAGE {
        return None;
    }
    let value: Value = serde_json::from_slice(data).ok()?;
    let object = value.as_object()?;
    let kind = object.get("type")?.as_str()?;
    let limit = match kind {
        "clipboard" => MAX_CLIPBOARD_MESSAGE,
        "text" => MAX_TEXT_MESSAGE,
        _ => MAX_MESSAGE,
    };
    if data.len() > limit {
        return None;
    }
    match kind {
        "pointer" => Some(InputMsg::Pointer { x: unit(object.get("x")?)?, y: unit(object.get("y")?)? }),
        "button" => {
            let button = match object.get("b")?.as_u64()? {
                0 => Button::Left,
                1 => Button::Middle,
                2 => Button::Right,
                _ => return None,
            };
            Some(InputMsg::Button {
                button,
                down: flag(object.get("down")?)?,
                x: unit(object.get("x")?)?,
                y: unit(object.get("y")?)?,
            })
        }
        "wheel" => {
            let delta = |name: &str| -> Option<i32> {
                let n = object.get(name)?.as_f64().filter(|n| n.is_finite())?;
                Some(n.clamp(-(MAX_WHEEL as f64), MAX_WHEEL as f64) as i32)
            };
            Some(InputMsg::Wheel { dx: delta("dx")?, dy: delta("dy")? })
        }
        "key" => {
            let code = object.get("code")?.as_str().filter(|c| c.len() <= 32)?;
            Some(InputMsg::Key { action: keymap::lookup(code)?, down: flag(object.get("down")?)? })
        }
        "text" => {
            let s = object.get("s")?.as_str()?;
            Some(InputMsg::Text(s.to_string()))
        }
        "clipboard" => {
            let text = object.get("text")?.as_str().filter(|t| !t.is_empty() && t.len() <= MAX_CLIPBOARD_TEXT)?;
            let concealed = match object.get("concealed") {
                None => false,
                Some(v) => flag(v)?,
            };
            Some(InputMsg::Clipboard { text: text.to_string(), concealed })
        }
        "clipboard-watch" => Some(InputMsg::ClipboardWatch(flag(object.get("on")?)?)),
        "release" => Some(InputMsg::Release),
        "size" => {
            let w = object.get("w")?.as_i64()?;
            let h = object.get("h")?.as_i64()?;
            Some(InputMsg::Size(size::parse_requested(w, h)?))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(text: &str) -> Option<InputMsg> {
        parse(text.as_bytes())
    }

    #[test]
    fn every_message_kind_parses() {
        assert_eq!(p(r#"{"type":"pointer","x":0.25,"y":1}"#), Some(InputMsg::Pointer { x: 0.25, y: 1.0 }));
        assert_eq!(
            p(r#"{"type":"button","b":2,"down":true,"x":0,"y":0.5}"#),
            Some(InputMsg::Button { button: Button::Right, down: true, x: 0.0, y: 0.5 })
        );
        assert_eq!(p(r#"{"type":"wheel","dx":0,"dy":-120}"#), Some(InputMsg::Wheel { dx: 0, dy: -120 }));
        assert_eq!(
            p(r#"{"type":"key","code":"KeyA","down":false}"#),
            Some(InputMsg::Key { action: KeyAction::Code(0), down: false })
        );
        assert_eq!(
            p(r#"{"type":"key","code":"Lang1","down":true}"#),
            Some(InputMsg::Key { action: KeyAction::CapsLockTap, down: true })
        );
        assert_eq!(p(r#"{"type":"text","s":"안녕 😀"}"#), Some(InputMsg::Text("안녕 😀".into())));
        assert_eq!(p(r#"{"type":"release"}"#), Some(InputMsg::Release));
        assert_eq!(p(r#"{"type":"size","w":1920,"h":1080}"#), Some(InputMsg::Size(Size { w: 1920, h: 1080 })));
    }

    #[test]
    fn button_numbers_follow_the_dom_order() {
        for (b, expected) in [(0, Button::Left), (1, Button::Middle), (2, Button::Right)] {
            let msg = format!(r#"{{"type":"button","b":{b},"down":true,"x":0.5,"y":0.5}}"#);
            assert!(matches!(p(&msg), Some(InputMsg::Button { button, .. }) if button == expected));
        }
        for b in ["3", "4", "-1", "1.5", "\"0\"", "null"] {
            let msg = format!(r#"{{"type":"button","b":{b},"down":true,"x":0.5,"y":0.5}}"#);
            assert_eq!(p(&msg), None, "{b}");
        }
    }

    #[test]
    fn coordinates_outside_zero_to_one_are_dropped_not_clamped() {
        for xy in [
            r#""x":-0.01,"y":0.5"#,
            r#""x":1.01,"y":0.5"#,
            r#""x":0.5,"y":2"#,
            r#""x":"0.5","y":0.5"#,
            r#""x":null,"y":0.5"#,
            r#""x":0.5"#,
            r#""y":0.5"#,
        ] {
            assert_eq!(p(&format!(r#"{{"type":"pointer",{xy}}}"#)), None, "{xy}");
        }
        assert_eq!(p(r#"{"type":"pointer","x":1e999,"y":0}"#), None, "overflow to infinity");
    }

    #[test]
    fn wheel_deltas_are_cut_to_the_limit_in_both_directions() {
        assert_eq!(p(r#"{"type":"wheel","dx":99999,"dy":-99999}"#), Some(InputMsg::Wheel { dx: 2000, dy: -2000 }));
        assert_eq!(p(r#"{"type":"wheel","dx":1.9,"dy":-1.9}"#), Some(InputMsg::Wheel { dx: 1, dy: -1 }));
        assert_eq!(p(r#"{"type":"wheel","dx":"1","dy":0}"#), None);
        assert_eq!(p(r#"{"type":"wheel","dx":1}"#), None);
    }

    #[test]
    fn unknown_key_codes_and_types_are_dropped() {
        assert_eq!(p(r#"{"type":"key","code":"Nope","down":true}"#), None);
        assert_eq!(p(r#"{"type":"key","code":"KeyA"}"#), None, "down is required");
        assert_eq!(p(r#"{"type":"key","code":"KeyA","down":1}"#), None, "down must be a boolean");
        assert_eq!(p(r#"{"type":"key","code":7,"down":true}"#), None);
        assert_eq!(p(r#"{"type":"click","x":0.5,"y":0.5}"#), None);
        assert_eq!(p(r#"{"x":0.5,"y":0.5}"#), None);
        assert_eq!(p(r#"{"type":5}"#), None);
        assert_eq!(p("[]"), None);
        assert_eq!(p("not json"), None);
        assert_eq!(p(""), None);
        assert_eq!(parse(&[0xff, 0xfe, 0x00]), None, "not UTF-8");
    }

    #[test]
    fn size_messages_obey_the_stream_limits() {
        assert_eq!(p(r#"{"type":"size","w":640,"h":480}"#), Some(InputMsg::Size(Size { w: 640, h: 480 })));
        assert_eq!(p(r#"{"type":"size","w":1921,"h":1081}"#), Some(InputMsg::Size(Size { w: 1920, h: 1080 })));
        for body in [
            r#""w":639,"h":480"#,
            r#""w":640,"h":479"#,
            r#""w":3841,"h":2160"#,
            r#""w":640.5,"h":480"#,
            r#""w":"640","h":480"#,
        ] {
            assert_eq!(p(&format!(r#"{{"type":"size",{body}}}"#)), None, "{body}");
        }
    }

    #[test]
    fn only_text_and_clipboard_exceed_512_bytes() {
        let pad = " ".repeat(600);
        assert_eq!(p(&format!(r#"{{"type":"pointer","x":0.5,"y":0.5,"pad":"{pad}"}}"#)), None);
        let text = "a".repeat(4000);
        assert_eq!(p(&format!(r#"{{"type":"text","s":"{text}"}}"#)), Some(InputMsg::Text(text)));
        let too_long = "a".repeat(MAX_TEXT_MESSAGE);
        assert_eq!(p(&format!(r#"{{"type":"text","s":"{too_long}"}}"#)), None);
        // The limit is on bytes, and Korean is three bytes a character.
        let korean = "가".repeat(2800);
        assert_eq!(p(&format!(r#"{{"type":"text","s":"{korean}"}}"#)), None);
        let fits = "가".repeat(2700);
        assert!(p(&format!(r#"{{"type":"text","s":"{fits}"}}"#)).is_some());
    }

    #[test]
    fn a_text_message_of_exactly_8_kib_is_accepted_and_one_byte_more_is_refused() {
        let frame = r#"{"type":"text","s":""}"#.len();
        let exact = "a".repeat(MAX_TEXT_MESSAGE - frame);
        let message = format!(r#"{{"type":"text","s":"{exact}"}}"#);
        assert_eq!(message.len(), MAX_TEXT_MESSAGE);
        assert_eq!(p(&message), Some(InputMsg::Text(exact)));
        let over = format!(r#"{{"type":"text","s":"{}"}}"#, "a".repeat(MAX_TEXT_MESSAGE - frame + 1));
        assert_eq!(over.len(), MAX_TEXT_MESSAGE + 1);
        assert_eq!(p(&over), None);
    }

    #[test]
    fn a_512_byte_message_is_the_largest_non_text_message() {
        let base = r#"{"type":"pointer","x":0.5,"y":0.5,"pad":""}"#.len();
        let exact = format!(r#"{{"type":"pointer","x":0.5,"y":0.5,"pad":"{}"}}"#, "x".repeat(MAX_MESSAGE - base));
        assert_eq!(exact.len(), MAX_MESSAGE);
        assert!(p(&exact).is_some());
        let over = format!(r#"{{"type":"pointer","x":0.5,"y":0.5,"pad":"{}"}}"#, "x".repeat(MAX_MESSAGE - base + 1));
        assert_eq!(p(&over), None);
    }

    #[test]
    fn clipboard_messages_parse_with_and_without_concealed() {
        assert_eq!(
            p(r#"{"type":"clipboard","text":"안녕\n😀"}"#),
            Some(InputMsg::Clipboard { text: "안녕\n😀".into(), concealed: false })
        );
        assert_eq!(
            p(r#"{"type":"clipboard","text":"x","concealed":true}"#),
            Some(InputMsg::Clipboard { text: "x".into(), concealed: true })
        );
        assert_eq!(p(r#"{"type":"clipboard-watch","on":true}"#), Some(InputMsg::ClipboardWatch(true)));
        for bad in [
            r#"{"type":"clipboard","text":""}"#,
            r#"{"type":"clipboard","text":5}"#,
            r#"{"type":"clipboard","text":"x","concealed":"yes"}"#,
            r#"{"type":"clipboard-watch","on":1}"#,
            r#"{"type":"clipboard-watch"}"#,
        ] {
            assert_eq!(p(bad), None, "{bad}");
        }
    }

    // Review Focus 3
    #[test]
    fn clipboard_text_is_capped_at_64_kib_of_utf8_not_characters() {
        let fits = "가".repeat(21_845); // 65 535 bytes
        assert!(p(&format!(r#"{{"type":"clipboard","text":"{fits}"}}"#)).is_some());
        assert_eq!(p(&format!(r#"{{"type":"clipboard","text":"{}"}}"#, "가".repeat(21_846))), None);
        let exact = "a".repeat(MAX_CLIPBOARD_TEXT);
        assert!(p(&format!(r#"{{"type":"clipboard","text":"{exact}"}}"#)).is_some());
        assert_eq!(p(&format!(r#"{{"type":"clipboard","text":"{exact}a"}}"#)), None);
    }

    #[test]
    fn only_clipboard_may_exceed_8_kib_and_its_message_stops_at_256_kib() {
        let big = format!(r#"{{"type":"text","s":"{}"}}"#, "a".repeat(MAX_TEXT_MESSAGE));
        assert_eq!(p(&big), None);
        let pad = " ".repeat(MAX_CLIPBOARD_MESSAGE);
        assert_eq!(p(&format!(r#"{{"type":"clipboard","text":"a","pad":"{pad}"}}"#)), None);
        assert_eq!(p(&format!(r#"{{"type":"pointer","x":0.5,"y":0.5,"pad":"{}"}}"#, " ".repeat(600))), None);
        let watch = format!(r#"{{"type":"clipboard-watch","on":true,"pad":"{}"}}"#, " ".repeat(600));
        assert_eq!(p(&watch), None);
    }

    #[test]
    fn notices_are_valid_json_and_only_the_clipboard_one_has_an_input_twin() {
        assert_eq!(lock_notice(true), r#"{"type":"lock","locked":true}"#);
        assert_eq!(
            skipped_notice(SkipReason::LockedMultiline),
            r#"{"type":"clipboard-skipped","reason":"locked-multiline"}"#
        );
        let n = clipboard_notice("a\"\n한", true);
        assert_eq!(serde_json::from_str::<Value>(&n).unwrap()["text"], "a\"\n한");
        for m in [lock_notice(false), skipped_notice(SkipReason::TooLarge)] {
            assert!(parse(m.as_bytes()).is_none());
        }
        // `clipboard` has the same shape in both directions on purpose: the page's message and the
        // agent's notice differ only in who sends them (the agent never reads its own notices).
        assert_eq!(parse(n.as_bytes()), Some(InputMsg::Clipboard { text: "a\"\n한".into(), concealed: true }));
    }

    #[test]
    fn skip_reasons_use_the_wire_names() {
        for (reason, name) in [
            (SkipReason::TooLarge, "too-large"),
            (SkipReason::ReadDenied, "read-denied"),
            (SkipReason::LockedMultiline, "locked-multiline"),
            (SkipReason::LockedEmpty, "locked-empty"),
        ] {
            assert_eq!(reason.as_str(), name);
        }
    }
}
