// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! One still picture from an H.264 key frame, through the decoder the operating system already
//! licenses: `VideoToolbox` on macOS, Media Foundation on Windows, and on Linux
//! Cisco's prebuilt `OpenH264`, downloaded at first use and checked against a pinned SHA-256 before
//! and after it is unpacked, as Firefox does. Nothing here decodes video continuously: one key frame
//! in, one picture out.
//!
//! This is the only crate in the workspace that may use `unsafe` (the OS decoders are C APIs). Each
//! unsafe block says why it is sound; the functions below are safe to call.

mod cisco;
#[cfg(target_os = "macos")]
mod macos;
// Only the macOS decoder splits an access unit into NAL units itself.
#[cfg(any(target_os = "macos", test))]
mod nal;
#[cfg(windows)]
mod windows;

use std::path::Path;

pub use cisco::{CiscoLibrary, InstallError, cisco_library, install_cisco_library};

/// A decoded picture: 8-bit RGB, rows top to bottom, no padding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rgb {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

/// Decodes one H.264 access unit (Annex B, a key frame carrying its SPS and PPS) to RGB.
///
/// macOS uses `VideoToolbox` and Windows Media Foundation. Elsewhere it uses Cisco's `OpenH264`
/// from `cisco_dir` (see [`install_cisco_library`]); without it the answer is `None`.
pub fn decode_h264_key_frame(access_unit: &[u8], cisco_dir: Option<&Path>) -> Option<Rgb> {
    #[cfg(target_os = "macos")]
    if let Some(rgb) = macos::decode(access_unit) {
        return Some(rgb);
    }
    #[cfg(windows)]
    #[allow(
        clippy::needless_return,
        reason = "the last statement only on Windows; other targets go on below"
    )]
    {
        let _ = cisco_dir;
        return windows::decode(access_unit);
    }
    #[cfg(not(windows))]
    {
        let lib = cisco_library()?;
        let path = cisco_dir?.join(lib.file_name);
        cisco::decode(&path, access_unit)
    }
}

/// An NV12 picture (a Y plane of `rows` lines of `stride` bytes, then interleaved U and V at half
/// resolution) to RGB, cropped to `(x, y, width, height)`. BT.601 limited range, what camera H.264
/// streams carry. `None` when the data is shorter than the layout says.
#[cfg_attr(
    not(windows),
    allow(dead_code, reason = "only the Windows decoder hands out NV12")
)]
pub(crate) fn nv12_to_rgb(
    data: &[u8],
    stride: usize,
    rows: usize,
    (x0, y0, width, height): (usize, usize, usize, usize),
) -> Option<Rgb> {
    let chroma = stride.checked_mul(rows)?;
    if width == 0 || height == 0 || data.len() < chroma.checked_add(stride * rows.div_ceil(2))? {
        return None;
    }
    let clamp = |v: i32| u8::try_from(v.clamp(0, 255)).unwrap_or(0);
    let mut out = Vec::with_capacity(width * height * 3);
    for y in y0..y0 + height {
        for x in x0..x0 + width {
            let c = i32::from(*data.get(y * stride + x)?) - 16;
            let uv = chroma + (y / 2) * stride + (x / 2) * 2;
            let d = i32::from(*data.get(uv)?) - 128;
            let e = i32::from(*data.get(uv + 1)?) - 128;
            out.push(clamp((298 * c + 409 * e + 128) >> 8));
            out.push(clamp((298 * c - 100 * d - 208 * e + 128) >> 8));
            out.push(clamp((298 * c + 516 * d + 128) >> 8));
        }
    }
    Some(Rgb {
        width,
        height,
        data: out,
    })
}

#[cfg(test)]
mod tests {
    use openh264::encoder::Encoder;
    use openh264::formats::{RgbSliceU8, YUVBuffer};

    use super::*;

