//! Stream size, frame rate and bitrate ceiling (spec D3).

pub const MIN_W: u32 = 640;
pub const MAX_W: u32 = 3840;
pub const MIN_H: u32 = 480;
pub const MAX_H: u32 = 2160;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Size {
    pub w: u32,
    pub h: u32,
}
impl Size {
    pub fn pixels(self) -> u64 {
        self.w as u64 * self.h as u64
    }
}

const QHD_PIXELS: u64 = 2560 * 1440;
const UHD_PIXELS: u64 = 3840 * 2160;

/// The page and the gateway already keep requests inside these limits and even; a value
/// from anywhere else is dropped rather than clamped. An odd value is rounded down.
pub fn parse_requested(w: i64, h: i64) -> Option<Size> {
    if !(MIN_W as i64..=MAX_W as i64).contains(&w) || !(MIN_H as i64..=MAX_H as i64).contains(&h) {
        return None;
    }
    Some(Size { w: (w as u32) & !1, h: (h as u32) & !1 })
}

/// The largest stream with the display's aspect ratio that fits in `requested` and is
/// never larger than the display's own pixels, with even sides.
pub fn fit_to_display(requested: Size, display_px: Size) -> Size {
    let scale = (requested.w as f64 / display_px.w as f64).min(requested.h as f64 / display_px.h as f64).min(1.0);
    let even = |v: f64| ((v.floor() as u32).max(2)) & !1;
    Size { w: even(display_px.w as f64 * scale), h: even(display_px.h as f64 * scale) }
}

/// 60 fps up to 2560x1440 pixels, 45 fps above (the M4 encoder tops out near 48 at 4K).
pub fn fps_for(size: Size) -> u32 {
    if size.pixels() <= QHD_PIXELS {
        60
    } else {
        45
    }
}

/// The ceiling the congestion controller works under, and where a session starts: 20 Mbps
/// up to 1440p, 35 Mbps at 4K, linear in the pixel count between.
pub fn bitrate_cap(size: Size) -> u32 {
    let p = size.pixels();
    if p <= QHD_PIXELS {
        return 20_000_000;
    }
    if p >= UHD_PIXELS {
        return 35_000_000;
    }
    let t = (p - QHD_PIXELS) as f64 / (UHD_PIXELS - QHD_PIXELS) as f64;
    (20_000_000.0 + t * 15_000_000.0).round() as u32
}

/// The size ScreenCaptureKit is asked to deliver. Its own scaler blurs text at every size but
/// the display's pixels (measured on a 3840x2160 display: its output at 2132x1200 and
/// even at exactly half had less than half the edge detail of a good resampler), so a stream smaller than the
/// display is captured at the display's real pixels and scaled by `mac::scale`. A display
/// whose size is unknown, or a stream as large as the display, is captured as requested.
pub fn capture_size(stream: Size, display_px: Option<Size>) -> Size {
    match display_px {
        Some(display) if display.w >= stream.w && display.h >= stream.h => display,
        _ => stream,
    }
}

/// Whether a captured frame of size `frame` has to be scaled down to the stream size. A smaller
/// frame is never scaled up here (the encoder follows the frame's size).
pub fn needs_scale(frame: Size, stream: Size) -> bool {
    frame.w > stream.w || frame.h > stream.h
}

// ---- tests ----

#[cfg(test)]
mod tests {
    use super::*;

    const D4K: Size = Size { w: 3840, h: 2160 };

    #[test]
    fn a_stream_smaller_than_the_display_is_captured_at_the_displays_pixels() {
        let stream = Size { w: 2132, h: 1200 };
        assert_eq!(capture_size(stream, Some(D4K)), D4K);
        assert_eq!(capture_size(D4K, Some(D4K)), D4K);
        assert_eq!(capture_size(stream, None), stream);
        // A display smaller than the stream in one side (cannot happen after fit_to_display): as requested.
        assert_eq!(capture_size(Size { w: 2000, h: 1200 }, Some(Size { w: 1920, h: 1080 })), Size { w: 2000, h: 1200 });
        assert_eq!(capture_size(Size { w: 1920, h: 1080 }, Some(Size { w: 1920, h: 1080 })), Size { w: 1920, h: 1080 });
    }

    #[test]
    fn frames_are_scaled_down_only() {
        let stream = Size { w: 2132, h: 1200 };
        assert!(needs_scale(D4K, stream));
        assert!(needs_scale(Size { w: 2132, h: 1202 }, stream));
        assert!(!needs_scale(stream, stream));
        assert!(!needs_scale(Size { w: 1920, h: 1080 }, stream));
    }

    #[test]
    fn requests_outside_the_limits_are_dropped_and_odd_sides_round_down() {
        assert_eq!(parse_requested(640, 480), Some(Size { w: 640, h: 480 }));
        assert_eq!(parse_requested(3840, 2160), Some(D4K));
        assert_eq!(parse_requested(1921, 1081), Some(Size { w: 1920, h: 1080 }));
        for (w, h) in [(639, 480), (640, 479), (3841, 2160), (3840, 2161), (0, 0), (-1, 600), (i64::MAX, 600)] {
            assert_eq!(parse_requested(w, h), None, "{w}x{h}");
        }
    }

    #[test]
    fn the_stream_keeps_the_display_aspect_inside_the_request() {
        // A 16:10 window on a 16:9 display: the width is the limit.
        assert_eq!(fit_to_display(Size { w: 1440, h: 900 }, D4K), Size { w: 1440, h: 810 });
        // A tall window: the height is the limit... of the width here.
        assert_eq!(fit_to_display(Size { w: 800, h: 1200 }, D4K), Size { w: 800, h: 450 });
        // Exactly the display's own aspect.
        assert_eq!(fit_to_display(Size { w: 1920, h: 1080 }, D4K), Size { w: 1920, h: 1080 });
    }

    #[test]
    fn the_stream_is_never_larger_than_the_display() {
        let small = Size { w: 1920, h: 1080 };
        assert_eq!(fit_to_display(D4K, small), small);
    }

    #[test]
    fn a_non_even_result_is_rounded_down_to_even() {
        let out = fit_to_display(Size { w: 1001, h: 2000 }, Size { w: 3000, h: 2001 });
        assert_eq!(out.w % 2, 0);
        assert_eq!(out.h % 2, 0);
        assert!(out.w <= 1001 && out.h <= 2000);
    }

    #[test]
    fn frame_rate_steps_down_above_1440p_pixels() {
        assert_eq!(fps_for(Size { w: 2560, h: 1440 }), 60);
        assert_eq!(fps_for(Size { w: 1920, h: 1080 }), 60);
        assert_eq!(fps_for(Size { w: 2560, h: 1442 }), 45);
        assert_eq!(fps_for(D4K), 45);
    }

    #[test]
    fn the_bitrate_ceiling_follows_the_pixel_count() {
        assert_eq!(bitrate_cap(Size { w: 1920, h: 1080 }), 20_000_000);
        assert_eq!(bitrate_cap(Size { w: 2560, h: 1440 }), 20_000_000);
        assert_eq!(bitrate_cap(D4K), 35_000_000);
        // 3200x1800 is 5 760 000 pixels, 45 % of the way from 1440p (3 686 400) to 4K (8 294 400).
        assert_eq!(bitrate_cap(Size { w: 3200, h: 1800 }), 26_750_000);
        assert_eq!(bitrate_cap(Size { w: 2560, h: 1442 }), 20_016_667, "one row above 1440p starts the climb");
        assert_eq!(bitrate_cap(Size { w: 3840, h: 2158 }), 34_975_000, "and one row under 4K nearly reaches it");
    }
}
