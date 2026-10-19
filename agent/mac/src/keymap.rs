//! `KeyboardEvent.code` (physical key position) to macOS virtual key codes (the
//! `kVK_*` values of Carbon's Events.h). Modifiers keep their physical positions:
//! Control is Control, Alt is Option, the Windows/Meta key is Command (spec D4).
//! A code that is not in the table is dropped by the caller.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyAction {
    /// Post this virtual key code.
    Code(u16),
    /// The Windows Hangul/English key: one Caps Lock tap, which macOS maps to the
    /// 한/A input-source switch (spec D4, O3).
    CapsLockTap,
}

pub const KEY_CAPS_LOCK: u16 = 57;

const TABLE: &[(&str, u16)] = &[
    ("KeyA", 0),
    ("KeyS", 1),
    ("KeyD", 2),
    ("KeyF", 3),
    ("KeyH", 4),
    ("KeyG", 5),
    ("KeyZ", 6),
    ("KeyX", 7),
    ("KeyC", 8),
    ("KeyV", 9),
    ("IntlBackslash", 10),
    ("KeyB", 11),
    ("KeyQ", 12),
    ("KeyW", 13),
    ("KeyE", 14),
    ("KeyR", 15),
    ("KeyY", 16),
    ("KeyT", 17),
    ("Digit1", 18),
    ("Digit2", 19),
    ("Digit3", 20),
    ("Digit4", 21),
    ("Digit6", 22),
    ("Digit5", 23),
    ("Equal", 24),
    ("Digit9", 25),
    ("Digit7", 26),
    ("Minus", 27),
    ("Digit8", 28),
    ("Digit0", 29),
    ("BracketRight", 30),
    ("KeyO", 31),
    ("KeyU", 32),
    ("BracketLeft", 33),
    ("KeyI", 34),
    ("KeyP", 35),
    ("Enter", 36),
    ("KeyL", 37),
    ("KeyJ", 38),
    ("Quote", 39),
    ("KeyK", 40),
    ("Semicolon", 41),
    ("Backslash", 42),
    ("Comma", 43),
    ("Slash", 44),
    ("KeyN", 45),
    ("KeyM", 46),
    ("Period", 47),
    ("Tab", 48),
    ("Space", 49),
    ("Backquote", 50),
    ("Backspace", 51),
    ("Escape", 53),
    ("MetaRight", 54),
    ("MetaLeft", 55),
    ("ShiftLeft", 56),
    ("CapsLock", 57),
    ("AltLeft", 58),
    ("ControlLeft", 59),
    ("ShiftRight", 60),
    ("AltRight", 61),
    ("ControlRight", 62),
    ("F17", 64),
    ("NumpadDecimal", 65),
    ("NumpadMultiply", 67),
    ("NumpadAdd", 69),
    ("NumpadDivide", 75),
    ("NumpadEnter", 76),
    ("NumpadSubtract", 78),
    ("F18", 79),
    ("F19", 80),
    ("NumpadEqual", 81),
    ("Numpad0", 82),
    ("Numpad1", 83),
    ("Numpad2", 84),
    ("Numpad3", 85),
    ("Numpad4", 86),
    ("Numpad5", 87),
    ("Numpad6", 88),
    ("Numpad7", 89),
    ("F20", 90),
    ("Numpad8", 91),
    ("Numpad9", 92),
    ("IntlYen", 93),
    ("IntlRo", 94),
    ("F5", 96),
    ("F6", 97),
    ("F7", 98),
    ("F3", 99),
    ("F8", 100),
    ("F9", 101),
    ("F11", 103),
    ("KanaMode", 104),
    ("F13", 105),
    ("F16", 106),
    ("F14", 107),
    ("F10", 109),
    ("ContextMenu", 110),
    ("F12", 111),
    ("F15", 113),
    ("Insert", 114),
    ("Home", 115),
    ("PageUp", 116),
    ("Delete", 117),
    ("F4", 118),
    ("End", 119),
    ("F2", 120),
    ("PageDown", 121),
    ("F1", 122),
    ("ArrowLeft", 123),
    ("ArrowRight", 124),
    ("ArrowDown", 125),
    ("ArrowUp", 126),
];

