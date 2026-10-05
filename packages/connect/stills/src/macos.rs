// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `VideoToolbox`: macOS's own H.264 decoder, through its C API (`CoreMedia`, `CoreVideo`,
//! `CoreFoundation`). One key frame in, one 32-bit BGRA pixel buffer out, copied to RGB.
use std::ffi::c_void;
use std::ptr::{null, null_mut};
use std::sync::Mutex;

use crate::Rgb;
use crate::nal;

type OSStatus = i32;
type CFTypeRef = *const c_void;
type CFAllocatorRef = *const c_void;
type CFStringRef = *const c_void;
type CFDictionaryRef = *const c_void;
type CFNumberRef = *const c_void;
type CMFormatDescriptionRef = *const c_void;
type CMBlockBufferRef = *mut c_void;
type CMSampleBufferRef = *mut c_void;
type VTDecompressionSessionRef = *mut c_void;
type CVImageBufferRef = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy)]
struct CMTime {
    value: i64,
    timescale: i32,
    flags: u32,
    epoch: i64,
}

type OutputCallback =
    extern "C" fn(*mut c_void, *mut c_void, OSStatus, u32, CVImageBufferRef, CMTime, CMTime);

#[repr(C)]
struct OutputCallbackRecord {
    callback: OutputCallback,
    ref_con: *mut c_void,
}

/// `CFDictionaryKeyCallBacks` and `CFDictionaryValueCallBacks`; only their addresses are used.
#[repr(C)]
struct DictCallBacks {
    version: isize,
    retain: *const c_void,
    release: *const c_void,
    copy_description: *const c_void,
    equal: *const c_void,
    hash: *const c_void,
}

const K_CF_NUMBER_SINT32_TYPE: isize = 3;
const K_CM_BLOCK_BUFFER_ASSURE_MEMORY_NOW_FLAG: u32 = 1;
const K_CV_PIXEL_BUFFER_LOCK_READ_ONLY: u64 = 1;
/// `'BGRA'`.
const K_CV_PIXEL_FORMAT_32BGRA: u32 = 0x4247_5241;

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFTypeDictionaryKeyCallBacks: DictCallBacks;
    static kCFTypeDictionaryValueCallBacks: DictCallBacks;
    fn CFNumberCreate(allocator: CFAllocatorRef, kind: isize, value: *const c_void) -> CFNumberRef;
    fn CFDictionaryCreate(
        allocator: CFAllocatorRef,
        keys: *const *const c_void,
        values: *const *const c_void,
        count: isize,
        key_callbacks: *const DictCallBacks,
        value_callbacks: *const DictCallBacks,
    ) -> CFDictionaryRef;
    fn CFRelease(cf: CFTypeRef);
}

#[link(name = "CoreVideo", kind = "framework")]
unsafe extern "C" {
    static kCVPixelBufferPixelFormatTypeKey: CFStringRef;
    fn CVPixelBufferLockBaseAddress(buffer: CVImageBufferRef, flags: u64) -> i32;
    fn CVPixelBufferUnlockBaseAddress(buffer: CVImageBufferRef, flags: u64) -> i32;
    fn CVPixelBufferGetBaseAddress(buffer: CVImageBufferRef) -> *mut c_void;
    fn CVPixelBufferGetBytesPerRow(buffer: CVImageBufferRef) -> usize;
    fn CVPixelBufferGetWidth(buffer: CVImageBufferRef) -> usize;
    fn CVPixelBufferGetHeight(buffer: CVImageBufferRef) -> usize;
    fn CVPixelBufferGetPixelFormatType(buffer: CVImageBufferRef) -> u32;
}

#[link(name = "CoreMedia", kind = "framework")]
unsafe extern "C" {
    fn CMVideoFormatDescriptionCreateFromH264ParameterSets(
        allocator: CFAllocatorRef,
        count: usize,
        pointers: *const *const u8,
        sizes: *const usize,
        nal_header_length: i32,
        out: *mut CMFormatDescriptionRef,
    ) -> OSStatus;
    fn CMBlockBufferCreateWithMemoryBlock(
        structure_allocator: CFAllocatorRef,
        memory_block: *mut c_void,
        block_length: usize,
        block_allocator: CFAllocatorRef,
        custom_block_source: *const c_void,
        offset_to_data: usize,
        data_length: usize,
        flags: u32,
        out: *mut CMBlockBufferRef,
    ) -> OSStatus;
    fn CMBlockBufferReplaceDataBytes(
        source: *const c_void,
        destination: CMBlockBufferRef,
        offset: usize,
        length: usize,
    ) -> OSStatus;
    fn CMSampleBufferCreateReady(
        allocator: CFAllocatorRef,
        data_buffer: CMBlockBufferRef,
        format: CMFormatDescriptionRef,
        num_samples: isize,
        num_timing_entries: isize,
        timing: *const c_void,
        num_size_entries: isize,
        sizes: *const usize,
        out: *mut CMSampleBufferRef,
    ) -> OSStatus;
}

