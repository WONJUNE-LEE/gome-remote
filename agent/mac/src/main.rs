#[cfg(target_os = "macos")]
fn main() {
    gome_agent::mac::run();
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("gome-remote-agent runs on macOS only");
    std::process::exit(1);
}