pub fn lookup(code: &str) -> Option<KeyAction> {
    if code == "Lang1" || code == "HangulMode" {
        return Some(KeyAction::CapsLockTap);
    }
    TABLE.iter().find(|(name, _)| *name == code).map(|(_, key)| KeyAction::Code(*key))
}

/// The physical key and Shift state that type `c` on the ABC/US layout (virtual key code,
/// Shift), built from `TABLE`. `None` for anything that layout cannot type, which the caller
/// types as Unicode instead. Used for the lock screen, where a Unicode event is not enough.
pub fn us_key(c: char) -> Option<(u16, bool)> {
    let (code, shift): (String, bool) = match c {
        'a'..='z' => (format!("Key{}", c.to_ascii_uppercase()), false),
        'A'..='Z' => (format!("Key{c}"), true),
        '0'..='9' => (format!("Digit{c}"), false),
        ' ' => ("Space".into(), false),
        _ => {
            let (name, shift) = match c {
                '!' => ("Digit1", true),
                '@' => ("Digit2", true),
                '#' => ("Digit3", true),
                '$' => ("Digit4", true),
                '%' => ("Digit5", true),
                '^' => ("Digit6", true),
                '&' => ("Digit7", true),
                '*' => ("Digit8", true),
                '(' => ("Digit9", true),
                ')' => ("Digit0", true),
                '-' => ("Minus", false),
                '_' => ("Minus", true),
                '=' => ("Equal", false),
                '+' => ("Equal", true),
                '[' => ("BracketLeft", false),
                '{' => ("BracketLeft", true),
                ']' => ("BracketRight", false),
                '}' => ("BracketRight", true),
                '\\' => ("Backslash", false),
                '|' => ("Backslash", true),
                ';' => ("Semicolon", false),
                ':' => ("Semicolon", true),
                '\'' => ("Quote", false),
                '"' => ("Quote", true),
                ',' => ("Comma", false),
                '<' => ("Comma", true),
                '.' => ("Period", false),
                '>' => ("Period", true),
                '/' => ("Slash", false),
                '?' => ("Slash", true),
                '`' => ("Backquote", false),
                '~' => ("Backquote", true),
                _ => return None,
            };
            (name.into(), shift)
        }
    };
    match lookup(&code) {
        Some(KeyAction::Code(key)) => Some((key, shift)),
        _ => None,
    }
}

