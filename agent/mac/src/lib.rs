//! Gome Remote Mac agent. Everything outside `mac` is platform independent, so its
//! tests run with a plain `cargo test` on any host; `mac` needs the macOS frameworks.
pub mod auth;
pub mod bitrate;
pub mod black;
pub mod config;
pub mod frame;
pub mod http;
pub mod keepalive;
pub mod keymap;
pub mod log_cap;
pub mod paths;
pub mod peer;
pub mod pressed;
pub mod protocol;
pub mod retry;
pub mod size;
pub mod status;
pub mod tailnet;
pub mod typing;

#[cfg(target_os = "macos")]
pub mod mac;
