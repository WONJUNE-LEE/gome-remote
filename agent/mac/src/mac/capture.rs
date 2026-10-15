//! ScreenCaptureKit capture of the main display. Ported from the spike's `capture.rs`;
//! changes: the cursor is not captured (the page draws the viewer's own pointer, spec D4),
//! the stream can be reconfigured and stopped, and `start` returns a handle instead of
//! parking its thread for ever.
use super::ffi::*;
use crate::size::{capture_size, Size};
use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_core_media::{CMSampleBuffer, CMTime, CMTimeFlags};
use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol};
use objc2_screen_capture_kit::{
    SCContentFilter, SCShareableContent, SCStream, SCStreamConfiguration, SCStreamDelegate, SCStreamOutput,
    SCStreamOutputType, SCWindow,
};
use std::ffi::c_void;
use std::sync::mpsc::channel;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// `width` and `height` are the stream size; the frames delivered may be larger (the display's
/// pixels) and are scaled by the pipeline.
#[derive(Clone, Copy)]
pub struct CaptureConfig {
    pub width: usize,
    pub height: usize,
    pub fps: i32,
    pub queue_depth: isize,
}

pub type FrameFn = Arc<dyn Fn(CVPixelBufferRef, Instant) + Send + Sync>;

/// Called when the system stops the stream by itself (display sleep, permission revoked, the
/// periodic re-check, "Stop sharing"): never for a stop this code asked for.
pub type StopFn = Arc<dyn Fn() + Send + Sync>;

struct Ivars {
    on_frame: FrameFn,
    on_stop: StopFn,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "GomeRemoteStreamOutput"]
    #[ivars = Ivars]
    struct StreamOutput;

    unsafe impl NSObjectProtocol for StreamOutput {}

    unsafe impl SCStreamOutput for StreamOutput {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        unsafe fn did_output(&self, _stream: &SCStream, sample: &CMSampleBuffer, kind: SCStreamOutputType) {
            if kind != SCStreamOutputType::Screen {
                return;
            }
            let sample = sample as *const CMSampleBuffer as *const c_void;
            let image = unsafe { CMSampleBufferGetImageBuffer(sample) };
            if image.is_null() {
                return; // a status-only sample (idle, paused)
            }
            (self.ivars().on_frame)(image, Instant::now());
        }
    }

    unsafe impl SCStreamDelegate for StreamOutput {
        #[unsafe(method(stream:didStopWithError:))]
        unsafe fn did_stop(&self, _stream: &SCStream, error: &NSError) {
            println!(
                "[capture] stopped by the system: {} (domain {}, code {})",
                error.localizedDescription(),
                error.domain(),
                error.code()
            );
            (self.ivars().on_stop)();
        }
    }
);

struct SendBox<T>(T);
unsafe impl<T> Send for SendBox<T> {}

fn describe(error: *mut NSError) -> String {
    if error.is_null() {
        "unknown".into()
    } else {
        let error = unsafe { &*error };
        format!("{} (domain {}, code {})", error.localizedDescription(), error.domain(), error.code())
    }
}

/// A running capture. Dropping it without `stop` leaves the stream running.
pub struct Capture {
    stream: Retained<SCStream>,
    _output: Retained<StreamOutput>,
    _queue: dispatch2::DispatchRetained<DispatchQueue>,
    display_is_main: bool,
}
unsafe impl Send for Capture {}
unsafe impl Sync for Capture {}

fn configuration(cfg: &CaptureConfig) -> Retained<SCStreamConfiguration> {
    unsafe {
        let conf = SCStreamConfiguration::new();
        // Smaller than the display: capture its real pixels, the pipeline scales (size::capture_size).
        let stream = Size { w: cfg.width as u32, h: cfg.height as u32 };
        let captured = capture_size(stream, super::system::native_pixels());
        conf.setWidth(captured.w as usize);
        conf.setHeight(captured.h as usize);
        conf.setMinimumFrameInterval(CMTime { value: 1, timescale: cfg.fps, flags: CMTimeFlags::Valid, epoch: 0 });
        conf.setPixelFormat(0x34323076); // '420v' NV12, video range
        conf.setShowsCursor(false);
        conf.setQueueDepth(cfg.queue_depth);
        conf
    }
}

/// The configuration fields that decide what the pixels look like, read back from the object
/// ScreenCaptureKit was given (for the log).
fn describe_configuration(conf: &SCStreamConfiguration) -> String {
    unsafe {
        format!(
            "[size {}x{} resolution {} scalesToFit {} preservesAspectRatio {} pixelFormat {:#x}]",
            conf.width(),
            conf.height(),
            conf.captureResolution().0,
            conf.scalesToFit(),
            conf.preservesAspectRatio(),
            conf.pixelFormat()
        )
    }
}