    /// A test pattern encoded as one H.264 key frame (Annex B with SPS and PPS).
    pub(crate) fn key_frame(width: usize, height: usize) -> (Vec<u8>, Vec<u8>) {
        let mut rgb = vec![0_u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let i = (y * width + x) * 3;
                rgb[i] = u8::try_from(x % 256).unwrap();
                rgb[i + 1] = u8::try_from(y % 256).unwrap();
                rgb[i + 2] = 90;
            }
        }
        let yuv = YUVBuffer::from_rgb8_source(RgbSliceU8::new(&rgb, (width, height)));
        let au = Encoder::new().unwrap().encode(&yuv).unwrap().to_vec();
        (au, rgb)
    }

    fn close(a: &[u8], b: &[u8]) -> bool {
        a.iter().zip(b).all(|(x, y)| x.abs_diff(*y) <= 12)
    }

    // VideoToolbox on macOS, Media Foundation on Windows.
    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn the_system_decoder_decodes_a_key_frame() {
        let (au, rgb) = key_frame(320, 176);
        let pic = decode_h264_key_frame(&au, None).expect("the system decoder gave a picture");
        assert_eq!((pic.width, pic.height), (320, 176));
        for (x, y) in [(10, 10), (300, 150), (160, 88)] {
            let i = (y * 320 + x) * 3;
            assert!(
                close(&pic.data[i..i + 3], &rgb[i..i + 3]),
                "pixel {x},{y}: {:?} vs {:?}",
                &pic.data[i..i + 3],
                &rgb[i..i + 3]
            );
        }
        assert!(
            decode_h264_key_frame(&[0, 0, 0, 1, 0x65, 1, 2, 3], None).is_none(),
            "no SPS, no picture"
        );
        assert!(decode_h264_key_frame(&[], None).is_none());
    }

    #[test]
    fn nv12_converts_and_crops() {
        // 4x4 coded, stride 6, two padding bytes a row: white, black, then limited-range red.
        let stride = 6;
        let mut nv12 = vec![0_u8; stride * 4 + stride * 2];
        for (y, row) in [235_u8, 16, 82, 82].into_iter().enumerate() {
            nv12[y * stride..y * stride + 4].fill(row);
        }
        // Chroma: the top two rows neutral, the bottom two red (U 90, V 240).
        nv12[stride * 4..stride * 4 + 4].copy_from_slice(&[128, 128, 128, 128]);
        nv12[stride * 5..stride * 5 + 4].copy_from_slice(&[90, 240, 90, 240]);
        let pic = nv12_to_rgb(&nv12, stride, 4, (0, 0, 4, 4)).unwrap();
        assert_eq!((pic.width, pic.height), (4, 4));
        assert_eq!(&pic.data[..3], &[255, 255, 255]);
        assert_eq!(&pic.data[4 * 3..4 * 3 + 3], &[0, 0, 0]);
        let red = &pic.data[2 * 4 * 3..2 * 4 * 3 + 3];
        assert!(red[0] > 240 && red[1] < 10 && red[2] < 10, "{red:?}");
        // A crop to the display area, and data shorter than the layout.
        let crop = nv12_to_rgb(&nv12, stride, 4, (0, 2, 4, 2)).unwrap();
        assert_eq!(&crop.data[..3], red);
        assert!(nv12_to_rgb(&nv12[..20], stride, 4, (0, 0, 4, 4)).is_none());
    }

    /// A 1080p High profile key frame (avc1.641029, as the Bambu Lab H2D sends, CABAC and 8x8
    /// transforms), coded 1920x1088 with a 1080 line display area: the decoder must take it from
    /// Annex B with its SPS and PPS in front, and give the picture ffmpeg gives.
    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn a_1080p_high_profile_key_frame_decodes() {
        let au = include_bytes!("../fixtures/high-1080p-idr.h264");
        let pic = decode_h264_key_frame(au, None).expect("the system decoder gave a picture");
        assert_eq!((pic.width, pic.height), (1920, 1080));
        // 16x16 block averages from ffmpeg's own decode of the same frame, which reads a stream
        // without colorimetry as BT.601. VideoToolbox reads HD as BT.709, which moves saturated
        // colors by up to about 40 levels (pure green 216 for 255); the colors stay recognizable.
        for ((x0, y0), want) in [
            ((100, 100), [254, 0, 0]),
            ((500, 300), [0, 255, 1]),
            ((960, 540), [0, 0, 254]),
            ((1500, 800), [169, 82, 209]),
            ((1800, 1000), [0, 255, 255]),
        ] {
            let mut sum = [0_u32; 3];
            for y in y0..y0 + 16 {
                for x in x0..x0 + 16 {
                    for (c, s) in sum.iter_mut().enumerate() {
                        *s += u32::from(pic.data[(y * 1920 + x) * 3 + c]);
                    }
                }
            }
            let got = sum.map(|s| s / 256);
            assert!(
                got.iter().zip(want).all(|(g, w)| g.abs_diff(w) <= 48),
                "block at {x0},{y0}: {got:?}, ffmpeg {want:?}"
            );
        }
    }

    /// Downloads Cisco's build for this machine and decodes with it. Needs the network, so it runs
    /// only when asked: `cargo test -p sx-stills -- --ignored`.
    #[cfg(not(windows))]
    #[test]
    #[ignore = "downloads Cisco's OpenH264"]
    fn ciscos_library_installs_and_decodes() {
        let lib = cisco_library().expect("a Cisco build for this system");
        let packed = std::process::Command::new("curl")
            .args(["-sSfL", lib.url])
            .output()
            .unwrap()
            .stdout;
        let dir = std::env::temp_dir().join(format!("sx-cisco-{}", std::process::id()));
        let path = install_cisco_library(&dir, &packed).unwrap();
        assert!(path.exists());
        let (au, rgb) = key_frame(320, 176);
        let pic = cisco::decode(&path, &au).expect("Cisco's library gave a picture");
        assert_eq!((pic.width, pic.height), (320, 176));
        let i = (150 * 320 + 300) * 3;
        assert!(close(&pic.data[i..i + 3], &rgb[i..i + 3]));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
