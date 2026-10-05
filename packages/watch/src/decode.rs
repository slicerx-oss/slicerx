// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Frames to pixels: JPEG (most cameras), PNG and WebP. Anything else is reported as
//! unsupported and skipped, never guessed at.

/// An 8-bit RGB picture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rgb {
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// Row-major RGB triples.
    pub data: Vec<u8>,
}

impl Rgb {
    /// Luma per pixel (ITU-R BT.601 weights), row-major.
    pub fn gray(&self) -> Vec<u8> {
        self.data
            .as_chunks::<3>()
            .0
            .iter()
            .map(|&[r, g, b]| {
                let (r, g, b) = (u32::from(r), u32::from(g), u32::from(b));
                // The weights sum to 1000, so the result stays within a byte.
                u8::try_from((299 * r + 587 * g + 114 * b) / 1000).unwrap_or(u8::MAX)
            })
            .collect()
    }
}

/// Why a frame could not be decoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    /// A format with no decoder here yet.
    Unsupported(String),
    /// The bytes are not a valid picture.
    Corrupt,
}

/// Decodes a frame by its content type.
pub fn decode(content_type: &str, bytes: &[u8]) -> Result<Rgb, DecodeError> {
    match content_type {
        "image/png" => decode_png(bytes),
        "image/jpeg" | "image/jpg" => decode_jpeg(bytes),
        "image/webp" => decode_webp(bytes),
        other => Err(DecodeError::Unsupported(other.to_owned())),
    }
}

/// Decodes by the file's leading bytes, for stills read from disk.
pub fn decode_sniffed(bytes: &[u8]) -> Result<Rgb, DecodeError> {
    let kind = if bytes.starts_with(&[0xFF, 0xD8]) {
        "image/jpeg"
    } else if bytes.starts_with(b"\x89PNG") {
        "image/png"
    } else if bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        return Err(DecodeError::Unsupported("unknown".to_owned()));
    };
    decode(kind, bytes)
}

fn decode_jpeg(bytes: &[u8]) -> Result<Rgb, DecodeError> {
    use zune_jpeg::zune_core::bytestream::ZCursor;
    use zune_jpeg::zune_core::colorspace::ColorSpace;
    use zune_jpeg::zune_core::options::DecoderOptions;
    let options = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::RGB);
    let mut dec = zune_jpeg::JpegDecoder::new_with_options(ZCursor::new(bytes), options);
    let data = dec.decode().map_err(|_| DecodeError::Corrupt)?;
    let info = dec.info().ok_or(DecodeError::Corrupt)?;
    let (width, height) = (u32::from(info.width), u32::from(info.height));
    if data.len() != width as usize * height as usize * 3 {
        return Err(DecodeError::Corrupt);
    }
    Ok(Rgb { width, height, data })
}

fn decode_webp(bytes: &[u8]) -> Result<Rgb, DecodeError> {
    let mut dec =
        image_webp::WebPDecoder::new(std::io::Cursor::new(bytes)).map_err(|_| DecodeError::Corrupt)?;
    let (width, height) = dec.dimensions();
    let mut buf = vec![0; dec.output_buffer_size().ok_or(DecodeError::Corrupt)?];
    dec.read_image(&mut buf).map_err(|_| DecodeError::Corrupt)?;
    let data = if dec.has_alpha() {
        buf.as_chunks::<4>()
            .0
            .iter()
            .flat_map(|&[r, g, b, _]| [r, g, b])
            .collect()
    } else {
        buf
    };
    Ok(Rgb { width, height, data })
}

fn decode_png(bytes: &[u8]) -> Result<Rgb, DecodeError> {
    let mut dec = png::Decoder::new(std::io::Cursor::new(bytes));
    dec.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = dec.read_info().map_err(|_| DecodeError::Corrupt)?;
    let mut buf = vec![0; reader.output_buffer_size().ok_or(DecodeError::Corrupt)?];
    let info = reader.next_frame(&mut buf).map_err(|_| DecodeError::Corrupt)?;
    let raw = buf.get(..info.buffer_size()).ok_or(DecodeError::Corrupt)?;
    let data: Vec<u8> = match info.color_type {
        png::ColorType::Rgb => raw.to_vec(),
        png::ColorType::Rgba => raw
            .as_chunks::<4>()
            .0
            .iter()
            .flat_map(|&[r, g, b, _]| [r, g, b])
            .collect(),
        png::ColorType::Grayscale => raw.iter().flat_map(|&g| [g, g, g]).collect(),
        png::ColorType::GrayscaleAlpha => raw
            .as_chunks::<2>()
            .0
            .iter()
            .flat_map(|&[l, _]| [l, l, l])
            .collect(),
        png::ColorType::Indexed => return Err(DecodeError::Corrupt),
    };
    Ok(Rgb {
        width: info.width,
        height: info.height,
        data,
    })
}
