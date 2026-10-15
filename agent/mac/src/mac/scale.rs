//! Scales captured frames down to the stream size with VideoToolbox's pixel transfer, which
//! resamples far more sharply than ScreenCaptureKit's own scaler (text edges keep their
//! contrast; see `size::capture_size`). The output buffers come from a pool sized for the
//! stream, so a frame the encoder or the keepalive still holds is never overwritten.
use super::ffi::*;
use crate::size::Size;

const NV12: u32 = 0x34323076; // '420v', what the capture delivers

pub struct Scaler {
    session: Cf,
    pool: Option<(Size, Cf)>,
}

impl Scaler {
    pub fn new() -> Result<Self, String> {
        let mut session: CFTypeRef = std::ptr::null();
        let status = unsafe { VTPixelTransferSessionCreate(std::ptr::null(), &mut session) };
        if status != 0 || session.is_null() {
            return Err(format!("VTPixelTransferSessionCreate OSStatus {status}"));
        }
        Ok(Scaler { session: Cf(session), pool: None })
    }

    fn pool_for(&mut self, size: Size) -> Result<CFTypeRef, String> {
        if let Some((have, pool)) = &self.pool {
            if *have == size {
                return Ok(pool.0);
            }
        }
        let (w, h, fmt) = (cf_i32(size.w as i32), cf_i32(size.h as i32), cf_i32(NV12 as i32));
        let attrs = cf_dict(&[
            (unsafe { kCVPixelBufferWidthKey }, w.0),
            (unsafe { kCVPixelBufferHeightKey }, h.0),
            (unsafe { kCVPixelBufferPixelFormatTypeKey }, fmt.0),
            (unsafe { kCVPixelBufferIOSurfacePropertiesKey }, cf_dict(&[]).0),
        ]);
        let mut pool: CFTypeRef = std::ptr::null();
        let status = unsafe { CVPixelBufferPoolCreate(std::ptr::null(), std::ptr::null(), attrs.0, &mut pool) };
        if status != 0 || pool.is_null() {
            return Err(format!("CVPixelBufferPoolCreate OSStatus {status}"));
        }
        let pool = Cf(pool);
        let raw = pool.0;
        self.pool = Some((size, pool));
        Ok(raw)
    }

    /// A new buffer of `size` holding `src` scaled to it. `src` is a live pixel buffer handed
    /// out by the capture; a safe signature keeps the pipeline's call site free of `unsafe`.
    #[allow(clippy::not_unsafe_ptr_arg_deref)]
    pub fn scale(&mut self, src: CVPixelBufferRef, size: Size) -> Result<PixBuf, String> {
        let pool = self.pool_for(size)?;
        let mut out: CVPixelBufferRef = std::ptr::null();
        let status = unsafe { CVPixelBufferPoolCreatePixelBuffer(std::ptr::null(), pool, &mut out) };
        if status != 0 || out.is_null() {
            return Err(format!("CVPixelBufferPoolCreatePixelBuffer OSStatus {status}"));
        }
        let out = PixBuf(out); // owned: released on every path below
        let status = unsafe { VTPixelTransferSessionTransferImage(self.session.0, src, out.0) };
        if status != 0 {
            return Err(format!("VTPixelTransferSessionTransferImage OSStatus {status}"));
        }
        Ok(out)
    }
}

impl Drop for Scaler {
    fn drop(&mut self) {
        unsafe { VTPixelTransferSessionInvalidate(self.session.0) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain_buffer(w: usize, h: usize) -> PixBuf {
        let mut pb: CVPixelBufferRef = std::ptr::null();
        let attrs = cf_dict(&[(unsafe { kCVPixelBufferIOSurfacePropertiesKey }, cf_dict(&[]).0)]);
        assert_eq!(unsafe { CVPixelBufferCreate(std::ptr::null(), w, h, NV12, attrs.0, &mut pb) }, 0);
        PixBuf(pb)
    }

    /// Luma 16 on the left half, 235 on the right half; neutral chroma.
    fn half_and_half(w: usize, h: usize) -> PixBuf {
        let buffer = plain_buffer(w, h);
        unsafe {
            assert_eq!(CVPixelBufferLockBaseAddress(buffer.0, 0), 0);
            let (luma, stride) =
                (CVPixelBufferGetBaseAddressOfPlane(buffer.0, 0), CVPixelBufferGetBytesPerRowOfPlane(buffer.0, 0));
            for y in 0..h {
                for x in 0..w {
                    *luma.add(y * stride + x) = if x < w / 2 { 16 } else { 235 };
                }
            }
            let (chroma, stride) =
                (CVPixelBufferGetBaseAddressOfPlane(buffer.0, 1), CVPixelBufferGetBytesPerRowOfPlane(buffer.0, 1));
            for y in 0..h / 2 {
                std::ptr::write_bytes(chroma.add(y * stride), 128, w);
            }
            CVPixelBufferUnlockBaseAddress(buffer.0, 0);
        }
        buffer
    }

    fn luma_row(buffer: &PixBuf, y: usize) -> Vec<u8> {
        unsafe {
            assert_eq!(CVPixelBufferLockBaseAddress(buffer.0, 1), 0);
            let (w, stride) = (CVPixelBufferGetWidth(buffer.0), CVPixelBufferGetBytesPerRowOfPlane(buffer.0, 0));
            let row =
                std::slice::from_raw_parts(CVPixelBufferGetBaseAddressOfPlane(buffer.0, 0).add(y * stride), w).to_vec();
            CVPixelBufferUnlockBaseAddress(buffer.0, 1);
            row
        }
    }

    #[test]
    fn a_frame_is_scaled_to_the_stream_size_and_keeps_a_hard_edge_hard() {
        let mut scaler = Scaler::new().expect("a pixel transfer session");
        let stream = Size { w: 1066, h: 600 };
        let out = scaler.scale(half_and_half(1920, 1080).0, stream).expect("scaled");
        unsafe {
            assert_eq!((CVPixelBufferGetWidth(out.0), CVPixelBufferGetHeight(out.0)), (1066, 600));
            assert_eq!(CVPixelBufferGetPixelFormatType(out.0), NV12);
        }
        let row = luma_row(&out, 300);
        assert!(row[10] <= 18 && row[1055] >= 233, "flat areas stay flat: {} {}", row[10], row[1055]);
        // The edge goes from dark to bright within 3 pixels (a blurring scaler spreads it over many).
        let dark = row.iter().rposition(|&v| v <= 40).unwrap();
        let bright = row.iter().position(|&v| v >= 210).unwrap();
        assert!(bright > dark && bright - dark <= 3, "edge from {dark} to {bright}");
    }

    #[test]
    fn buffers_held_by_the_caller_are_not_reused_and_a_new_size_gets_a_new_pool() {
        let mut scaler = Scaler::new().unwrap();
        let source = half_and_half(1920, 1080);
        let size = Size { w: 960, h: 540 };
        let first = scaler.scale(source.0, size).unwrap();
        let second = scaler.scale(source.0, size).unwrap();
        assert_ne!(first.0, second.0);
        let other = scaler.scale(source.0, Size { w: 640, h: 480 }).unwrap();
        unsafe { assert_eq!((CVPixelBufferGetWidth(other.0), CVPixelBufferGetHeight(other.0)), (640, 480)) };
    }
}
