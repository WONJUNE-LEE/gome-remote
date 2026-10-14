//! Capture -> encoder -> peer, running only while a session exists. Ported from the
//! spike's `main.rs` (frame callback, keepalive thread); new: it can be started, resized,
//! re-targeted at another peer and stopped, the encoder follows the size of the frames it
//! receives, and it tracks black frames for the status.
use super::capture::{self, Capture, CaptureConfig};
use super::encoder::{Config as EncoderConfig, Encoder, FrameSink};
use super::ffi::*;
use super::system;
use crate::black::{luma_is_black, BlackWatch};
use crate::frame::FrameTarget;
use crate::keepalive::{should_resubmit, Ages};
use crate::retry::RetryGate;
use crate::size::{fps_for, Size};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const QUEUE_DEPTH: isize = 3;
const KEY_INTERVAL: Duration = Duration::from_secs(3);

#[derive(Clone, Copy)]
struct Plan {
    size: Size,
    fps: u32,
    bitrate: u32,
}

struct Inner {
    encoder: Mutex<Option<Encoder>>,
    /// Paces attempts to create an encoder session after one failed.
    encoder_gate: Mutex<RetryGate>,
    last_frame: Mutex<Option<(PixBuf, Instant)>>,
    last_submit: Mutex<Instant>,
    sink: Arc<Mutex<Option<Arc<dyn FrameTarget>>>>,
    capture: Mutex<Option<Capture>>,
    running: AtomicBool,
    plan: Mutex<Plan>,
    black: Mutex<BlackWatch>,
    /// Bumped by every start, so a keepalive thread of an earlier run ends even when the
    /// pipeline is running again by the time it looks.
    epoch: AtomicU64,
    last_content_secs: AtomicU64,
    sent_frames: AtomicU64,
    sent_bytes: AtomicU64,
}

#[derive(Clone)]
pub struct Pipeline {
    inner: Arc<Inner>,
}

impl Default for Pipeline {
    fn default() -> Self {
        let now = Instant::now();
        Pipeline {
            inner: Arc::new(Inner {
                encoder: Mutex::new(None),
                encoder_gate: Mutex::new(RetryGate::default()),
                last_frame: Mutex::new(None),
                last_submit: Mutex::new(now),
                sink: Arc::new(Mutex::new(None)),
                capture: Mutex::new(None),
                running: AtomicBool::new(false),
                plan: Mutex::new(Plan { size: Size { w: 1920, h: 1080 }, fps: 60, bitrate: 6_000_000 }),
                black: Mutex::new(BlackWatch::default()),
                epoch: AtomicU64::new(0),
                last_content_secs: AtomicU64::new(0),
                sent_frames: AtomicU64::new(0),
                sent_bytes: AtomicU64::new(0),
            }),
        }
    }
}

impl Pipeline {
    /// Starts capturing at `size`, or re-targets a running capture at `target` and the new size.
    pub fn start(&self, size: Size, bitrate: u32, target: Arc<dyn FrameTarget>) -> Result<(), String> {
        let inner = &self.inner;
        *inner.plan.lock().unwrap() = Plan { size, fps: fps_for(size), bitrate };
        *inner.sink.lock().unwrap() = Some(target);
        if inner.running.load(Relaxed) {
            self.apply_plan()?;
            self.set_bitrate(bitrate);
            self.request_keyframe();
            return Ok(());
        }
        inner.black.lock().unwrap().begin();
        // Bumped first, so a keepalive thread of an earlier run stops submitting at once.
        let epoch = inner.epoch.fetch_add(1, Relaxed) + 1;
        // Nothing of an earlier session may be repeated into this one.
        *inner.last_frame.lock().unwrap() = None;
        inner.encoder_gate.lock().unwrap().reset();
        let config = Self::capture_config(&inner.plan.lock().unwrap());
        // A stream the system stopped is still held here (its session ended with it): let it go.
        let stale = inner.capture.lock().unwrap().take();
        if let Some(stale) = stale {
            stale.stop();
        }
        let me = self.clone();
        let on_frame: capture::FrameFn = Arc::new(move |pixel_buffer, at| me.on_frame(pixel_buffer, at));
        let me = self.clone();
        let on_stop: capture::StopFn = Arc::new(move || me.on_stream_stopped(epoch));
        inner.running.store(true, Relaxed);
        let capture = match capture::start(config, on_frame, on_stop) {
            Ok(capture) => capture,
            Err(e) => {
                inner.running.store(false, Relaxed);
                self.end_black_watch();
                *inner.sink.lock().unwrap() = None;
                return Err(e);
            }
        };
        *inner.capture.lock().unwrap() = Some(capture);
        let me = self.clone();
        std::thread::spawn(move || me.keepalive_loop(epoch));
        Ok(())
    }

