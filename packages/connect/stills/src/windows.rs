// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Windows: Media Foundation's H.264 decoder, the MFT that ships with Windows (`CMSH264DecoderMFT`),
//! which takes Annex B input and decodes Baseline, Main and High profile. One key frame in, drained,
//! one NV12 picture out, converted to RGB and cropped to the display area.
use std::mem::ManuallyDrop;

use windows::Win32::Media::MediaFoundation::{
    CLSID_MSH264DecoderMFT, IMFMediaType, IMFSample, IMFTransform, MF_E_TRANSFORM_NEED_MORE_INPUT,
    MF_E_TRANSFORM_STREAM_CHANGE, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_SIZE, MF_MT_MAJOR_TYPE,
    MF_MT_MINIMUM_DISPLAY_APERTURE, MF_MT_SUBTYPE, MF_VERSION, MFCreateMediaType, MFCreateMemoryBuffer,
    MFCreateSample, MFMediaType_Video, MFSTARTUP_LITE, MFShutdown, MFStartup, MFT_MESSAGE_COMMAND_DRAIN,
    MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, MFT_MESSAGE_NOTIFY_START_OF_STREAM, MFT_OUTPUT_DATA_BUFFER,
    MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES, MFT_OUTPUT_STREAM_PROVIDES_SAMPLES, MFVideoArea,
    MFVideoFormat_H264, MFVideoFormat_NV12,
};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
};
use windows::core::Result;

use crate::Rgb;

pub(crate) fn decode(access_unit: &[u8]) -> Option<Rgb> {
    // SAFETY: COM is set up for this thread and torn down again only when this call set it up
    // (S_OK or S_FALSE); a thread already in another apartment mode is used as it is.
    let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    // SAFETY: MFStartup and MFShutdown are reference counted; every successful start is paired.
    let mf = unsafe { MFStartup(MF_VERSION, MFSTARTUP_LITE) }.is_ok();
    let out = if mf {
        decode_with_mf(access_unit).ok().flatten()
    } else {
        None
    };
    if mf {
        // SAFETY: pairs the MFStartup above.
        let _ = unsafe { MFShutdown() };
    }
    if com.is_ok() {
        // SAFETY: pairs the CoInitializeEx above, which succeeded.
        unsafe { CoUninitialize() };
    }
    out
}

fn decode_with_mf(access_unit: &[u8]) -> Result<Option<Rgb>> {
    // SAFETY: plain COM calls on interfaces this function owns; every pointer handed over points
    // into buffers that outlive the call.
    unsafe {
        let mft: IMFTransform = CoCreateInstance(&CLSID_MSH264DecoderMFT, None, CLSCTX_INPROC_SERVER)?;
        let input: IMFMediaType = MFCreateMediaType()?;
        input.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        input.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
        mft.SetInputType(0, &input, 0)?;
        set_nv12_output(&mft)?;
        mft.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
        mft.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;

        let len = u32::try_from(access_unit.len()).unwrap_or(u32::MAX);
        let buffer = MFCreateMemoryBuffer(len)?;
        let mut ptr = std::ptr::null_mut::<u8>();
        buffer.Lock(&raw mut ptr, None, None)?;
        std::ptr::copy_nonoverlapping(access_unit.as_ptr(), ptr, access_unit.len());
        buffer.Unlock()?;
        buffer.SetCurrentLength(len)?;
        let sample = MFCreateSample()?;
        sample.AddBuffer(&buffer)?;
        sample.SetSampleTime(0)?;
        sample.SetSampleDuration(333_333)?;
        mft.ProcessInput(0, &sample, 0)?;
        mft.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0)?;

        // The first call usually reports the stream's real format (a stream change); set the
        // output again for it and ask once more.
        for _ in 0..4 {
            match output(&mft) {
                Ok(Some(sample)) => return picture(&mft, &sample),
                Ok(None) => return Ok(None),
                Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => set_nv12_output(&mft)?,
                Err(e) => return Err(e),
            }
        }
        Ok(None)
    }
}

