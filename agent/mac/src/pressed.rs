//! What the injector must remember between messages: which keys and buttons are down (so
//! a closing session can release them all), the modifier flags every event carries, and
//! the click count that makes a double click a double click for macOS.
use crate::keymap::modifier_flag;
use crate::protocol::Button;
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct Pressed {
    keys: Vec<u16>,
    buttons: Vec<Button>,
    hangul_down: bool,
}

impl Pressed {
    /// Records a key transition. Returns true when the key was already down (an auto-repeat).
    pub fn key(&mut self, key: u16, down: bool) -> bool {
        let was = self.keys.contains(&key);
        match (down, was) {
            (true, false) => self.keys.push(key),
            (false, true) => self.keys.retain(|k| *k != key),
            _ => {}
        }
        was && down
    }
    /// Records a button transition. Returns whether it changed anything.
    pub fn button(&mut self, button: Button, down: bool) -> bool {
        let was = self.buttons.contains(&button);
        match (down, was) {
            (true, false) => {
                self.buttons.push(button);
                true
            }
            (false, true) => {
                self.buttons.retain(|b| *b != button);
                true
            }
            _ => false,
        }
    }
    /// Records a transition of the Hangul key (sent as one Caps Lock tap). Returns true only
    /// for the key-down that starts a press: an auto-repeated key-down while the key is held
    /// must not tap again, or the input source would flip back and forth.
    pub fn hangul(&mut self, down: bool) -> bool {
        let first = down && !self.hangul_down;
        self.hangul_down = down;
        first
    }
    pub fn is_key_down(&self, key: u16) -> bool {
        self.keys.contains(&key)
    }
    pub fn held_button(&self) -> Option<Button> {
        self.buttons.last().copied()
    }
    /// The modifier flags implied by the keys that are down.
    pub fn flags(&self) -> u64 {
        self.keys.iter().filter_map(|k| modifier_flag(*k)).fold(0, |a, b| a | b)
    }
    /// Empties the set and returns what was down: keys in the order they were pressed
    /// (released in reverse) and buttons.
    pub fn drain(&mut self) -> (Vec<u16>, Vec<Button>) {
        self.hangul_down = false;
        let mut keys = std::mem::take(&mut self.keys);
        keys.reverse();
        (keys, std::mem::take(&mut self.buttons))
    }
}

/// macOS needs `clickState` 1, 2, 3 on consecutive clicks; a synthetic event stream gets
/// no double click without it.
#[derive(Default)]
pub struct ClickCounter {
    last: Option<(Button, Instant, f64, f64, i64)>,
}
impl ClickCounter {
    pub const WINDOW: Duration = Duration::from_millis(500);
    /// Position is in normalised 0..1 units; "the same place" is within 0.4 % of the screen.
    pub const SLOP: f64 = 0.004;

