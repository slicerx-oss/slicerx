// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! One still from an H.264 camera (Bambu Lab X1 and H2 send only RTSP video): decode a key frame
//! with the operating system's decoder through `sx-stills` and encode it as JPEG. On Linux the
//! decoder is Cisco's prebuilt `OpenH264`, downloaded into the state directory the first time a still
//! is needed and checked against its pinned SHA-256. Runs only when a still is asked for.
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Widest still handed out; larger frames are halved until they fit.
const MAX_WIDTH: usize = 1280;
const QUALITY: u8 = 80;
/// Cisco's files are about 1 MB; give up on a slow link rather than hold a still request.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_mins(1);

/// Where the downloaded codec lives: `<state dir>/codecs`.
pub(crate) fn codec_dir(state_dir: Option<&Path>) -> Option<PathBuf> {
    state_dir.map(|d| d.join("codecs"))
}

/// Makes sure Cisco's library is in `dir` on systems that use it (not macOS, not Windows). Returns
/// false when it is not there and could not be fetched.
pub(crate) async fn ensure_codec(dir: Option<&Path>) -> bool {
    if cfg!(any(target_os = "macos", windows)) {
        return true;
    }
    let (Some(dir), Some(lib)) = (dir, sx_stills::cisco_library()) else {
        return false;
    };
    if dir.join(lib.file_name).exists() {
        return true;
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let Ok(client) = reqwest::Client::builder().timeout(DOWNLOAD_TIMEOUT).build() else {
        return false;
    };
    let bytes = match client.get(lib.url).send().await {
        Ok(r) if r.status().is_success() => match r.bytes().await {
            Ok(b) => b,
            Err(_) => return false,
        },
        _ => {
            eprintln!("sx-link: cannot download OpenH264 from Cisco ({})", lib.url);
            return false;
        }
    };
    let dir = dir.to_owned();
    let installed = tokio::task::spawn_blocking(move || sx_stills::install_cisco_library(&dir, &bytes)).await;
    match installed {
        Ok(Ok(_)) => true,
        Ok(Err(e)) => {
            eprintln!("sx-link: OpenH264 from Cisco was not installed: {e}");
            false
        }
        Err(_) => false,
    }
}

/// Decodes one key frame access unit (Annex B with SPS and PPS) and returns it as JPEG.
pub(crate) fn still_from_key_frame(access_unit: &[u8], codecs: Option<&Path>) -> Option<Vec<u8>> {
    still_from_key_frame_fit(access_unit, codecs, MAX_WIDTH, QUALITY)
}

/// The same, halved until it is at most `max_width` pixels wide, at JPEG `quality`.
pub(crate) fn still_from_key_frame_fit(
    access_unit: &[u8],
    codecs: Option<&Path>,
    max_width: usize,
    quality: u8,
) -> Option<Vec<u8>> {
    let pic = sx_stills::decode_h264_key_frame(access_unit, codecs)?;
    fit_rgb(pic.data, pic.width, pic.height, max_width, quality)
}

/// Halves an RGB picture until it is at most `max_width` wide, then encodes it as JPEG.
pub(crate) fn fit_rgb(
    rgb: Vec<u8>,
    width: usize,
    height: usize,
    max_width: usize,
    quality: u8,
) -> Option<Vec<u8>> {
    let (mut rgb, mut w, mut h) = (rgb, width, height);
    while w > max_width.max(1) {
        (rgb, w, h) = halve(&rgb, w, h);
    }
    crate::jpeg::encode_rgb(&rgb, w, h, quality)
}

/// A JPEG at most `max_width` wide: passed through when it already is, else decoded, halved and
/// encoded again. Pictures over 8192 pixels on a side are refused before decoding.
/// Largest picture `fit_jpeg` decodes: 16 megapixels.
const MAX_PIXELS: usize = 16_000_000;

pub(crate) fn fit_jpeg(data: &[u8], max_width: usize, quality: u8) -> Option<Vec<u8>> {
    use zune_jpeg::zune_core::bytestream::ZCursor;
    use zune_jpeg::zune_core::colorspace::ColorSpace;
    use zune_jpeg::zune_core::options::DecoderOptions;
    let options = DecoderOptions::default()
        .jpeg_set_out_colorspace(ColorSpace::RGB)
        .set_max_width(8192)
        .set_max_height(8192);
    let mut dec = zune_jpeg::JpegDecoder::new_with_options(ZCursor::new(data), options);
    dec.decode_headers().ok()?;
    let info = dec.info()?;
    if usize::from(info.width) <= max_width {
        return Some(data.to_vec());
    }
    // A camera picture is never this large; decoding one would take hundreds of megabytes.
    if usize::from(info.width) * usize::from(info.height) > MAX_PIXELS {
        return None;
    }
    let rgb = dec.decode().ok()?;
    let (w, h) = (usize::from(info.width), usize::from(info.height));
    if rgb.len() != w * h * 3 {
        return None;
    }
    fit_rgb(rgb, w, h, max_width, quality)
}

/// Averages each 2x2 block. Reads are clamped to the image, writes stay inside `out`.
#[allow(clippy::indexing_slicing)]
fn halve(rgb: &[u8], w: usize, h: usize) -> (Vec<u8>, usize, usize) {
    let (nw, nh) = ((w / 2).max(1), (h / 2).max(1));
    let mut out = vec![0_u8; nw * nh * 3];
    for y in 0..nh {
        for x in 0..nw {
            for c in 0..3 {
                let at = |xx: usize, yy: usize| u32::from(rgb[(yy.min(h - 1) * w + xx.min(w - 1)) * 3 + c]);
                let sum =
                    at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1);
                out[(y * nw + x) * 3 + c] = u8::try_from(sum / 4).unwrap_or(255);
            }
        }
    }
    (out, nw, nh)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn halving_keeps_the_picture_shape() {
        let rgb = vec![200_u8; 9 * 5 * 3];
        let (out, w, h) = halve(&rgb, 9, 5);
        assert_eq!((w, h, out.len()), (4, 2, 4 * 2 * 3));
        assert!(out.iter().all(|&v| v == 200));
    }

    #[test]
    fn garbage_gives_no_still() {
        assert!(still_from_key_frame(&[0, 0, 0, 1, 0x65, 1, 2, 3], None).is_none());
    }
}
