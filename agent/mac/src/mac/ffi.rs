//! Hand-written FFI for the C frameworks (CoreFoundation, CoreMedia, CoreVideo,
//! VideoToolbox, CoreGraphics, ApplicationServices). ScreenCaptureKit goes through objc2.
#![allow(non_snake_case, non_upper_case_globals, dead_code)]
use std::ffi::c_void;

pub type CFTypeRef = *const c_void;
pub type OSStatus = i32;
pub type VTSession = *mut c_void;
pub type CMSampleBufferRef = *const c_void;
pub type CVPixelBufferRef = *const c_void;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct CMTime {
    pub value: i64,
    pub timescale: i32,
    pub flags: u32,
    pub epoch: i64,
}
impl CMTime {
    pub fn make(value: i64, timescale: i32) -> Self {
        CMTime { value, timescale, flags: 1, epoch: 0 }
    }
    pub fn invalid() -> Self {
        CMTime { value: 0, timescale: 0, flags: 0, epoch: 0 }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct CGPoint {
    pub x: f64,
    pub y: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct CGSize {
    pub width: f64,
    pub height: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct CGRect {
    pub origin: CGPoint,
    pub size: CGSize,
}

pub const kCFNumberSInt32Type: isize = 3;
pub const kCFNumberSInt64Type: isize = 4;
pub const kCFNumberFloat64Type: isize = 6;

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    pub static kCFBooleanTrue: CFTypeRef;
    pub static kCFBooleanFalse: CFTypeRef;
    pub static kCFTypeDictionaryKeyCallBacks: c_void;
    pub static kCFTypeDictionaryValueCallBacks: c_void;
    pub static kCFTypeArrayCallBacks: c_void;
    pub fn CFRelease(cf: CFTypeRef);
    pub fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
    pub fn CFNumberCreate(alloc: CFTypeRef, ty: isize, value: *const c_void) -> CFTypeRef;
    pub fn CFDictionaryCreate(
        alloc: CFTypeRef,
        keys: *const CFTypeRef,
        values: *const CFTypeRef,
        n: isize,
        key_cb: *const c_void,
        val_cb: *const c_void,
    ) -> CFTypeRef;
    pub fn CFDictionaryGetValue(d: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
    pub fn CFArrayCreate(alloc: CFTypeRef, values: *const CFTypeRef, n: isize, cb: *const c_void) -> CFTypeRef;
    pub fn CFArrayGetCount(a: CFTypeRef) -> isize;
    pub fn CFArrayGetValueAtIndex(a: CFTypeRef, i: isize) -> CFTypeRef;
    pub fn CFRunLoopRun();
}

#[link(name = "CoreMedia", kind = "framework")]
extern "C" {
    pub static kCMSampleAttachmentKey_NotSync: CFTypeRef;
    pub fn CMSampleBufferGetImageBuffer(sb: CMSampleBufferRef) -> CVPixelBufferRef;
    pub fn CMSampleBufferGetPresentationTimeStamp(sb: CMSampleBufferRef) -> CMTime;
    pub fn CMClockGetHostTimeClock() -> CFTypeRef;
    pub fn CMClockGetTime(clock: CFTypeRef) -> CMTime;
    pub fn CMSampleBufferGetDataBuffer(sb: CMSampleBufferRef) -> CFTypeRef;
    pub fn CMSampleBufferGetFormatDescription(sb: CMSampleBufferRef) -> CFTypeRef;
    pub fn CMSampleBufferGetSampleAttachmentsArray(sb: CMSampleBufferRef, create: u8) -> CFTypeRef;
    pub fn CMBlockBufferGetDataLength(bb: CFTypeRef) -> usize;
    pub fn CMBlockBufferCopyDataBytes(bb: CFTypeRef, offset: usize, len: usize, dest: *mut u8) -> OSStatus;
    pub fn CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        fd: CFTypeRef,
        idx: usize,
        ptr_out: *mut *const u8,
        size_out: *mut usize,
        count_out: *mut usize,
        nal_hdr_len_out: *mut i32,
    ) -> OSStatus;
}

#[link(name = "CoreVideo", kind = "framework")]
extern "C" {
    pub static kCVPixelBufferIOSurfacePropertiesKey: CFTypeRef;
    pub static kCVPixelBufferWidthKey: CFTypeRef;
    pub static kCVPixelBufferHeightKey: CFTypeRef;
    pub static kCVPixelBufferPixelFormatTypeKey: CFTypeRef;
    pub fn CVPixelBufferPoolCreate(
        alloc: CFTypeRef,
        pool_attrs: CFTypeRef,
        buffer_attrs: CFTypeRef,
        out: *mut CFTypeRef,
    ) -> i32;
    pub fn CVPixelBufferPoolCreatePixelBuffer(alloc: CFTypeRef, pool: CFTypeRef, out: *mut CVPixelBufferRef) -> i32;
    pub fn CVPixelBufferCreate(
        alloc: CFTypeRef,
        w: usize,
        h: usize,
        fmt: u32,
        attrs: CFTypeRef,
        out: *mut CVPixelBufferRef,
    ) -> i32;
    pub fn CVPixelBufferLockBaseAddress(pb: CVPixelBufferRef, flags: u64) -> i32;
    pub fn CVPixelBufferUnlockBaseAddress(pb: CVPixelBufferRef, flags: u64) -> i32;
    pub fn CVPixelBufferGetBaseAddress(pb: CVPixelBufferRef) -> *mut u8;
    pub fn CVPixelBufferGetBaseAddressOfPlane(pb: CVPixelBufferRef, plane: usize) -> *mut u8;
    pub fn CVPixelBufferGetBytesPerRowOfPlane(pb: CVPixelBufferRef, plane: usize) -> usize;
    pub fn CVPixelBufferGetBytesPerRow(pb: CVPixelBufferRef) -> usize;
    pub fn CVPixelBufferGetWidth(pb: CVPixelBufferRef) -> usize;
    pub fn CVPixelBufferGetHeight(pb: CVPixelBufferRef) -> usize;
    pub fn CVPixelBufferGetPixelFormatType(pb: CVPixelBufferRef) -> u32;
}

#[link(name = "VideoToolbox", kind = "framework")]
extern "C" {
    pub fn VTPixelTransferSessionCreate(alloc: CFTypeRef, out: *mut CFTypeRef) -> OSStatus;
    pub fn VTPixelTransferSessionTransferImage(s: CFTypeRef, src: CVPixelBufferRef, dst: CVPixelBufferRef) -> OSStatus;
    pub fn VTPixelTransferSessionInvalidate(s: CFTypeRef);
}

pub type VTOutputCallback =
    extern "C" fn(refcon: *mut c_void, frame_refcon: *mut c_void, status: OSStatus, flags: u32, sb: CMSampleBufferRef);

#[link(name = "VideoToolbox", kind = "framework")]
extern "C" {
    pub static kVTCompressionPropertyKey_RealTime: CFTypeRef;
    pub static kVTCompressionPropertyKey_AllowFrameReordering: CFTypeRef;
    pub static kVTCompressionPropertyKey_ProfileLevel: CFTypeRef;
    pub static kVTCompressionPropertyKey_AverageBitRate: CFTypeRef;
    pub static kVTCompressionPropertyKey_DataRateLimits: CFTypeRef;
    pub static kVTCompressionPropertyKey_ExpectedFrameRate: CFTypeRef;
    pub static kVTCompressionPropertyKey_MaxKeyFrameInterval: CFTypeRef;
    pub static kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: CFTypeRef;
    pub static kVTCompressionPropertyKey_MaxFrameDelayCount: CFTypeRef;
    pub static kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality: CFTypeRef;
    pub static kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder: CFTypeRef;
    pub static kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel: CFTypeRef;
    pub static kVTProfileLevel_H264_Baseline_AutoLevel: CFTypeRef;
    pub static kVTProfileLevel_H264_Main_AutoLevel: CFTypeRef;
    pub static kVTProfileLevel_H264_High_AutoLevel: CFTypeRef;
    pub static kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: CFTypeRef;
    pub static kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: CFTypeRef;
    pub static kVTVideoEncoderSpecification_EnableLowLatencyRateControl: CFTypeRef;
    pub static kVTEncodeFrameOptionKey_ForceKeyFrame: CFTypeRef;

    pub fn VTCompressionSessionCreate(
        alloc: CFTypeRef,
        w: i32,
        h: i32,
        codec: u32,
        encoder_spec: CFTypeRef,
        src_attrs: CFTypeRef,
        comp_alloc: CFTypeRef,
        cb: VTOutputCallback,
        refcon: *mut c_void,
        out: *mut VTSession,
    ) -> OSStatus;
    pub fn VTSessionSetProperty(s: VTSession, key: CFTypeRef, value: CFTypeRef) -> OSStatus;
    pub fn VTSessionCopyProperty(s: VTSession, key: CFTypeRef, alloc: CFTypeRef, out: *mut CFTypeRef) -> OSStatus;
    pub fn VTCompressionSessionPrepareToEncodeFrames(s: VTSession) -> OSStatus;
    pub fn VTCompressionSessionEncodeFrame(
        s: VTSession,
        image: CVPixelBufferRef,
        pts: CMTime,
        duration: CMTime,
        frame_props: CFTypeRef,
        frame_refcon: *mut c_void,
        flags_out: *mut u32,
    ) -> OSStatus;
    pub fn VTCompressionSessionCompleteFrames(s: VTSession, until: CMTime) -> OSStatus;
    pub fn VTCompressionSessionInvalidate(s: VTSession);
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    pub fn CGMainDisplayID() -> u32;
    pub fn CGDisplayBounds(d: u32) -> CGRect;
    pub fn CGPreflightScreenCaptureAccess() -> bool;
    pub fn CGRequestScreenCaptureAccess() -> bool;
    pub fn CGEventCreateMouseEvent(src: CFTypeRef, ty: u32, pos: CGPoint, button: u32) -> CFTypeRef;
    pub fn CGEventPost(tap: u32, ev: CFTypeRef);
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    pub static kAXTrustedCheckOptionPrompt: CFTypeRef;
    pub fn AXIsProcessTrusted() -> bool;
    pub fn AXIsProcessTrustedWithOptions(opts: CFTypeRef) -> bool;
}

/// Owned CF object wrapper.
pub struct Cf(pub CFTypeRef);
unsafe impl Send for Cf {}
unsafe impl Sync for Cf {}
impl Drop for Cf {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) }
        }
    }
}