#[link(name = "VideoToolbox", kind = "framework")]
unsafe extern "C" {
    fn VTDecompressionSessionCreate(
        allocator: CFAllocatorRef,
        format: CMFormatDescriptionRef,
        decoder_specification: CFDictionaryRef,
        image_buffer_attributes: CFDictionaryRef,
        callback: *const OutputCallbackRecord,
        out: *mut VTDecompressionSessionRef,
    ) -> OSStatus;
    fn VTDecompressionSessionDecodeFrame(
        session: VTDecompressionSessionRef,
        sample: CMSampleBufferRef,
        flags: u32,
        frame_ref_con: *mut c_void,
        info_out: *mut u32,
    ) -> OSStatus;
    fn VTDecompressionSessionWaitForAsynchronousFrames(session: VTDecompressionSessionRef) -> OSStatus;
    fn VTDecompressionSessionInvalidate(session: VTDecompressionSessionRef);
}

/// Releases a Core Foundation object when dropped.
struct Owned(CFTypeRef);

impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: `self.0` came from a CF/CM/VT create function that returned it retained, and is
            // released exactly once, here.
            unsafe { CFRelease(self.0) };
        }
    }
}

/// Where the output callback leaves the picture.
type Slot = Mutex<Option<Rgb>>;

extern "C" fn on_output(
    ref_con: *mut c_void,
    _frame_ref_con: *mut c_void,
    status: OSStatus,
    _info: u32,
    image: CVImageBufferRef,
    _pts: CMTime,
    _duration: CMTime,
) {
    if status != 0 || image.is_null() || ref_con.is_null() {
        return;
    }
    // SAFETY: `ref_con` is the `&Slot` passed in `decode`, which outlives the session (the session
    // is invalidated, after waiting for all frames, before the slot is dropped).
    let slot = unsafe { &*ref_con.cast::<Slot>() };
    // SAFETY: `image` is a valid pixel buffer for the duration of this callback, per the
    // VTDecompressionOutputCallback contract; it is locked read-only while its memory is read.
    let rgb = unsafe {
        if CVPixelBufferGetPixelFormatType(image) != K_CV_PIXEL_FORMAT_32BGRA
            || CVPixelBufferLockBaseAddress(image, K_CV_PIXEL_BUFFER_LOCK_READ_ONLY) != 0
        {
            return;
        }
        let width = CVPixelBufferGetWidth(image);
        let height = CVPixelBufferGetHeight(image);
        let stride = CVPixelBufferGetBytesPerRow(image);
        let base = CVPixelBufferGetBaseAddress(image).cast::<u8>().cast_const();
        let out = if base.is_null() || stride < width * 4 {
            None
        } else {
            let bytes = std::slice::from_raw_parts(base, stride * height);
            let mut data = Vec::with_capacity(width * height * 3);
            for row in bytes.chunks(stride).take(height) {
                for &[b, g, r, _] in row.as_chunks::<4>().0.iter().take(width) {
                    data.extend_from_slice(&[r, g, b]);
                }
            }
            Some(Rgb { width, height, data })
        };
        CVPixelBufferUnlockBaseAddress(image, K_CV_PIXEL_BUFFER_LOCK_READ_ONLY);
        out
    };
    if let (Some(rgb), Ok(mut s)) = (rgb, slot.lock()) {
        *s = Some(rgb);
    }
}

