//! VideoToolbox H.264 hardware encoder: real-time, constrained baseline, no B-frames,
//! low-latency rate control when the system offers it. Ported from the spike's
//! `encoder.rs`; the click trace, the SPS patch and the global statistics are gone, and
//! these are new: a per-encoder frame sink, a settable bitrate, and a keyframe flag.
use super::ffi::*;
use crate::frame::EncodedFrame;
use std::ffi::c_void;
use crate::http::LogLimiter;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

pub type FrameSink = Arc<dyn Fn(EncodedFrame) + Send + Sync>;

pub struct Config {
    pub width: i32,
    pub height: i32,
    pub fps: i32,
    pub bitrate_bps: i32,
    pub key_interval: Duration,
}

pub struct Encoder {
    session: VTSession,
    cfg: Config,
    start: Instant,
    last_key: Instant,
    refcon: *mut FrameSink,
    force_key: AtomicBool,
}
// The session is only used from the capture callback thread and the keepalive thread, which
// the pipeline serialises behind one mutex.
unsafe impl Send for Encoder {}

struct Submitted {
    at: Instant,
}

const FOURCC_AVC1: u32 = 0x61766331;
/// `VTEncodeInfoFlags::kVTEncodeInfo_FrameDropped`: the real-time encoder skipped the frame.
const ENCODE_INFO_FRAME_DROPPED: u32 = 1 << 1;

static ERROR_LOG: LazyLock<Mutex<LogLimiter>> = LazyLock::new(|| Mutex::new(LogLimiter::default()));

/// Error lines from the per-frame paths: at most one a second, counting what was held back.
fn log_error(text: &str) {
    let note = ERROR_LOG.lock().map(|mut limiter| limiter.note(Instant::now())).unwrap_or(None);
    match note {
        Some(0) => eprintln!("{text}"),
        Some(held) => eprintln!("{text} (and {held} more since the last line)"),
        None => {}
    }
}

extern "C" fn output_cb(
    refcon: *mut c_void,
    frame_refcon: *mut c_void,
    status: OSStatus,
    flags: u32,
    sb: CMSampleBufferRef,
) {
    let submitted: Box<Submitted> = unsafe { Box::from_raw(frame_refcon as *mut Submitted) };
    if status == 0 && (flags & ENCODE_INFO_FRAME_DROPPED != 0 || sb.is_null()) {
        return; // a frame the real-time encoder dropped under load: normal, and silent
    }
    if status != 0 || sb.is_null() {
        log_error(&format!("[enc] callback status {status}"));
        return;
    }
    let sink: &FrameSink = unsafe { &*(refcon as *const FrameSink) };
    unsafe {
        // A keyframe has no NotSync attachment, or it is false.
        let mut key = true;
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, 0);
        if !attachments.is_null() && CFArrayGetCount(attachments) > 0 {
            let dict = CFArrayGetValueAtIndex(attachments, 0);
            let not_sync = CFDictionaryGetValue(dict, kCMSampleAttachmentKey_NotSync);
            if !not_sync.is_null() && not_sync == kCFBooleanTrue {
                key = false;
            }
        }
        let block = CMSampleBufferGetDataBuffer(sb);
        if block.is_null() {
            return;
        }
        let len = CMBlockBufferGetDataLength(block);
        let mut raw = vec![0u8; len];
        if CMBlockBufferCopyDataBytes(block, 0, len, raw.as_mut_ptr()) != 0 {
            return;
        }
        // VideoToolbox gives length-prefixed NAL units; WebRTC wants Annex B.
        let mut out = Vec::with_capacity(len + 128);
        let mut nal_len_size = 4usize;
        if key {
            let fd = CMSampleBufferGetFormatDescription(sb);
            let (mut count, mut header_len) = (0usize, 0i32);
            let (mut ptr, mut size): (*const u8, usize) = (std::ptr::null(), 0);
            if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                fd,
                0,
                &mut ptr,
                &mut size,
                &mut count,
                &mut header_len,
            ) == 0
            {
                nal_len_size = header_len as usize;
                let sets = count;
                for index in 0..sets {
                    let (mut ignored_count, mut ignored_header) = (0usize, 0i32);
                    if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                        fd,
                        index,
                        &mut ptr,
                        &mut size,
                        &mut ignored_count,
                        &mut ignored_header,
                    ) == 0
                    {
                        out.extend_from_slice(&[0, 0, 0, 1]);
                        out.extend_from_slice(std::slice::from_raw_parts(ptr, size));
                    }
                }
            }
        }
        let mut at = 0usize;
        while at + nal_len_size <= raw.len() {
            let mut n = 0usize;
            for b in &raw[at..at + nal_len_size] {
                n = (n << 8) | *b as usize;
            }
            at += nal_len_size;
            if at + n > raw.len() {
                break;
            }
            out.extend_from_slice(&[0, 0, 0, 1]);
            out.extend_from_slice(&raw[at..at + n]);
            at += n;
        }
        sink(EncodedFrame { data: out, key, submitted: submitted.at });
    }
}