/// Starts capturing the main display. Blocks until ScreenCaptureKit answers (20 s at most).
/// The error text is what ScreenCaptureKit said, for the log only.
pub fn start(cfg: CaptureConfig, on_frame: FrameFn, on_stop: StopFn) -> Result<Capture, String> {
    let (tx, rx) = channel::<Result<SendBox<Retained<SCShareableContent>>, String>>();
    let handler = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
        if content.is_null() {
            let _ = tx.send(Err(describe(error)));
        } else {
            let content = unsafe { Retained::retain(content) }.unwrap();
            let _ = tx.send(Ok(SendBox(content)));
        }
    });
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&handler) };
    let content = match rx.recv_timeout(Duration::from_secs(20)) {
        Ok(Ok(content)) => content.0,
        Ok(Err(e)) => return Err(format!("SCShareableContent: {e}")),
        Err(e) => return Err(format!("SCShareableContent: {e}")),
    };
    unsafe {
        let displays = content.displays();
        let main_id = CGMainDisplayID();
        let chosen = displays.iter().find(|d| d.displayID() == main_id);
        let display_is_main = chosen.is_some();
        let Some(display) = chosen.or_else(|| displays.firstObject()) else {
            return Err("no displays in SCShareableContent".into());
        };
        let excluded: Retained<NSArray<SCWindow>> = NSArray::new();
        let filter = SCContentFilter::initWithDisplay_excludingWindows(SCContentFilter::alloc(), &display, &excluded);
        let output = StreamOutput::alloc().set_ivars(Ivars { on_frame, on_stop });
        let output: Retained<StreamOutput> = msg_send![super(output), init];
        let conf = configuration(&cfg);
        let stream = SCStream::initWithFilter_configuration_delegate(
            SCStream::alloc(),
            &filter,
            &conf,
            Some(ProtocolObject::from_ref(&*output)),
        );
        let queue = DispatchQueue::new("net.gome.remote-agent.capture", None);
        stream
            .addStreamOutput_type_sampleHandlerQueue_error(
                ProtocolObject::from_ref(&*output),
                SCStreamOutputType::Screen,
                Some(&queue),
            )
            .map_err(|e| format!("addStreamOutput: {}", e.localizedDescription()))?;
        let (started_tx, started_rx) = channel::<Result<(), String>>();
        let started = RcBlock::new(move |error: *mut NSError| {
            let _ = started_tx.send(if error.is_null() { Ok(()) } else { Err(describe(error)) });
        });
        stream.startCaptureWithCompletionHandler(Some(&started));
        let capture = Capture { stream, _output: output, _queue: queue, display_is_main };
        match started_rx.recv_timeout(Duration::from_secs(20)) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                capture.stop();
                return Err(format!("startCapture: {e}"));
            }
            Err(e) => {
                // It may still start after the timeout: make sure it ends.
                capture.stop();
                return Err(format!("startCapture: {e}"));
            }
        }
        println!("[capture] started {}x{}@{} {}", cfg.width, cfg.height, cfg.fps, describe_configuration(&conf));
        Ok(capture)
    }
}

impl Capture {
    /// Changes the size and rate of the running stream.
    pub fn update(&self, cfg: &CaptureConfig) -> Result<(), String> {
        let (tx, rx) = channel::<Result<(), String>>();
        let done = RcBlock::new(move |error: *mut NSError| {
            let _ = tx.send(if error.is_null() { Ok(()) } else { Err(describe(error)) });
        });
        unsafe { self.stream.updateConfiguration_completionHandler(&configuration(cfg), Some(&done)) };
        rx.recv_timeout(Duration::from_secs(5)).map_err(|e| format!("updateConfiguration: {e}"))?
    }

    pub fn stop(self) {
        let (tx, rx) = channel::<()>();
        let done = RcBlock::new(move |_error: *mut NSError| {
            let _ = tx.send(());
        });
        unsafe { self.stream.stopCaptureWithCompletionHandler(Some(&done)) };
        let _ = rx.recv_timeout(Duration::from_secs(5));
        println!("[capture] stopped (main display: {})", self.display_is_main);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::sel;
    use std::sync::atomic::{AtomicBool, Ordering::SeqCst};

    /// The class registers as both a stream output and a stream delegate, and answers the
    /// delegate's stop selector (the stop path itself needs a live stream and a grant).
    #[test]
    fn the_stream_object_is_registered_as_output_and_delegate() {
        let stopped = Arc::new(AtomicBool::new(false));
        let flag = stopped.clone();
        let ivars = Ivars { on_frame: Arc::new(|_, _| {}), on_stop: Arc::new(move || flag.store(true, SeqCst)) };
        let output: Retained<StreamOutput> = unsafe { msg_send![super(StreamOutput::alloc().set_ivars(ivars)), init] };
        let _delegate: &ProtocolObject<dyn SCStreamDelegate> = ProtocolObject::from_ref(&*output);
        let _out: &ProtocolObject<dyn SCStreamOutput> = ProtocolObject::from_ref(&*output);
        let responds: bool = unsafe { msg_send![&*output, respondsToSelector: sel!(stream:didStopWithError:)] };
        assert!(responds);
        (output.ivars().on_stop)();
        assert!(stopped.load(SeqCst));
    }
}
