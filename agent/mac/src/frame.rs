//! What the encoder hands to the peer.
use std::time::Instant;

/// Where encoded frames go: the session's WebRTC peer (peer.rs), or a stand-in in tests.
pub trait FrameTarget: Send + Sync {
    /// False when the target is gone and wants no more frames.
    fn send_frame(&self, frame: EncodedFrame) -> bool;
}

pub struct EncodedFrame {
    /// Annex B access unit (SPS and PPS in front of every keyframe).
    pub data: Vec<u8>,
    pub key: bool,
    /// When the frame was handed to the encoder (that is, when it was captured).
    pub submitted: Instant,
}