fn bool_cf(b: bool) -> CFTypeRef {
    unsafe {
        if b {
            kCFBooleanTrue
        } else {
            kCFBooleanFalse
        }
    }
}

impl Encoder {
    pub fn new(cfg: Config, sink: FrameSink) -> anyhow::Result<Encoder> {
        // Low-latency rate control first; fall back without it if the session cannot be made.
        let refcon = Box::into_raw(Box::new(sink));
        match Self::create(&cfg, refcon, true).or_else(|e| {
            eprintln!("[enc] {e}; retrying without low-latency rate control");
            Self::create(&cfg, refcon, false)
        }) {
            Ok((session, low_latency)) => {
                let mut hardware: CFTypeRef = std::ptr::null();
                let status = unsafe {
                    VTSessionCopyProperty(
                        session,
                        kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,
                        std::ptr::null(),
                        &mut hardware,
                    )
                };
                println!(
                    "[enc] session {}x{} fps={} bitrate={}Mbps low_latency={low_latency} hardware={}",
                    cfg.width,
                    cfg.height,
                    cfg.fps,
                    cfg.bitrate_bps as f64 / 1e6,
                    if status == 0 {
                        (hardware == unsafe { kCFBooleanTrue }).to_string()
                    } else {
                        format!("unreported(status {status}, the low-latency rate control does not report it)")
                    }
                );
                if !hardware.is_null() {
                    unsafe { CFRelease(hardware) };
                }
                Ok(Encoder {
                    session,
                    cfg,
                    start: Instant::now(),
                    last_key: Instant::now() - Duration::from_secs(3600),
                    refcon,
                    force_key: AtomicBool::new(true),
                })
            }
            Err(e) => {
                drop(unsafe { Box::from_raw(refcon) });
                Err(e)
            }
        }
    }