    /// A new stream size (the page's `size` message).
    pub fn resize(&self, size: Size, bitrate_cap: u32) -> Result<(), String> {
        {
            let mut plan = self.inner.plan.lock().unwrap();
            plan.size = size;
            plan.fps = fps_for(size);
            plan.bitrate = plan.bitrate.min(bitrate_cap);
        }
        self.apply_plan()
    }

    fn apply_plan(&self) -> Result<(), String> {
        let config = Self::capture_config(&self.inner.plan.lock().unwrap());
        match self.inner.capture.lock().unwrap().as_ref() {
            Some(capture) => capture.update(&config),
            None => Ok(()),
        }
    }

    fn capture_config(plan: &Plan) -> CaptureConfig {
        CaptureConfig {
            width: plan.size.w as usize,
            height: plan.size.h as usize,
            fps: plan.fps as i32,
            queue_depth: QUEUE_DEPTH,
        }
    }

    pub fn stop(&self) {
        let inner = &self.inner;
        inner.running.store(false, Relaxed);
        *inner.sink.lock().unwrap() = None;
        let capture = inner.capture.lock().unwrap().take();
        if let Some(capture) = capture {
            capture.stop(); // consumes the stream, which releases the frame callback
        }
        // After the stream is gone, so no frame of this session can add evidence to the next.
        self.end_black_watch();
        *inner.encoder.lock().unwrap() = None;
        *inner.last_frame.lock().unwrap() = None;
    }

    /// Ends the evidence of this run; a suspect verdict is kept unless the screen is locked now.
    fn end_black_watch(&self) {
        self.inner.black.lock().unwrap().end(Instant::now(), system::screen_locked());
    }

    /// The system stopped the stream of run `epoch` by itself (not through `stop`): the picture
    /// would freeze while the keepalive repeated the last frame, so the pipeline fails, the
    /// session's peer is closed (the page shows its ended card) and the status learns of it.
    fn on_stream_stopped(&self, epoch: u64) {
        let inner = &self.inner;
        if inner.epoch.load(Relaxed) != epoch || !inner.running.swap(false, Relaxed) {
            return; // a stop we asked for, or an earlier run's
        }
        let screen = inner.black.lock().unwrap().stream_stopped(system::screen_recording_granted());
        eprintln!("[pipeline] the system stopped the capture stream; the screen now reads {screen:?}");
        let target = inner.sink.lock().unwrap().clone();
        if let Some(target) = target {
            target.stream_stopped();
        }
    }

    pub fn request_keyframe(&self) {
        if let Some(encoder) = self.inner.encoder.lock().unwrap().as_ref() {
            encoder.request_keyframe();
        }
    }

    pub fn set_bitrate(&self, bps: u32) {
        self.inner.plan.lock().unwrap().bitrate = bps;
        if let Some(encoder) = self.inner.encoder.lock().unwrap().as_mut() {
            encoder.set_bitrate(bps as i32);
        }
    }

    /// Only content-free frames for a while (the status' "suspect").
    pub fn suspect(&self) -> bool {
        self.inner.black.lock().unwrap().suspect(Instant::now())
    }

    /// Seconds since the epoch of the last captured frame that had content.
    pub fn last_capture_at(&self) -> Option<u64> {
        match self.inner.last_content_secs.load(Relaxed) {
            0 => None,
            secs => Some(secs),
        }
    }

    fn frame_sink(&self) -> FrameSink {
        let inner = self.inner.clone();
        Arc::new(move |frame| {
            let bytes = frame.data.len() as u64;
            if let Some(peer) = inner.sink.lock().unwrap().as_ref() {
                if peer.send_frame(frame) {
                    inner.sent_frames.fetch_add(1, Relaxed);
                    inner.sent_bytes.fetch_add(bytes, Relaxed);
                }
            }
        })
    }

    /// Runs on ScreenCaptureKit's queue for every delivered frame.
    fn on_frame(&self, pixel_buffer: CVPixelBufferRef, at: Instant) {
        let inner = &self.inner;
        if !inner.running.load(Relaxed) {
            return; // a late frame of a stream that is being stopped
        }
        // 1. Black-frame detection, before the buffer goes to the encoder (locking it after
        //    the submit waits for the encoder to let go of it).
        if inner.black.lock().unwrap().frame(at, || Self::is_black(pixel_buffer)) == Some(false) {
            let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            inner.last_content_secs.store(now, Relaxed);
        }
        // 2. Keep the frame for the keepalive thread, then encode it.
        *inner.last_frame.lock().unwrap() = Some((PixBuf::retain(pixel_buffer), at));
        self.submit(pixel_buffer, None);
    }

