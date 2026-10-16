//! Typing text as Unicode key events (spec D4, "텍스트 입력 창"): the clipboard is never
//! touched. `CGEventKeyboardSetUnicodeString` takes at most 20 UTF-16 units per event.

pub const MAX_UNITS: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypeStep {
    /// Press and release Return (virtual key 36).
    Return,
    /// Press and release Tab (virtual key 48).
    Tab,
    /// Type these UTF-16 units as one event pair (at most `MAX_UNITS`).
    Units(Vec<u16>),
}

/// Breaks text into steps. CR, LF and CRLF each become one Return; tab becomes Tab; other
/// control characters are dropped; everything else is typed, never splitting a surrogate pair.
pub fn plan(text: &str) -> Vec<TypeStep> {
    let mut steps = Vec::new();
    let mut run: Vec<u16> = Vec::new();
    let flush = |run: &mut Vec<u16>, steps: &mut Vec<TypeStep>| {
        if !run.is_empty() {
            steps.push(TypeStep::Units(std::mem::take(run)));
        }
    };
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' | '\n' => {
                if c == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
                flush(&mut run, &mut steps);
                steps.push(TypeStep::Return);
            }
            '\t' => {
                flush(&mut run, &mut steps);
                steps.push(TypeStep::Tab);
            }
            c if c.is_control() => {}
            c => {
                let mut units = [0u16; 2];
                let encoded = c.encode_utf16(&mut units);
                if run.len() + encoded.len() > MAX_UNITS {
                    flush(&mut run, &mut steps);
                }
                run.extend_from_slice(encoded);
            }
        }
    }
    flush(&mut run, &mut steps);
    steps
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn short_text_is_one_step() {
        assert_eq!(plan("hello"), vec![TypeStep::Units(units("hello"))]);
        assert_eq!(plan("한글 입력"), vec![TypeStep::Units(units("한글 입력"))]);
        assert_eq!(plan(""), vec![]);
    }

    #[test]
    fn line_breaks_become_returns_and_crlf_is_one() {
        assert_eq!(
            plan("a\r\nb\nc\rd"),
            vec![
                TypeStep::Units(units("a")),
                TypeStep::Return,
                TypeStep::Units(units("b")),
                TypeStep::Return,
                TypeStep::Units(units("c")),
                TypeStep::Return,
                TypeStep::Units(units("d")),
            ]
        );
        assert_eq!(plan("\n\n"), vec![TypeStep::Return, TypeStep::Return]);
    }

    #[test]
    fn tab_is_a_key_and_other_control_characters_are_dropped() {
        assert_eq!(plan("a\tb"), vec![TypeStep::Units(units("a")), TypeStep::Tab, TypeStep::Units(units("b"))]);
        assert_eq!(plan("a\u{0}\u{7}\u{1b}b"), vec![TypeStep::Units(units("ab"))]);
    }

    #[test]
    fn long_text_is_chunked_at_20_units() {
        let steps = plan(&"x".repeat(45));
        let sizes: Vec<usize> = steps
            .iter()
            .map(|s| match s {
                TypeStep::Units(u) => u.len(),
                _ => 0,
            })
            .collect();
        assert_eq!(sizes, vec![20, 20, 5]);
    }

    #[test]
    // Review Focus 3: text pasted into the text window is emoji, line breaks and long.
    fn a_surrogate_pair_is_never_split_across_chunks() {
        // 19 units, then an emoji (2 units) that would be units 20 and 21.
        let text = format!("{}😀tail", "a".repeat(19));
        let steps = plan(&text);
        for step in &steps {
            if let TypeStep::Units(u) = step {
                assert!(u.len() <= MAX_UNITS);
                if let Some(last) = u.last() {
                    assert!(!(0xD800..0xDC00).contains(last), "chunk ends in a lone high surrogate");
                }
                if let Some(first) = u.first() {
                    assert!(!(0xDC00..0xE000).contains(first), "chunk starts with a lone low surrogate");
                }
            }
        }
        let rejoined: Vec<u16> = steps
            .iter()
            .flat_map(|s| match s {
                TypeStep::Units(u) => u.clone(),
                _ => vec![],
            })
            .collect();
        assert_eq!(String::from_utf16(&rejoined).unwrap(), text);
    }
}