    pub fn on_down(&mut self, button: Button, at: Instant, x: f64, y: f64) -> i64 {
        let count = match self.last {
            Some((b, t, lx, ly, n))
                if b == button
                    && at.saturating_duration_since(t) <= Self::WINDOW
                    && (x - lx).abs() <= Self::SLOP
                    && (y - ly).abs() <= Self::SLOP =>
            {
                if n >= 3 {
                    1
                } else {
                    n + 1
                }
            }
            _ => 1,
        };
        self.last = Some((button, at, x, y, count));
        count
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pressed_keys_are_tracked_and_released_in_reverse_order() {
        let mut p = Pressed::default();
        assert!(!p.key(55, true), "first press is not a repeat");
        p.key(8, true);
        p.key(9, true);
        p.key(8, false);
        let (keys, buttons) = p.drain();
        assert_eq!(keys, vec![9, 55]);
        assert!(buttons.is_empty());
        assert_eq!(p.drain().0, Vec::<u16>::new(), "drain empties the set");
    }

    #[test]
    fn a_second_key_down_is_an_auto_repeat_and_a_stray_key_up_is_ignored() {
        let mut p = Pressed::default();
        p.key(0, true);
        assert!(p.key(0, true));
        assert!(!p.key(5, false));
        assert!(!p.is_key_down(5));
        p.key(0, false);
        assert!(!p.is_key_down(0));
    }

    #[test]
    // Controller ruling: a held Hangul key auto-repeats key-downs, and each one would toggle
    // the input source again.
    fn the_hangul_key_taps_on_the_first_key_down_only() {
        let mut p = Pressed::default();
        assert!(p.hangul(true), "first key-down taps");
        assert!(!p.hangul(true), "auto-repeat does not tap");
        assert!(!p.hangul(true), "nor the next one");
        assert!(!p.hangul(false), "key-up never taps");
        assert!(p.hangul(true), "a new press taps again");
        assert!(!p.hangul(false));
        assert!(!p.hangul(false), "a stray key-up taps nothing");
        assert!(p.hangul(true));
        p.drain();
        assert!(p.hangul(true), "release-all forgets a held Hangul key");
        assert!(p.drain().0.is_empty(), "the Hangul key is never posted as a held key");
    }

    #[test]
    fn buttons_report_whether_anything_changed() {
        let mut p = Pressed::default();
        assert!(p.button(Button::Left, true));
        assert!(!p.button(Button::Left, true), "already down");
        assert_eq!(p.held_button(), Some(Button::Left));
        assert!(p.button(Button::Right, true));
        assert_eq!(p.held_button(), Some(Button::Right), "the newest held button drives drags");
        assert!(p.button(Button::Left, false));
        assert!(!p.button(Button::Left, false), "already up");
        assert_eq!(p.drain().1, vec![Button::Right]);
    }

    #[test]
    fn flags_follow_the_modifiers_that_are_down() {
        let mut p = Pressed::default();
        assert_eq!(p.flags(), 0);
        p.key(55, true); // command
        p.key(56, true); // shift
        assert_eq!(p.flags(), 0x0010_0000 | 0x0002_0000);
        p.key(60, true); // right shift adds nothing new
        assert_eq!(p.flags(), 0x0010_0000 | 0x0002_0000);
        p.key(55, false);
        assert_eq!(p.flags(), 0x0002_0000);
        p.key(0, true); // a letter is not a modifier
        assert_eq!(p.flags(), 0x0002_0000);
    }

    #[test]
    // Review Focus 2: macOS needs a click count, or a double click never opens a folder.
    fn consecutive_clicks_in_the_same_place_count_up_and_wrap_after_three() {
        let t0 = Instant::now();
        let mut c = ClickCounter::default();
        assert_eq!(c.on_down(Button::Left, t0, 0.5, 0.5), 1);
        assert_eq!(c.on_down(Button::Left, t0 + Duration::from_millis(200), 0.5, 0.5), 2);
        assert_eq!(c.on_down(Button::Left, t0 + Duration::from_millis(400), 0.501, 0.5), 3);
        assert_eq!(c.on_down(Button::Left, t0 + Duration::from_millis(600), 0.5, 0.5), 1);
    }

    #[test]
    fn a_click_exactly_at_the_window_or_the_slop_still_counts_and_one_hair_past_either_does_not() {
        let t0 = Instant::now();
        let mut c = ClickCounter::default();
        c.on_down(Button::Left, t0, 0.0, 0.0);
        assert_eq!(c.on_down(Button::Left, t0 + ClickCounter::WINDOW, 0.0, 0.0), 2, "exactly the window");
        let t1 = t0 + Duration::from_secs(5);
        c.on_down(Button::Left, t1, 0.0, 0.0);
        let just_late = ClickCounter::WINDOW + Duration::from_nanos(1);
        assert_eq!(c.on_down(Button::Left, t1 + just_late, 0.0, 0.0), 1, "a nanosecond past it");
        // Positions are chosen so that the distance is exactly SLOP in floating point.
        let t2 = t1 + Duration::from_secs(5);
        c.on_down(Button::Left, t2, 0.0, 0.0);
        assert_eq!(c.on_down(Button::Left, t2 + Duration::from_millis(10), ClickCounter::SLOP, 0.0), 2, "x at SLOP");
        let t3 = t2 + Duration::from_secs(5);
        c.on_down(Button::Left, t3, 0.0, 0.0);
        assert_eq!(c.on_down(Button::Left, t3 + Duration::from_millis(10), 0.0, ClickCounter::SLOP), 2, "y at SLOP");
        let t4 = t3 + Duration::from_secs(5);
        c.on_down(Button::Left, t4, 0.0, 0.0);
        let past = ClickCounter::SLOP * 1.001;
        assert_eq!(c.on_down(Button::Left, t4 + Duration::from_millis(10), past, 0.0), 1, "x past SLOP");
        let t5 = t4 + Duration::from_secs(5);
        c.on_down(Button::Left, t5, 0.0, 0.0);
        assert_eq!(c.on_down(Button::Left, t5 + Duration::from_millis(10), 0.0, past), 1, "y past SLOP");
    }

    #[test]
    fn a_slow_far_or_different_button_click_starts_over() {
        let t0 = Instant::now();
        let mut c = ClickCounter::default();
        c.on_down(Button::Left, t0, 0.5, 0.5);
        assert_eq!(c.on_down(Button::Left, t0 + Duration::from_millis(501), 0.5, 0.5), 1, "too slow");
        let t1 = t0 + Duration::from_secs(5);
        c.on_down(Button::Left, t1, 0.5, 0.5);
        assert_eq!(c.on_down(Button::Left, t1 + Duration::from_millis(100), 0.6, 0.5), 1, "too far");
        let t2 = t1 + Duration::from_secs(5);
        c.on_down(Button::Left, t2, 0.5, 0.5);
        assert_eq!(c.on_down(Button::Right, t2 + Duration::from_millis(100), 0.5, 0.5), 1, "other button");
    }
}
