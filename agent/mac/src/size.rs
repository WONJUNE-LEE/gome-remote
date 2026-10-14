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

/// The ceiling the congestion controller works under: 12 Mbps up to 1440p, 20 Mbps at
/// 4K, linear in the pixel count between.
pub fn bitrate_cap(size: Size) -> u32 {
    let p = size.pixels();
    if p <= QHD_PIXELS {
        return 12_000_000;
    }
    if p >= UHD_PIXELS {
        return 20_000_000;
    }
    let t = (p - QHD_PIXELS) as f64 / (UHD_PIXELS - QHD_PIXELS) as f64;
    (12_000_000.0 + t * 8_000_000.0).round() as u32
}

// ---- tests ----

#[cfg(test)]
mod tests {
    use super::*;

    const D4K: Size = Size { w: 3840, h: 2160 };

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
        assert_eq!(bitrate_cap(Size { w: 1920, h: 1080 }), 12_000_000);
        assert_eq!(bitrate_cap(Size { w: 2560, h: 1440 }), 12_000_000);
        assert_eq!(bitrate_cap(D4K), 20_000_000);
        // 3200x1800 is 5 760 000 pixels, 45 % of the way from 1440p (3 686 400) to 4K (8 294 400).
        assert_eq!(bitrate_cap(Size { w: 3200, h: 1800 }), 15_600_000);
        assert_eq!(bitrate_cap(Size { w: 2560, h: 1442 }), 12_008_889, "one row above 1440p starts the climb");
        assert_eq!(bitrate_cap(Size { w: 3840, h: 2158 }), 19_986_667, "and one row under 4K nearly reaches it");
    }
}