pub fn cf_i32(v: i32) -> Cf {
    Cf(unsafe { CFNumberCreate(std::ptr::null(), kCFNumberSInt32Type, &v as *const i32 as *const c_void) })
}
pub fn cf_f64(v: f64) -> Cf {
    Cf(unsafe { CFNumberCreate(std::ptr::null(), kCFNumberFloat64Type, &v as *const f64 as *const c_void) })
}
pub fn cf_dict(pairs: &[(CFTypeRef, CFTypeRef)]) -> Cf {
    let keys: Vec<CFTypeRef> = pairs.iter().map(|p| p.0).collect();
    let vals: Vec<CFTypeRef> = pairs.iter().map(|p| p.1).collect();
    Cf(unsafe {
        CFDictionaryCreate(
            std::ptr::null(),
            keys.as_ptr(),
            vals.as_ptr(),
            pairs.len() as isize,
            &kCFTypeDictionaryKeyCallBacks as *const c_void,
            &kCFTypeDictionaryValueCallBacks as *const c_void,
        )
    })
}
pub fn cf_array(vals: &[CFTypeRef]) -> Cf {
    Cf(unsafe {
        CFArrayCreate(std::ptr::null(), vals.as_ptr(), vals.len() as isize, &kCFTypeArrayCallBacks as *const c_void)
    })
}

