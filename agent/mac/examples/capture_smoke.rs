//! Device check for the capture and encode pipeline, without WebRTC: captures the main
//! display for a few seconds through the real `Pipeline`, changes its size once, and prints
//! how many frames and keyframes came out. Run it from Terminal on the Mac (Terminal needs
//! the Screen Recording permission for this; remove it again afterwards if you like):
//!
//!   cargo run --release --example capture_smoke
//!
//! Healthy output on an M-series Mac: `[enc] ... hardware=true`, 100+ frames in the first
//! phase (a moving screen), at least one keyframe, and different frame sizes per phase.
#[cfg(target_os = "macos")]
fn main() {
    use gome_agent::frame::{EncodedFrame, FrameTarget};
    use gome_agent::mac::{ffi, pipeline::Pipeline};
    use gome_agent::size::Size;
    use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
    use std::sync::Arc;
    use std::time::Duration;

    struct Count {
        frames: AtomicU64,
        keys: AtomicU64,
        bytes: AtomicU64,
    }
    impl FrameTarget for Count {
        fn send_frame(&self, frame: EncodedFrame) -> bool {
            self.frames.fetch_add(1, Relaxed);
            self.bytes.fetch_add(frame.data.len() as u64, Relaxed);
            if frame.key {
                self.keys.fetch_add(1, Relaxed);
            }
            true
        }
    }

    // Asking whether access is granted never shows a dialog; starting a capture without it might.
    if !unsafe { ffi::CGPreflightScreenCaptureAccess() } {
        eprintln!(
            "Screen Recording is not allowed for this program (or the app that started it); nothing was captured."
        );
        std::process::exit(3);
    }
    std::thread::spawn(|| {
        let count = Arc::new(Count { frames: AtomicU64::new(0), keys: AtomicU64::new(0), bytes: AtomicU64::new(0) });
        let pipeline = Pipeline::default();
        let phases = [(Size { w: 2560, h: 1440 }, 12_000_000u32), (Size { w: 1280, h: 720 }, 6_000_000)];
        for (index, (size, bitrate)) in phases.into_iter().enumerate() {
            let (f0, k0, b0) = (count.frames.load(Relaxed), count.keys.load(Relaxed), count.bytes.load(Relaxed));
            if index == 0 {
                pipeline.start(size, bitrate, count.clone()).expect("capture started (Screen Recording allowed?)");
            } else {
                pipeline.resize(size, bitrate).expect("stream reconfigured");
            }
            std::thread::sleep(Duration::from_secs(5));
            println!(
                "phase {index}: {}x{} -> {} frames, {} keyframes, {:.2} Mbps",
                size.w,
                size.h,
                count.frames.load(Relaxed) - f0,
                count.keys.load(Relaxed) - k0,
                (count.bytes.load(Relaxed) - b0) as f64 * 8.0 / 5.0 / 1e6
            );
        }
        println!("last content at: {:?}, suspect: {}", pipeline.last_capture_at(), pipeline.suspect());
        pipeline.stop();
        std::process::exit(0);
    });
    unsafe { ffi::CFRunLoopRun() };
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("capture_smoke runs on macOS only");
}
