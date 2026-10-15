//! The VideoToolbox encoder on synthetic NV12 frames (needs no Screen Recording permission,
//! only a Mac): Annex B output, SPS and PPS in front of every keyframe, keyframes on request
//! and on the interval, bitrate changes accepted.
#![cfg(target_os = "macos")]

use gome_agent::frame::EncodedFrame;
use gome_agent::mac::encoder::{Config, Encoder, FrameSink};
use gome_agent::mac::ffi::*;
use std::sync::mpsc::{channel, Receiver};
use std::sync::Arc;
use std::time::Duration;

const NV12: u32 = 0x34323076; // '420v'

fn nv12_buffer(w: usize, h: usize, shift: usize) -> PixBuf {
    let attrs = cf_dict(&[(unsafe { kCVPixelBufferIOSurfacePropertiesKey }, cf_dict(&[]).0)]);
    let mut pb: CVPixelBufferRef = std::ptr::null();
    let status = unsafe { CVPixelBufferCreate(std::ptr::null(), w, h, NV12, attrs.0, &mut pb) };
    assert_eq!(status, 0, "CVPixelBufferCreate");
    let buffer = PixBuf(pb);
    unsafe {
        assert_eq!(CVPixelBufferLockBaseAddress(pb, 0), 0);
        let (luma, luma_stride) =
            (CVPixelBufferGetBaseAddressOfPlane(pb, 0), CVPixelBufferGetBytesPerRowOfPlane(pb, 0));
        for y in 0..h {
            for x in 0..w {
                *luma.add(y * luma_stride + x) = (((x + shift) / 4 + y / 4) % 200) as u8 + 30;
            }
        }
        let (chroma, chroma_stride) =
            (CVPixelBufferGetBaseAddressOfPlane(pb, 1), CVPixelBufferGetBytesPerRowOfPlane(pb, 1));
        for y in 0..h / 2 {
            for x in 0..w {
                *chroma.add(y * chroma_stride + x) = 128;
            }
        }
        CVPixelBufferUnlockBaseAddress(pb, 0);
    }
    buffer
}

fn encoder(w: i32, h: i32, key_interval: Duration) -> (Encoder, Receiver<EncodedFrame>) {
    let (tx, rx) = channel();
    let tx = std::sync::Mutex::new(tx);
    let sink: FrameSink = Arc::new(move |frame| {
        let _ = tx.lock().unwrap().send(frame);
    });
    let config = Config { width: w, height: h, fps: 60, bitrate_bps: 6_000_000, key_interval };
    (Encoder::new(config, sink).expect("encoder"), rx)
}

/// NAL unit types of an Annex B stream (four-byte start codes).
fn nal_types(data: &[u8]) -> Vec<u8> {
    let mut types = Vec::new();
    let mut i = 0;
    while i + 4 < data.len() {
        if data[i..i + 4] == [0, 0, 0, 1] {
            types.push(data[i + 4] & 0x1f);
            i += 4;
        } else {
            i += 1;
        }
    }
    types
}

fn next(rx: &Receiver<EncodedFrame>) -> EncodedFrame {
    rx.recv_timeout(Duration::from_secs(5)).expect("an encoded frame within 5 s")
}

#[test]
fn the_first_frame_is_a_keyframe_with_parameter_sets_and_later_frames_are_not() {
    let (mut enc, rx) = encoder(1280, 720, Duration::from_secs(3600));
    assert_eq!((enc.width(), enc.height()), (1280, 720));
    assert!(enc.keyframe_pending(), "a new encoder starts with a keyframe request");
    let buffer = nv12_buffer(1280, 720, 0);
    enc.encode(buffer.0);
    let first = next(&rx);
    assert!(first.key);
    assert_eq!(&first.data[..4], &[0, 0, 0, 1], "Annex B");
    let types = nal_types(&first.data);
    assert_eq!(types[..3], [7, 8, 5], "SPS, PPS, IDR slice: {types:?}");
    assert!(!enc.keyframe_pending());
    for shift in 1..5 {
        let buffer = nv12_buffer(1280, 720, shift * 8);
        enc.encode(buffer.0);
        let frame = next(&rx);
        assert!(!frame.key, "frame {shift}");
        assert_eq!(nal_types(&frame.data), [1], "a plain P slice, no parameter sets");
    }
}

#[test]
fn a_requested_keyframe_is_the_next_frame_and_the_interval_forces_one() {
    let (mut enc, rx) = encoder(1280, 720, Duration::from_millis(300));
    let frames: Vec<_> = (0..3).map(|i| nv12_buffer(1280, 720, i * 8)).collect();
    enc.encode(frames[0].0);
    assert!(next(&rx).key);
    enc.encode(frames[1].0);
    assert!(!next(&rx).key);
    enc.request_keyframe();
    assert!(enc.keyframe_pending());
    enc.encode(frames[2].0);
    let requested = next(&rx);
    assert!(requested.key);
    assert_eq!(nal_types(&requested.data)[..2], [7, 8]);
    std::thread::sleep(Duration::from_millis(350));
    enc.encode(frames[0].0);
    assert!(next(&rx).key, "the 300 ms key interval has passed");
}

#[test]
fn the_quantizer_cap_is_accepted_by_the_session() {
    let (enc, _rx) = encoder(1280, 720, Duration::from_secs(3600));
    assert_eq!(enc.max_qp_status, 0, "MaxAllowedFrameQP was rejected");
}

#[test]
fn the_bitrate_can_be_changed_while_encoding() {
    let (mut enc, rx) = encoder(1280, 720, Duration::from_secs(3600));
    let frames: Vec<_> = (0..4).map(|i| nv12_buffer(1280, 720, i * 8)).collect();
    enc.encode(frames[0].0);
    next(&rx);
    enc.set_bitrate(2_000_000);
    enc.encode(frames[1].0);
    next(&rx);
    enc.set_bitrate(12_000_000);
    enc.encode(frames[2].0);
    next(&rx);
}

#[test]
fn dropping_the_encoder_with_a_frame_in_flight_is_clean() {
    let (mut enc, rx) = encoder(640, 480, Duration::from_secs(3600));
    let frame = nv12_buffer(640, 480, 0);
    enc.encode(frame.0);
    drop(enc); // CompleteFrames delivers what is pending, then the sink is freed
    assert!(rx.try_iter().count() <= 1);
}
