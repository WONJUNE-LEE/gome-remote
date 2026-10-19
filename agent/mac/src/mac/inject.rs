//! Input injection with `CGEventPost` (spec D4). New in the production agent (the spike
//! only clicked): drags, three buttons, double clicks, wheel, modifiers, auto-repeat, the
//! Hangul key, typed text, and releasing everything that is down. The decisions live in
//! the platform-independent `protocol`, `keymap`, `pressed` and `typing` modules.
use super::ffi::*;
use super::system;
use crate::keymap::{self, KeyAction, KEY_CAPS_LOCK};
use crate::pressed::{ClickCounter, Pressed};
use crate::protocol::{Button, InputMsg};
use crate::typing::{self, TypeStep};
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::Mutex;
use std::time::Instant;

const KEY_RETURN: u16 = 36;
const KEY_TAB: u16 = 48;
const KEY_SHIFT: u16 = 56;
const SHIFT_FLAG: u64 = 0x0002_0000;
/// kCGHIDEventTap
const HID_TAP: u32 = 0;
/// kCGScrollEventUnitPixel
const SCROLL_PIXEL: u32 = 0;

struct State {
    pressed: Pressed,
    clicks: ClickCounter,
    /// Last mouse position in points, to skip a move to where the cursor already is.
    at: Option<(f64, f64)>,
    last_click_state: i64,
}

pub struct Injector {
    state: Mutex<State>,
    warned: AtomicBool,
}

fn post(event: CFTypeRef) {
    if !event.is_null() {
        unsafe {
            CGEventPost(HID_TAP, event);
            CFRelease(event);
        }
    }
}

fn button_number(button: Button) -> u32 {
    match button {
        Button::Left => 0,
        Button::Right => 1,
        Button::Middle => 2,
    }
}
fn down_type(button: Button) -> u32 {
    match button {
        Button::Left => kCGEventLeftMouseDown,
        Button::Right => kCGEventRightMouseDown,
        Button::Middle => kCGEventOtherMouseDown,
    }
}
fn up_type(button: Button) -> u32 {
    match button {
        Button::Left => kCGEventLeftMouseUp,
        Button::Right => kCGEventRightMouseUp,
        Button::Middle => kCGEventOtherMouseUp,
    }
}
fn drag_type(button: Button) -> u32 {
    match button {
        Button::Left => kCGEventLeftMouseDragged,
        Button::Right => kCGEventRightMouseDragged,
        Button::Middle => kCGEventOtherMouseDragged,
    }
}

fn point(x: f64, y: f64) -> CGPoint {
    let b = system::main_bounds();
    CGPoint { x: b.origin.x + x * b.size.width, y: b.origin.y + y * b.size.height }
}

fn post_mouse(kind: u32, at: CGPoint, button: u32, flags: u64, click_state: Option<i64>) {
    unsafe {
        let event = CGEventCreateMouseEvent(std::ptr::null(), kind, at, button);
        if event.is_null() {
            return;
        }
        CGEventSetFlags(event, flags);
        if let Some(count) = click_state {
            CGEventSetIntegerValueField(event, kCGMouseEventClickState, count);
        }
        post(event);
    }
}

fn post_key(key: u16, down: bool, flags: u64, repeat: bool) {
    unsafe {
        let event = CGEventCreateKeyboardEvent(std::ptr::null(), key, down);
        if event.is_null() {
            return;
        }
        CGEventSetFlags(event, flags);
        if repeat {
            CGEventSetIntegerValueField(event, kCGKeyboardEventAutorepeat, 1);
        }
        post(event);
    }
}

/// Modifier keys are not key events: macOS wants a flags-changed event carrying the new set.
fn post_modifier(key: u16, flags: u64) {
    unsafe {
        let event = CGEventCreateKeyboardEvent(std::ptr::null(), key, true);
        if event.is_null() {
            return;
        }
        CGEventSetType(event, kCGEventFlagsChanged);
        CGEventSetFlags(event, flags);
        post(event);
    }
}

fn post_scroll(dx: i32, dy: i32) {
    unsafe {
        // CoreGraphics counts positive as "scroll up"; the page sends the DOM sign.
        post(CGEventCreateScrollWheelEvent2(std::ptr::null(), SCROLL_PIXEL, 2, -dy, -dx, 0));
    }
}

fn post_units(units: &[u16], flags: u64) {
    unsafe {
        for down in [true, false] {
            let event = CGEventCreateKeyboardEvent(std::ptr::null(), 0, down);
            if event.is_null() {
                continue;
            }
            CGEventKeyboardSetUnicodeString(event, units.len(), units.as_ptr());
            CGEventSetFlags(event, flags);
            post(event);
        }
    }
}

impl Default for Injector {
    fn default() -> Self {
        Injector {
            state: Mutex::new(State {
                pressed: Pressed::default(),
                clicks: ClickCounter::default(),
                at: None,
                last_click_state: 1,
            }),
            warned: AtomicBool::new(false),
        }
    }
}