/// Decodes one key frame access unit (Annex B, with SPS and PPS) with `VideoToolbox`.
// One straight line of CoreMedia setup; splitting it would spread the ownership of the CF objects.
#[allow(clippy::too_many_lines)]
pub(crate) fn decode(access_unit: &[u8]) -> Option<Rgb> {
    let units = nal::units(access_unit);
    let sps = units.iter().find(|u| nal::kind(u) == 7)?;
    let pps = units.iter().find(|u| nal::kind(u) == 8)?;
    // The picture's slices, each behind a four byte big endian length (AVCC), as CoreMedia wants.
    let mut avcc = Vec::with_capacity(access_unit.len() + 16);
    for u in units.iter().filter(|u| (1..=5).contains(&nal::kind(u))) {
        avcc.extend_from_slice(&u32::try_from(u.len()).ok()?.to_be_bytes());
        avcc.extend_from_slice(u);
    }
    if avcc.is_empty() {
        return None;
    }

    let mut format: CMFormatDescriptionRef = null();
    let sets = [sps.as_ptr(), pps.as_ptr()];
    let sizes = [sps.len(), pps.len()];
    // SAFETY: the pointer and size arrays both hold two entries describing live slices; `format`
    // is a valid out pointer.
    let status = unsafe {
        CMVideoFormatDescriptionCreateFromH264ParameterSets(
            null(),
            2,
            sets.as_ptr(),
            sizes.as_ptr(),
            4,
            &raw mut format,
        )
    };
    if status != 0 || format.is_null() {
        return None;
    }
    let format = Owned(format);

    let mut block: CMBlockBufferRef = null_mut();
    // SAFETY: a null memory block with the default allocator asks CoreMedia to allocate
    // `avcc.len()` bytes now; `block` is a valid out pointer.
    let status = unsafe {
        CMBlockBufferCreateWithMemoryBlock(
            null(),
            null_mut(),
            avcc.len(),
            null(),
            null(),
            0,
            avcc.len(),
            K_CM_BLOCK_BUFFER_ASSURE_MEMORY_NOW_FLAG,
            &raw mut block,
        )
    };
    if status != 0 || block.is_null() {
        return None;
    }
    let block_owned = Owned(block.cast_const());
    // SAFETY: `block` holds exactly `avcc.len()` bytes, and the source slice is that long.
    if unsafe { CMBlockBufferReplaceDataBytes(avcc.as_ptr().cast(), block, 0, avcc.len()) } != 0 {
        return None;
    }

    let mut sample: CMSampleBufferRef = null_mut();
    let sample_size = [avcc.len()];
    // SAFETY: `block` and `format` are live; one sample, no timing, one size entry; `sample` is a
    // valid out pointer.
    let status = unsafe {
        CMSampleBufferCreateReady(
            null(),
            block,
            format.0,
            1,
            0,
            null(),
            1,
            sample_size.as_ptr(),
            &raw mut sample,
        )
    };
    if status != 0 || sample.is_null() {
        return None;
    }
    let sample_owned = Owned(sample.cast_const());

    // Ask for 32-bit BGRA, which is simple to copy.
    let pixel_format = i32::from_be_bytes(*b"BGRA");
    // SAFETY: `pixel_format` is a live i32 matching the SInt32 number type.
    let number =
        Owned(unsafe { CFNumberCreate(null(), K_CF_NUMBER_SINT32_TYPE, (&raw const pixel_format).cast()) });
    if number.0.is_null() {
        return None;
    }
    // SAFETY: one key and one value, both valid CF objects; the callback structs are the system's.
    let attrs = Owned(unsafe {
        let keys = [kCVPixelBufferPixelFormatTypeKey];
        let values = [number.0];
        CFDictionaryCreate(
            null(),
            keys.as_ptr(),
            values.as_ptr(),
            1,
            &raw const kCFTypeDictionaryKeyCallBacks,
            &raw const kCFTypeDictionaryValueCallBacks,
        )
    });
    if attrs.0.is_null() {
        return None;
    }

    let slot: Slot = Mutex::new(None);
    let record = OutputCallbackRecord {
        callback: on_output,
        ref_con: (&raw const slot).cast_mut().cast(),
    };
    let mut session: VTDecompressionSessionRef = null_mut();
    // SAFETY: `format` and `attrs` are live; `record` and `slot` outlive the session, which is
    // invalidated below before either goes out of scope.
    let status = unsafe {
        VTDecompressionSessionCreate(
            null(),
            format.0,
            null(),
            attrs.0,
            &raw const record,
            &raw mut session,
        )
    };
    if status != 0 || session.is_null() {
        return None;
    }
    let mut info = 0_u32;
    // SAFETY: `session` and `sample` are live. Flags 0 decode synchronously; waiting afterwards
    // makes sure the callback has run before the slot is read.
    unsafe {
        VTDecompressionSessionDecodeFrame(session, sample, 0, null_mut(), &raw mut info);
        VTDecompressionSessionWaitForAsynchronousFrames(session);
        VTDecompressionSessionInvalidate(session);
        CFRelease(session.cast_const());
    }
    drop(sample_owned);
    drop(block_owned);
    slot.into_inner().ok().flatten()
}
