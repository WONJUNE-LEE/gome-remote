//! Device check for input injection, without WebRTC. After a five second countdown it
//! drives the real `Injector` the way the page would: moves the pointer, double-clicks,
//! presses Command+A, types Korean, English and an emoji as text, presses a drag, and
//! lets everything go. Run it from Terminal on the Mac, which needs the Accessibility
//! permission for this; open TextEdit with an empty document first and click into it:
//!
//!   cargo run --release --example input_probe
//!
//! Expected in TextEdit: the typed text `한글 abc 😀` followed by a line break and `line two`,
//! the whole text selected by Command+A at one point (it is typed afterwards, so the final
//! document holds only the text typed after the selection), and the pointer visibly moving
//! to the screen centre where the double click selects a word under it.
#[cfg(target_os = "macos")]
fn main() {
    use gome_agent::keymap::KeyAction;
    use gome_agent::mac::inject::Injector;
    use gome_agent::protocol::{Button, InputMsg};
    use std::time::Duration;

    if !gome_agent::mac::system::accessibility_granted() {
        eprintln!("Accessibility is not granted to this program (Terminal): events would be ignored.");
        std::process::exit(1);
    }
    let injector = Injector::default();
    for n in (1..=5).rev() {
        println!("starting in {n} s: click into an empty TextEdit document now");
        std::thread::sleep(Duration::from_secs(1));
    }
    let pause = || std::thread::sleep(Duration::from_millis(300));
    let key = |code, down| InputMsg::Key { action: KeyAction::Code(code), down };

    // Command+A: select everything that is there already.
    injector.handle(key(55, true));
    injector.handle(key(0, true));
    injector.handle(key(0, false));
    injector.handle(key(55, false));
    pause();
    // Typed text replaces the selection: Korean, English, an emoji, a line break.
    injector.handle(InputMsg::Text("한글 abc 😀\r\nline two".to_string()));
    pause();
    // A double click in the middle of the screen (the click count must be 1 then 2).
    injector.handle(InputMsg::Pointer { x: 0.5, y: 0.5 });
    for _ in 0..2 {
        injector.handle(InputMsg::Button { button: Button::Left, down: true, x: 0.5, y: 0.5 });
        injector.handle(InputMsg::Button { button: Button::Left, down: false, x: 0.5, y: 0.5 });
        std::thread::sleep(Duration::from_millis(80));
    }
    pause();
    // A drag, then letting go of a key that is still down: nothing may stay pressed.
    injector.handle(InputMsg::Button { button: Button::Left, down: true, x: 0.4, y: 0.4 });
    for step in 0..10 {
        injector.handle(InputMsg::Pointer { x: 0.4 + 0.02 * step as f64, y: 0.4 });
        std::thread::sleep(Duration::from_millis(20));
    }
    injector.handle(key(56, true)); // Shift stays down...
    injector.release_all(); // ...until this releases it and the button
    injector.handle(InputMsg::Wheel { dx: 0, dy: 120 });
    println!("done: nothing should be stuck (try typing a lowercase letter, then moving the mouse)");
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("input_probe runs on macOS only");
}
