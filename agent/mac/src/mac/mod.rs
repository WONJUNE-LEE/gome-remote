//! macOS side: framework bindings and the process entry point.
pub mod ffi;
pub mod system;

use crate::auth::Guard;
use crate::config::{self, AgentConfig, FileMeta, Kind};
use crate::http::{self, Backend, Router, SessionFailure, SessionRequest};
use crate::paths::{self, ConfigOwner, Paths};
use crate::status::{Accessibility, Screen, Status};
use std::net::SocketAddr;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::Arc;

fn kind_of(meta: &std::fs::Metadata) -> Kind {
    let kind = meta.file_type();
    if kind.is_file() {
        Kind::File
    } else if kind.is_dir() {
        Kind::Dir
    } else {
        Kind::Other
    }
}

fn meta_of(path: &Path) -> Result<FileMeta, String> {
    // symlink_metadata: a symbolic link is never followed, so it is not a regular file.
    let meta = std::fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(FileMeta { mode: meta.mode() & 0o7777, uid: meta.uid(), kind: kind_of(&meta) })
}

fn load_config(paths: &Paths, user_uid: u32) -> Result<AgentConfig, String> {
    let owner = match paths.config_owner {
        ConfigOwner::Root => 0,
        ConfigOwner::CurrentUser => user_uid,
    };
    let file = meta_of(&paths.config)?;
    config::check_config_file(&file, owner, user_uid).map_err(|e| e.to_string())?;
    let dir = paths.config.parent().ok_or("the settings file has no directory")?;
    config::check_config_dir(&meta_of(dir)?, owner).map_err(|e| e.to_string())?;
    let text = std::fs::read_to_string(&paths.config).map_err(|e| format!("{}: {e}", paths.config.display()))?;
    config::parse_config(&text).map_err(|e| e.to_string())
}

fn load_token(paths: &Paths, user_uid: u32) -> Result<String, String> {
    config::check_token_file(&meta_of(&paths.token)?, user_uid).map_err(|e| e.to_string())?;
    let text = std::fs::read_to_string(&paths.token).map_err(|e| format!("{}: {e}", paths.token.display()))?;
    config::parse_token(&text).map_err(|e| e.to_string())
}

/// The agent as of this task: it answers `/v1/status` truthfully and refuses to start
/// sessions (capture, WebRTC and input arrive in the next tasks).
struct StatusOnly;

impl Backend for StatusOnly {
    fn status(&self) -> Status {
        Status {
            screen: if system::screen_recording_granted() { Screen::Granted } else { Screen::Denied },
            accessibility: if system::accessibility_granted() { Accessibility::Granted } else { Accessibility::Denied },
            display: system::display_state(),
            locked: system::screen_locked(),
            last_capture_at: None,
            version: env!("CARGO_PKG_VERSION"),
        }
    }

    fn start_session(&self, _request: SessionRequest) -> Result<String, SessionFailure> {
        Err(SessionFailure::Internal("this build cannot start sessions yet".into()))
    }
}

pub fn run() {
    let refuse = |message: String| -> ! {
        eprintln!("gome-remote-agent refused to start: {message}");
        std::process::exit(2)
    };
    let home = paths::home_dir().unwrap_or_else(|| refuse("no home directory".into()));
    let paths = paths::locate(&home);
    let user_uid = unsafe { libc::getuid() };
    let config = load_config(&paths, user_uid).unwrap_or_else(|e| refuse(e));
    let token = load_token(&paths, user_uid).unwrap_or_else(|e| refuse(e));

    println!("[perm] screen={} accessibility={}", system::screen_recording_granted(), system::accessibility_granted());
    if !system::screen_recording_granted() || !system::accessibility_granted() {
        // Registers the binary in System Settings; the status keeps saying "permission" until allowed.
        system::prompt_for_permissions();
    }

    // launchd cannot cap the log it writes for us; the agent empties it when it grows too big.
    std::thread::spawn(|| loop {
        crate::log_cap::truncate_if_large(1);
        std::thread::sleep(std::time::Duration::from_secs(60));
    });

    let address = SocketAddr::new(config.bind, config.port);
    let router = Arc::new(Router::new(Guard::new(address, config.gateway, token), Arc::new(StatusOnly)));
    std::thread::spawn(move || {
        if let Err(e) = http::serve(address, router) {
            eprintln!("gome-remote-agent: {e:#}");
            std::process::exit(4);
        }
    });
    // ScreenCaptureKit and the event posting want a live main run loop.
    unsafe { ffi::CFRunLoopRun() };
}