/// Shift, Control, Option, Command and Caps Lock change the flags of every later event.
pub fn modifier_flag(key: u16) -> Option<u64> {
    match key {
        56 | 60 => Some(0x0002_0000), // shift
        59 | 62 => Some(0x0004_0000), // control
        58 | 61 => Some(0x0008_0000), // option
        55 | 54 => Some(0x0010_0000), // command
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn well_known_keys_map_to_their_virtual_key_codes() {
        for (code, key) in [
            ("KeyA", 0),
            ("KeyZ", 6),
            ("KeyM", 46),
            ("Digit1", 18),
            ("Digit0", 29),
            ("Enter", 36),
            ("Tab", 48),
            ("Space", 49),
            ("Backspace", 51),
            ("Escape", 53),
            ("ArrowLeft", 123),
            ("ArrowUp", 126),
            ("F1", 122),
            ("F12", 111),
            ("Delete", 117),
            ("Home", 115),
            ("End", 119),
            ("PageUp", 116),
            ("PageDown", 121),
            ("NumpadEnter", 76),
            ("Numpad0", 82),
            ("Numpad9", 92),
            ("Backquote", 50),
            ("IntlBackslash", 10),
        ] {
            assert_eq!(lookup(code), Some(KeyAction::Code(key)), "{code}");
        }
    }

    #[test]
    fn us_key_covers_letters_digits_and_symbols_with_shift() {
        for (c, expect) in [
            ('a', (0, false)),
            ('A', (0, true)),
            ('1', (18, false)),
            ('!', (18, true)),
            ('@', (19, true)),
            ('-', (27, false)),
            ('_', (27, true)),
            ('`', (50, false)),
            ('~', (50, true)),
            (' ', (49, false)),
            ('/', (44, false)),
            ('?', (44, true)),
            ('\\', (42, false)),
            ('|', (42, true)),
            ('\'', (39, false)),
            ('"', (39, true)),
        ] {
            assert_eq!(us_key(c), Some(expect), "{c}");
        }
        for c in ['é', '한', '😀', '€'] {
            assert_eq!(us_key(c), None, "{c}");
        }
    }

    #[test]
    fn every_printable_ascii_character_has_a_key() {
        for c in ' '..='~' {
            assert!(us_key(c).is_some(), "{c:?}");
        }
    }

    #[test]
    fn modifiers_keep_their_physical_positions() {
        assert_eq!(lookup("ControlLeft"), Some(KeyAction::Code(59)));
        assert_eq!(lookup("AltLeft"), Some(KeyAction::Code(58)), "Alt is Option");
        assert_eq!(lookup("AltRight"), Some(KeyAction::Code(61)));
        assert_eq!(lookup("MetaLeft"), Some(KeyAction::Code(55)), "Windows key is Command");
        assert_eq!(lookup("MetaRight"), Some(KeyAction::Code(54)));
        assert_eq!(lookup("ShiftRight"), Some(KeyAction::Code(60)));
        assert_eq!(lookup("CapsLock"), Some(KeyAction::Code(KEY_CAPS_LOCK)));
    }

    #[test]
    fn both_spellings_of_the_hangul_key_become_one_caps_lock_tap() {
        assert_eq!(lookup("Lang1"), Some(KeyAction::CapsLockTap));
        assert_eq!(lookup("HangulMode"), Some(KeyAction::CapsLockTap));
    }

    #[test]
    fn unknown_codes_are_dropped() {
        for code in
            ["", "Unidentified", "keya", "KeyAA", "Lang2", "PrintScreen", "Pause", "F21", "MediaPlayPause", "Key A"]
        {
            assert_eq!(lookup(code), None, "{code:?}");
        }
    }

    #[test]
    fn the_table_has_no_duplicate_code_or_key() {
        let names: HashSet<_> = TABLE.iter().map(|(n, _)| *n).collect();
        let keys: HashSet<_> = TABLE.iter().map(|(_, k)| *k).collect();
        assert_eq!(names.len(), TABLE.len(), "a code appears twice");
        assert_eq!(keys.len(), TABLE.len(), "a virtual key code appears twice");
    }

    #[test]
    fn all_letters_digits_and_function_keys_are_present() {
        for c in 'A'..='Z' {
            assert!(lookup(&format!("Key{c}")).is_some(), "Key{c}");
        }
        for d in 0..=9 {
            assert!(lookup(&format!("Digit{d}")).is_some(), "Digit{d}");
            assert!(lookup(&format!("Numpad{d}")).is_some(), "Numpad{d}");
        }
        for f in 1..=20 {
            assert!(lookup(&format!("F{f}")).is_some(), "F{f}");
        }
    }

    #[test]
    fn modifier_flags_cover_both_sides_of_each_modifier() {
        assert_eq!(modifier_flag(56), modifier_flag(60));
        assert_eq!(modifier_flag(59), modifier_flag(62));
        assert_eq!(modifier_flag(58), modifier_flag(61));
        assert_eq!(modifier_flag(55), modifier_flag(54));
        assert_eq!(modifier_flag(0), None);
        assert_eq!(modifier_flag(KEY_CAPS_LOCK), None, "Caps Lock is a toggle, not a held modifier");
        let all: HashSet<_> = [56, 59, 58, 55].iter().map(|k| modifier_flag(*k).unwrap()).collect();
        assert_eq!(all.len(), 4);
    }
}