/// Picks NV12 among the output types the decoder offers now.
fn set_nv12_output(mft: &IMFTransform) -> Result<()> {
    // SAFETY: COM calls on an interface the caller owns.
    unsafe {
        let mut i = 0;
        loop {
            let t = mft.GetOutputAvailableType(0, i)?;
            if t.GetGUID(&MF_MT_SUBTYPE)? == MFVideoFormat_NV12 {
                return mft.SetOutputType(0, &t, 0);
            }
            i += 1;
        }
    }
}

/// One decoded sample, or `None` when the decoder has nothing more.
fn output(mft: &IMFTransform) -> Result<Option<IMFSample>> {
    // SAFETY: the output buffer struct is filled by the decoder; the sample and event collection
    // it holds are taken out of their ManuallyDrop wrappers exactly once.
    unsafe {
        let info = mft.GetOutputStreamInfo(0)?;
        let provide_flags = MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0;
        let provides = info.dwFlags & u32::try_from(provide_flags).unwrap_or(0) != 0;
        let ours = if provides {
            None
        } else {
            let s = MFCreateSample()?;
            s.AddBuffer(&MFCreateMemoryBuffer(info.cbSize.max(1))?)?;
            Some(s)
        };
        let mut buf = [MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: 0,
            pSample: ManuallyDrop::new(ours),
            dwStatus: 0,
            pEvents: ManuallyDrop::new(None),
        }];
        let mut status = 0_u32;
        let got = mft.ProcessOutput(0, &mut buf, &raw mut status);
        let [b] = &mut buf;
        let sample = ManuallyDrop::take(&mut b.pSample);
        drop(ManuallyDrop::take(&mut b.pEvents));
        match got {
            Ok(()) => Ok(sample),
            Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => Ok(None),
            Err(e) => Err(e),
        }
    }
}

/// The decoded NV12 sample as RGB, cropped to the display area (1080 of the 1088 coded lines).
fn picture(mft: &IMFTransform, sample: &IMFSample) -> Result<Option<Rgb>> {
    // SAFETY: the aperture blob is written into a struct of its own size, and the buffer is locked
    // while it is read, every read bounds checked against the length the lock reports.
    unsafe {
        let t = mft.GetOutputCurrentType(0)?;
        let size = t.GetUINT64(&MF_MT_FRAME_SIZE)?;
        let coded_w = usize::try_from(size >> 32).unwrap_or(0);
        let coded_h = usize::try_from(size & 0xffff_ffff).unwrap_or(0);
        let stride = t
            .GetUINT32(&MF_MT_DEFAULT_STRIDE)
            .ok()
            .and_then(|s| usize::try_from(s.cast_signed().unsigned_abs()).ok())
            .filter(|s| *s >= coded_w)
            .unwrap_or(coded_w);
        let mut area = MFVideoArea::default();
        let (mut x0, mut y0, mut w, mut h) = (0, 0, coded_w, coded_h);
        let area_bytes =
            std::slice::from_raw_parts_mut((&raw mut area).cast::<u8>(), size_of::<MFVideoArea>());
        if t.GetBlob(&MF_MT_MINIMUM_DISPLAY_APERTURE, area_bytes, None)
            .is_ok()
        {
            x0 = usize::try_from(area.OffsetX.value).unwrap_or(0);
            y0 = usize::try_from(area.OffsetY.value).unwrap_or(0);
            w = usize::try_from(area.Area.cx)
                .unwrap_or(0)
                .min(coded_w.saturating_sub(x0));
            h = usize::try_from(area.Area.cy)
                .unwrap_or(0)
                .min(coded_h.saturating_sub(y0));
        }
        let buffer = sample.ConvertToContiguousBuffer()?;
        let mut ptr = std::ptr::null_mut::<u8>();
        let mut len = 0_u32;
        buffer.Lock(&raw mut ptr, None, Some(&raw mut len))?;
        let data = std::slice::from_raw_parts(ptr, usize::try_from(len).unwrap_or(0));
        let rgb = crate::nv12_to_rgb(data, stride, coded_h, (x0, y0, w, h));
        buffer.Unlock()?;
        Ok(rgb)
    }
}
