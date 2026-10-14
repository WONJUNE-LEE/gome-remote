//! Gome Remote Mac agent. Everything outside `mac` is platform independent, so its
//! tests run with a plain `cargo test` on any host; `mac` needs the macOS frameworks.
pub mod auth;
pub mod config;
pub mod http;
pub mod log_cap;
pub mod paths;
pub mod size;
pub mod status;
pub mod tailnet;

#[cfg(target_os = "macos")]
pub mod mac;
