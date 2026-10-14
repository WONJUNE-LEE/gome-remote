//! The `input` data channel (spec D4): one JSON message per data channel message,
//! at most 512 bytes (`text`: 8 KiB). Anything out of range, malformed or unknown is
//! dropped, never clamped or guessed at.
use crate::keymap::{self, KeyAction};
use crate::size::{self, Size};
use serde_json::Value;

pub const MAX_MESSAGE: usize = 512;
pub const MAX_TEXT_MESSAGE: usize = 8 * 1024;
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
}

fn unit(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite() && (0.0..=1.0).contains(n))
}
fn flag(v: &Value) -> Option<bool> {
    v.as_bool()
}

pub fn parse(data: &[u8]) -> Option<InputMsg> {
    if data.len() > MAX_TEXT_MESSAGE {
        return None;
    }
    let value: Value = serde_json::from_slice(data).ok()?;
    let object = value.as_object()?;
    let kind = object.get("type")?.as_str()?;
    if kind != "text" && data.len() > MAX_MESSAGE {
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
    fn only_text_may_exceed_512_bytes_and_nothing_exceeds_8_kib() {
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
    fn a_512_byte_message_is_the_largest_non_text_message() {
        let base = r#"{"type":"pointer","x":0.5,"y":0.5,"pad":""}"#.len();
        let exact = format!(r#"{{"type":"pointer","x":0.5,"y":0.5,"pad":"{}"}}"#, "x".repeat(MAX_MESSAGE - base));
        assert_eq!(exact.len(), MAX_MESSAGE);
        assert!(p(&exact).is_some());
        let over = format!(r#"{{"type":"pointer","x":0.5,"y":0.5,"pad":"{}"}}"#, "x".repeat(MAX_MESSAGE - base + 1));
        assert_eq!(p(&over), None);
    }
}