    fn create(cfg: &Config, refcon: *mut FrameSink, low_latency: bool) -> anyhow::Result<(VTSession, bool)> {
        let mut spec_pairs: Vec<(CFTypeRef, CFTypeRef)> =
            unsafe { vec![(kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder, kCFBooleanTrue)] };
        if low_latency {
            spec_pairs.push((unsafe { kVTVideoEncoderSpecification_EnableLowLatencyRateControl }, bool_cf(true)));
        }
        let spec = cf_dict(&spec_pairs);
        let mut session: VTSession = std::ptr::null_mut();
        let status = unsafe {
            VTCompressionSessionCreate(
                std::ptr::null(),
                cfg.width,
                cfg.height,
                FOURCC_AVC1,
                spec.0,
                std::ptr::null(),
                std::ptr::null(),
                output_cb,
                refcon as *mut c_void,
                &mut session,
            )
        };
        if status != 0 || session.is_null() {
            anyhow::bail!("VTCompressionSessionCreate failed: OSStatus {status} (low_latency={low_latency})");
        }
        let set = |key: CFTypeRef, value: CFTypeRef, name: &str| unsafe {
            let status = VTSessionSetProperty(session, key, value);
            if status != 0 {
                eprintln!("[enc] set {name} failed: OSStatus {status}");
            }
        };
        unsafe {
            set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue, "RealTime");
            set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse, "AllowFrameReordering");
            set(
                kVTCompressionPropertyKey_ProfileLevel,
                kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel,
                "ProfileLevel",
            );
            set(kVTCompressionPropertyKey_AverageBitRate, cf_i32(cfg.bitrate_bps).0, "AverageBitRate");
            set(kVTCompressionPropertyKey_ExpectedFrameRate, cf_i32(cfg.fps).0, "ExpectedFrameRate");
            set(
                kVTCompressionPropertyKey_MaxKeyFrameInterval,
                cf_i32(cfg.fps * cfg.key_interval.as_secs() as i32).0,
                "MaxKeyFrameInterval",
            );
            if !low_latency {
                // Both return -12900 under low-latency rate control, so only the classic path sets them.
                set(kVTCompressionPropertyKey_MaxFrameDelayCount, cf_i32(0).0, "MaxFrameDelayCount");
                set(
                    kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality,
                    kCFBooleanTrue,
                    "PrioritizeEncodingSpeedOverQuality",
                );
            }
            let status = VTCompressionSessionPrepareToEncodeFrames(session);
            if status != 0 {
                eprintln!("[enc] PrepareToEncodeFrames: OSStatus {status}");
            }
        }
        Ok((session, low_latency))
    }

    pub fn width(&self) -> i32 {
        self.cfg.width
    }
    pub fn height(&self) -> i32 {
        self.cfg.height
    }

    /// The next frame submitted is a keyframe (new viewer, PLI/FIR).
    pub fn request_keyframe(&self) {
        self.force_key.store(true, Relaxed);
    }
    pub fn keyframe_pending(&self) -> bool {
        self.force_key.load(Relaxed)
    }

    /// Applies a new average bitrate (the congestion controller's decision).
    pub fn set_bitrate(&mut self, bps: i32) {
        self.cfg.bitrate_bps = bps;
        let status =
            unsafe { VTSessionSetProperty(self.session, kVTCompressionPropertyKey_AverageBitRate, cf_i32(bps).0) };
        if status != 0 {
            eprintln!("[enc] set AverageBitRate failed: OSStatus {status}");
        }
    }

    /// Submits the frame immediately. VideoToolbox may deliver the output callback before
    /// this returns, so the sink must not call back into the encoder.
    #[allow(clippy::not_unsafe_ptr_arg_deref)] // the caller holds a live buffer from the framework
    pub fn encode(&mut self, pixel_buffer: CVPixelBufferRef) {
        let now = Instant::now();
        let (was_requested, previous_key) = (self.force_key.swap(false, Relaxed), self.last_key);
        let force = was_requested || now.duration_since(self.last_key) >= self.cfg.key_interval;
        let props = if force {
            self.last_key = now;
            Some(cf_dict(&[(unsafe { kVTEncodeFrameOptionKey_ForceKeyFrame }, bool_cf(true))]))
        } else {
            None
        };
        let pts = CMTime::make(now.duration_since(self.start).as_micros() as i64, 1_000_000);
        let refcon = Box::into_raw(Box::new(Submitted { at: now })) as *mut c_void;
        let mut flags = 0u32;
        let status = unsafe {
            VTCompressionSessionEncodeFrame(
                self.session,
                pixel_buffer,
                pts,
                CMTime::invalid(),
                props.as_ref().map(|p| p.0).unwrap_or(std::ptr::null()),
                refcon,
                &mut flags,
            )
        };
        if status != 0 {
            log_error(&format!("[enc] EncodeFrame failed: OSStatus {status}"));
            drop(unsafe { Box::from_raw(refcon as *mut Submitted) });
            // The keyframe never went out: ask for it again.
            if force {
                self.last_key = previous_key;
                self.force_key.store(true, Relaxed);
            }
        }
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe {
            VTCompressionSessionCompleteFrames(self.session, CMTime::invalid());
            VTCompressionSessionInvalidate(self.session);
            drop(Box::from_raw(self.refcon));
        }
    }
}
