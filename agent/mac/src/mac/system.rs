//! What the status reports and what a session start needs to know about the system:
//! permissions, the display, the lock screen, the screen size.
use super::ffi::*;
use crate::size::Size;
use crate::status::DisplayState;

pub fn screen_recording_granted() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

pub fn accessibility_granted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

/// Asks macOS for both permissions. This is what makes the binary appear in System
/// Settings so the owner can switch it on; it does nothing for a permission already given.
pub fn prompt_for_permissions() {
    unsafe {
        if !CGPreflightScreenCaptureAccess() {
            let _ = CGRequestScreenCaptureAccess();
        }
        let options = cf_dict(&[(kAXTrustedCheckOptionPrompt, kCFBooleanTrue)]);
        let _ = AXIsProcessTrustedWithOptions(options.0);
    }
}

pub fn display_state() -> DisplayState {
    unsafe {
        let id = CGMainDisplayID();
        if id == 0 {
            DisplayState::None
        } else if CGDisplayIsAsleep(id) != 0 {
            DisplayState::Asleep
        } else {
            DisplayState::Ok
        }
    }
}

/// True while the login window or lock screen is up (`CGSSessionScreenIsLocked`).
pub fn screen_locked() -> bool {
    unsafe {
        let session = CGSessionCopyCurrentDictionary();
        if session.is_null() {
            return false;
        }
        let key = cf_string("CGSSessionScreenIsLocked");
        let value = CFDictionaryGetValue(session, key.0);
        let locked = !value.is_null() && value == kCFBooleanTrue;
        CFRelease(session);
        locked
    }
}

/// True while the console is locked (the I/O Registry root's `IOConsoleLocked`). The display
/// merely sleeping leaves it false; the lock screen sets it. False when the key is absent.
pub fn console_locked() -> bool {
    unsafe {
        let root = IORegistryGetRootEntry(0);
        if root == 0 {
            return false;
        }
        let key = cf_string("IOConsoleLocked");
        let value = Cf(IORegistryEntryCreateCFProperty(root, key.0, std::ptr::null(), 0));
        IOObjectRelease(root);
        !value.0.is_null() && value.0 == kCFBooleanTrue
    }
}

/// The main display's size in real pixels (a 4K panel shown as 1920x1080 points is 3840x2160).
pub fn native_pixels() -> Option<Size> {
    unsafe {
        let mode = CGDisplayCopyDisplayMode(CGMainDisplayID());
        if mode.is_null() {
            return None;
        }
        let size = Size { w: CGDisplayModeGetPixelWidth(mode) as u32, h: CGDisplayModeGetPixelHeight(mode) as u32 };
        CFRelease(mode);
        (size.w > 0 && size.h > 0).then_some(size)
    }
}

/// The main display's bounds in points (the coordinate space of mouse events).
pub fn main_bounds() -> CGRect {
    unsafe { CGDisplayBounds(CGMainDisplayID()) }
}
