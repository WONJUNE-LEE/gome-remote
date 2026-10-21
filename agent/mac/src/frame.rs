//! What the encoder hands to the peer.
use std::time::Instant;

/// Where encoded frames go: the session's WebRTC peer (peer.rs), or a stand-in in tests.
pub trait FrameTarget: Send + Sync {
    /// False when the target is gone and wants no more frames.
    fn send_frame(&self, frame: EncodedFrame) -> bool;
    /// The system stopped the capture stream under this target: no more frames will come until
    /// the capture is started again. The session restarts it, or ends when it cannot (the page
    /// then shows its ended card); a target with no session behind it just ends.
    fn stream_stopped(&self) {}
}

pub struct EncodedFrame {
    /// Annex B access unit (SPS and PPS in front of every keyframe).
    pub data: Vec<u8>,
    pub key: bool,
    /// When the frame was handed to the encoder (that is, when it was captured).
    pub submitted: Instant,
}