    fn is_black(pixel_buffer: CVPixelBufferRef) -> bool {
        unsafe {
            if CVPixelBufferLockBaseAddress(pixel_buffer, 1) != 0 {
                return false; // cannot tell: not suspicious
            }
            let base = CVPixelBufferGetBaseAddressOfPlane(pixel_buffer, 0);
            let (w, h) = (CVPixelBufferGetWidth(pixel_buffer), CVPixelBufferGetHeight(pixel_buffer));
            let stride = CVPixelBufferGetBytesPerRowOfPlane(pixel_buffer, 0);
            let black = if base.is_null() {
                false
            } else {
                luma_is_black(std::slice::from_raw_parts(base, stride * h), w, h, stride)
            };
            CVPixelBufferUnlockBaseAddress(pixel_buffer, 1);
            black
        }
    }

    /// Encodes `pixel_buffer`, first making sure the encoder has the buffer's size. A
    /// keepalive thread passes its epoch, so one of an earlier run cannot submit after a restart.
    fn submit(&self, pixel_buffer: CVPixelBufferRef, epoch: Option<u64>) {
        let inner = &self.inner;
        let (w, h) =
            unsafe { (CVPixelBufferGetWidth(pixel_buffer) as i32, CVPixelBufferGetHeight(pixel_buffer) as i32) };
        let mut encoder = inner.encoder.lock().unwrap();
        if !inner.running.load(Relaxed) || epoch.is_some_and(|e| e != inner.epoch.load(Relaxed)) {
            return; // stopped or restarted meanwhile; `stop` clears the encoder under this lock
        }
        if encoder.as_ref().map(|e| (e.width(), e.height())) != Some((w, h)) {
            // After a failure nothing is retried for a while, so a broken encoder costs one log
            // line per window and not one per captured frame.
            if !inner.encoder_gate.lock().unwrap().ready(Instant::now()) {
                return;
            }
            let plan = *inner.plan.lock().unwrap();
            let config = EncoderConfig {
                width: w,
                height: h,
                fps: plan.fps as i32,
                bitrate_bps: plan.bitrate as i32,
                key_interval: KEY_INTERVAL,
            };
            match Encoder::new(config, self.frame_sink()) {
                Ok(new) => {
                    inner.encoder_gate.lock().unwrap().succeeded();
                    *encoder = Some(new); // starts with a keyframe request
                }
                Err(e) => {
                    inner.encoder_gate.lock().unwrap().failed(Instant::now());
                    eprintln!("[pipeline] encoder: {e}");
                    return;
                }
            }
        }
        if let Some(encoder) = encoder.as_mut() {
            encoder.encode(pixel_buffer);
        }
        *inner.last_submit.lock().unwrap() = Instant::now();
    }

    /// ScreenCaptureKit only delivers a frame when the screen changes: repeat the last one
    /// when a keyframe is pending and as a low-rate keepalive on a still screen.
    fn keepalive_loop(&self, epoch: u64) {
        let inner = &self.inner;
        let mut report = (Instant::now(), 0u64, 0u64);
        while inner.running.load(Relaxed) && inner.epoch.load(Relaxed) == epoch {
            std::thread::sleep(Duration::from_millis(2));
            let snapshot = inner.last_frame.lock().unwrap().as_ref().map(|(pb, at)| (PixBuf::retain(pb.0), *at));
            let Some((pixel_buffer, captured)) = snapshot else { continue };
            let pending = inner.encoder.lock().unwrap().as_ref().map(|e| e.keyframe_pending()).unwrap_or(false);
            let ages = Ages {
                since_capture: captured.elapsed(),
                since_submit: inner.last_submit.lock().unwrap().elapsed(),
                keyframe_pending: pending,
            };
            if should_resubmit(&ages) {
                self.submit(pixel_buffer.0, Some(epoch));
            }
            // One line every ten seconds while someone watches, never per frame.
            if report.0.elapsed() >= Duration::from_secs(10) {
                let (frames, bytes) = (inner.sent_frames.load(Relaxed), inner.sent_bytes.load(Relaxed));
                let secs = report.0.elapsed().as_secs_f64();
                println!(
                    "[stats] sent_fps={:.1} kbps={:.0}",
                    (frames - report.1) as f64 / secs,
                    (bytes - report.2) as f64 * 8.0 / 1000.0 / secs
                );
                report = (Instant::now(), frames, bytes);
            }
        }
    }
}
