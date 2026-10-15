//! The agent's status (spec D5): enumerations and a timestamp, nothing about screen content.
use std::fmt::Write as _;

/// P1's switch. The lock-screen pre-test passed on the owner's Mac on 2026-10-16 (the agent
/// captured the lock screen and typed into the password field), so a locked screen does not
/// refuse a session: the Mac is unlocked through the agent. `LOCKED_TILE_ENABLED` in
/// `src/tiles.ts` is the page's half of the same switch.
pub const REFUSE_WHEN_LOCKED: bool = false;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Granted,
    Denied,
    /// Permission says yes but only content-free frames arrive (P4: the 30-day recheck).
    Suspect,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Accessibility {
    Granted,
    Denied,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisplayState {
    Ok,
    Asleep,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub screen: Screen,
    pub accessibility: Accessibility,
    pub display: DisplayState,
    pub locked: bool,
    /// Seconds since the epoch of the last captured frame that had content.
    pub last_capture_at: Option<u64>,
    pub version: &'static str,
}

/// Why a session is refused for a state reason; the gateway passes the code to the page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    Permission,
    Locked,
}
impl Gate {
    pub fn code(self) -> &'static str {
        match self {
            Gate::Permission => "permission",
            Gate::Locked => "locked",
        }
    }
    pub fn http_status(self) -> u16 {
        match self {
            Gate::Permission => 403,
            Gate::Locked => 423,
        }
    }
}

/// The status' `screen`: the system's permission answer wins, then the capture's suspicion
/// (black frames, or a stream the system stopped while the permission still reads granted).
pub fn screen_of(permission_granted: bool, suspect: bool) -> Screen {
    if !permission_granted {
        Screen::Denied
    } else if suspect {
        Screen::Suspect
    } else {
        Screen::Granted
    }
}

impl Status {
    pub fn gate(&self, refuse_when_locked: bool) -> Result<(), Gate> {
        // `Suspect` still lets a session start: a session is how the suspicion is cleared.
        if self.screen == Screen::Denied || self.accessibility == Accessibility::Denied {
            return Err(Gate::Permission);
        }
        if self.locked && refuse_when_locked {
            return Err(Gate::Locked);
        }
        Ok(())
    }

    pub fn to_json(&self) -> String {
        let screen = match self.screen {
            Screen::Granted => "granted",
            Screen::Denied => "denied",
            Screen::Suspect => "suspect",
        };
        let accessibility = match self.accessibility {
            Accessibility::Granted => "granted",
            Accessibility::Denied => "denied",
        };
        let display = match self.display {
            DisplayState::Ok => "ok",
            DisplayState::Asleep => "asleep",
            DisplayState::None => "none",
        };
        let mut out = String::new();
        let _ = write!(
            out,
            "{{\"version\":\"{}\",\"screen\":\"{screen}\",\"accessibility\":\"{accessibility}\",\"display\":\"{display}\",\"locked\":{},\"lastCaptureAt\":",
            self.version, self.locked
        );
        match self.last_capture_at {
            Some(t) => {
                let _ = write!(out, "{t}");
            }
            None => out.push_str("null"),
        }
        out.push('}');
        out
    }
}

// ---- tests ----

#[cfg(test)]
mod tests {
    use super::*;

    fn healthy() -> Status {
        Status {
            screen: Screen::Granted,
            accessibility: Accessibility::Granted,
            display: DisplayState::Ok,
            locked: false,
            last_capture_at: Some(1_760_400_000),
            version: "0.1.0",
        }
    }

    #[test]
    fn json_carries_only_enumerations_and_a_time() {
        let v: serde_json::Value = serde_json::from_str(&healthy().to_json()).unwrap();
        assert_eq!(v["screen"], "granted");
        assert_eq!(v["accessibility"], "granted");
        assert_eq!(v["display"], "ok");
        assert_eq!(v["locked"], false);
        assert_eq!(v["lastCaptureAt"], 1_760_400_000u64);
        assert_eq!(v["version"], "0.1.0");
        assert_eq!(v.as_object().unwrap().len(), 6);
        let mut s = healthy();
        s.last_capture_at = None;
        s.display = DisplayState::Asleep;
        s.screen = Screen::Suspect;
        s.locked = true;
        let v: serde_json::Value = serde_json::from_str(&s.to_json()).unwrap();
        assert_eq!(v["lastCaptureAt"], serde_json::Value::Null);
        assert_eq!(v["display"], "asleep");
        assert_eq!(v["screen"], "suspect");
        assert_eq!(v["locked"], true);
    }

    #[test]
    fn missing_permissions_refuse_sessions_with_the_permission_code() {
        let mut s = healthy();
        s.screen = Screen::Denied;
        assert_eq!(s.gate(true), Err(Gate::Permission));
        let mut s = healthy();
        s.accessibility = Accessibility::Denied;
        assert_eq!(s.gate(false), Err(Gate::Permission));
        assert_eq!(Gate::Permission.code(), "permission");
        assert_eq!(Gate::Permission.http_status(), 403);
    }

    #[test]
    fn the_screen_is_denied_when_the_system_says_so_whatever_the_capture_suspects() {
        assert_eq!(screen_of(false, false), Screen::Denied);
        assert_eq!(screen_of(false, true), Screen::Denied);
        assert_eq!(screen_of(true, true), Screen::Suspect);
        assert_eq!(screen_of(true, false), Screen::Granted);
    }

    #[test]
    fn a_suspect_screen_still_allows_a_session_so_it_can_recover() {
        let mut s = healthy();
        s.screen = Screen::Suspect;
        assert_eq!(s.gate(true), Ok(()));
    }

    #[test]
    fn p1_chose_to_unlock_through_the_agent() {
        let mut s = healthy();
        s.locked = true;
        assert!(!REFUSE_WHEN_LOCKED);
        assert_eq!(s.gate(REFUSE_WHEN_LOCKED), Ok(()));
    }

    #[test]
    fn locked_refuses_only_while_the_p1_switch_says_so() {
        let mut s = healthy();
        s.locked = true;
        assert_eq!(s.gate(true), Err(Gate::Locked));
        assert_eq!(s.gate(false), Ok(()));
        assert_eq!(Gate::Locked.code(), "locked");
        assert_eq!(Gate::Locked.http_status(), 423);
    }

    #[test]
    fn a_sleeping_or_missing_display_does_not_refuse_a_session() {
        // The session start wakes the display (spec D3); no display at all fails later, in capture.
        let mut s = healthy();
        s.display = DisplayState::Asleep;
        assert_eq!(s.gate(true), Ok(()));
        s.display = DisplayState::None;
        assert_eq!(s.gate(true), Ok(()));
    }
}