impl Injector {
    /// A panic while the state was held must not stop `release_all` from ever running again.
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn handle(&self, message: InputMsg) {
        if !system::accessibility_granted() {
            if !self.warned.swap(true, Relaxed) {
                eprintln!(
                    "[input] Accessibility is not granted: input is ignored until it is allowed and the agent restarts"
                );
            }
            return;
        }
        let mut s = self.lock();
        match message {
            InputMsg::Pointer { x, y } => self.move_to(&mut s, x, y),
            InputMsg::Button { button, down, x, y } => {
                self.move_to(&mut s, x, y);
                if !s.pressed.button(button, down) {
                    return; // already in that state
                }
                let at = point(x, y);
                let flags = s.pressed.flags();
                if down {
                    let count = s.clicks.on_down(button, Instant::now(), x, y);
                    s.last_click_state = count;
                    post_mouse(down_type(button), at, button_number(button), flags, Some(count));
                } else {
                    post_mouse(up_type(button), at, button_number(button), flags, Some(s.last_click_state));
                }
            }
            InputMsg::Wheel { dx, dy } => post_scroll(dx, dy),
            InputMsg::Key { action: KeyAction::Code(key), down } => {
                if keymap::modifier_flag(key).is_some() {
                    s.pressed.key(key, down);
                    post_modifier(key, s.pressed.flags());
                } else {
                    let repeat = s.pressed.key(key, down);
                    post_key(key, down, s.pressed.flags(), repeat);
                }
            }
            InputMsg::Key { action: KeyAction::CapsLockTap, down } => {
                // One tap per press of the Hangul key: an auto-repeated key-down and the
                // release do not tap again.
                if s.pressed.hangul(down) {
                    post_key(KEY_CAPS_LOCK, true, 0, false);
                    post_key(KEY_CAPS_LOCK, false, 0, false);
                }
            }
            InputMsg::Text(text) => {
                for step in typing::plan(&text) {
                    match step {
                        TypeStep::Return => {
                            post_key(KEY_RETURN, true, 0, false);
                            post_key(KEY_RETURN, false, 0, false);
                        }
                        TypeStep::Tab => {
                            post_key(KEY_TAB, true, 0, false);
                            post_key(KEY_TAB, false, 0, false);
                        }
                        TypeStep::Units(units) => post_units(&units, 0),
                        TypeStep::Key { .. } => {} // only `plan_keys` makes Key steps
                    }
                }
            }
            InputMsg::Release => self.release_locked(&mut s),
            InputMsg::Size(_) => {} // handled by the session, not by the injector
            InputMsg::Clipboard { .. } | InputMsg::ClipboardWatch(_) => {} // handled by the session, not by the injector
        }
    }

    /// Types single-line text as key codes, for the lock screen's password field, which
    /// ignores Unicode events. Characters the ABC/US layout cannot type go as Unicode. The
    /// physical `Pressed` flags are ignored (Command may still be held from the paste
    /// shortcut), so every event carries only the Shift this character needs.
    pub fn type_keys(&self, text: &str) {
        if !system::accessibility_granted() {
            return;
        }
        let _guard = self.lock(); // no other input interleaves with the typing
        for step in typing::plan_keys(text) {
            match step {
                TypeStep::Key { code, shift } => {
                    let flags = if shift { SHIFT_FLAG } else { 0 };
                    if shift {
                        post_modifier(KEY_SHIFT, SHIFT_FLAG);
                    }
                    post_key(code, true, flags, false);
                    post_key(code, false, flags, false);
                    if shift {
                        post_modifier(KEY_SHIFT, 0);
                    }
                }
                TypeStep::Tab => {
                    post_key(KEY_TAB, true, 0, false);
                    post_key(KEY_TAB, false, 0, false);
                }
                TypeStep::Units(units) => post_units(&units, 0),
                TypeStep::Return => {} // `plan_keys` never makes Return
            }
        }
    }

    fn move_to(&self, s: &mut State, x: f64, y: f64) {
        let at = point(x, y);
        if s.at == Some((at.x, at.y)) {
            return; // the cursor is already there; a move would only cost time
        }
        s.at = Some((at.x, at.y));
        let held = s.pressed.held_button();
        let (kind, number) = match held {
            Some(b) => (drag_type(b), button_number(b)),
            None => (kCGEventMouseMoved, 0),
        };
        post_mouse(kind, at, number, s.pressed.flags(), None);
    }

    /// Releases every key and button that is down (data channel closed, session replaced,
    /// page blur). Safe to call at any time.
    pub fn release_all(&self) {
        let mut s = self.lock();
        self.release_locked(&mut s);
    }

    fn release_locked(&self, s: &mut State) {
        let mut flags = s.pressed.flags();
        let (keys, buttons) = s.pressed.drain();
        for key in keys {
            if let Some(flag) = keymap::modifier_flag(key) {
                flags &= !flag;
                post_modifier(key, flags);
            } else {
                post_key(key, false, flags, false);
            }
        }
        if let Some((x, y)) = s.at {
            let at = CGPoint { x, y };
            for button in buttons {
                post_mouse(up_type(button), at, button_number(button), 0, Some(s.last_click_state));
            }
        }
        s.clicks = ClickCounter::default();
    }
}