/// Retained pixel buffer (CVPixelBuffer is a CF type).
pub struct PixBuf(pub CVPixelBufferRef);
unsafe impl Send for PixBuf {}
unsafe impl Sync for PixBuf {}
impl PixBuf {
    /// Retains. The callers hold a live pixel buffer handed out by the framework; a safe
    /// signature keeps the call sites of the pipeline free of `unsafe`.
    #[allow(clippy::not_unsafe_ptr_arg_deref)]
    pub fn retain(p: CVPixelBufferRef) -> Self {
        unsafe { CFRetain(p) };
        PixBuf(p)
    }
}
impl Drop for PixBuf {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) }
    }
}

// ---- additions for the production agent (not in the spike) ----

pub const kCFStringEncodingUTF8: u32 = 0x0800_0100;

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    pub fn CFStringCreateWithCString(alloc: CFTypeRef, c_str: *const std::os::raw::c_char, encoding: u32) -> CFTypeRef;
}

/// CGEvent type codes used by the injector.
pub const kCGEventLeftMouseDown: u32 = 1;
pub const kCGEventLeftMouseUp: u32 = 2;
pub const kCGEventRightMouseDown: u32 = 3;
pub const kCGEventRightMouseUp: u32 = 4;
pub const kCGEventMouseMoved: u32 = 5;
pub const kCGEventLeftMouseDragged: u32 = 6;
pub const kCGEventRightMouseDragged: u32 = 7;
pub const kCGEventKeyDown: u32 = 10;
pub const kCGEventKeyUp: u32 = 11;
pub const kCGEventFlagsChanged: u32 = 12;
pub const kCGEventOtherMouseDown: u32 = 25;
pub const kCGEventOtherMouseUp: u32 = 26;
pub const kCGEventOtherMouseDragged: u32 = 27;
/// CGEventField values.
pub const kCGMouseEventClickState: u32 = 1;
pub const kCGKeyboardEventAutorepeat: u32 = 8;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    pub fn CGSessionCopyCurrentDictionary() -> CFTypeRef;
    pub fn CGDisplayIsAsleep(d: u32) -> u32;
    pub fn CGDisplayCopyDisplayMode(d: u32) -> CFTypeRef;
    pub fn CGDisplayModeGetPixelWidth(mode: CFTypeRef) -> usize;
    pub fn CGDisplayModeGetPixelHeight(mode: CFTypeRef) -> usize;
    pub fn CGEventCreateKeyboardEvent(src: CFTypeRef, key: u16, down: bool) -> CFTypeRef;
    pub fn CGEventKeyboardSetUnicodeString(ev: CFTypeRef, len: usize, chars: *const u16);
    pub fn CGEventSetFlags(ev: CFTypeRef, flags: u64);
    pub fn CGEventSetType(ev: CFTypeRef, ty: u32);
    pub fn CGEventSetIntegerValueField(ev: CFTypeRef, field: u32, value: i64);
    pub fn CGEventCreateScrollWheelEvent2(
        src: CFTypeRef,
        units: u32,
        wheel_count: u32,
        wheel1: i32,
        wheel2: i32,
        wheel3: i32,
    ) -> CFTypeRef;
}

#[link(name = "IOKit", kind = "framework")]
extern "C" {
    pub fn IOPMAssertionDeclareUserActivity(name: CFTypeRef, kind: u32, id: *mut u32) -> i32;
    pub fn IOPMAssertionCreateWithName(kind: CFTypeRef, level: u32, name: CFTypeRef, id: *mut u32) -> i32;
    pub fn IOPMAssertionRelease(id: u32) -> i32;
}

/// A CFString from a Rust string (the caller owns it through `Cf`).
pub fn cf_string(text: &str) -> Cf {
    let c = std::ffi::CString::new(text).expect("no NUL in a constant string");
    Cf(unsafe { CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), kCFStringEncodingUTF8) })
}
