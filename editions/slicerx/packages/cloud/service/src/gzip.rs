// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Gzip mesh uploads. Clients may send a mesh gzip compressed (`Content-Encoding: gzip`); the service keeps the bytes
//! as sent, so the upload limit and the bucket limit read the same size, and inflates them with a hard limit on the
//! output wherever it needs the mesh itself.

use std::io::Read;

use flate2::read::MultiGzDecoder;

/// Why a gzip body could not be inflated.
#[derive(Debug, PartialEq, Eq)]
pub enum Inflate {
    /// The output would pass the limit: refused before it is all in memory.
    TooLarge,
    /// Not gzip, or cut off.
    Invalid,
}

/// Whether `bytes` start like a gzip stream.
pub fn is_gzip(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0x1f, 0x8b])
}

/// Inflates a gzip body, giving up as soon as the output passes `limit` bytes.
pub fn inflate(body: &[u8], limit: usize) -> Result<Vec<u8>, Inflate> {
    if !is_gzip(body) {
        return Err(Inflate::Invalid);
    }
    let cap = u64::try_from(limit).unwrap_or(u64::MAX).saturating_add(1);
    let mut out = Vec::new();
    MultiGzDecoder::new(body)
        .take(cap)
        .read_to_end(&mut out)
        .map_err(|_| Inflate::Invalid)?;
    if out.len() > limit {
        return Err(Inflate::TooLarge);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    fn gz(bytes: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(bytes).unwrap();
        e.finish().unwrap()
    }

    #[test]
    fn inflates_up_to_the_limit_and_no_further() {
        let data = vec![9u8; 1000];
        assert_eq!(inflate(&gz(&data), 1000).unwrap(), data);
        assert_eq!(inflate(&gz(&data), 999), Err(Inflate::TooLarge));
        assert_eq!(inflate(&data, 5000), Err(Inflate::Invalid));
        let cut = gz(&data);
        assert_eq!(inflate(&cut[..cut.len() / 2], 5000), Err(Inflate::Invalid));
    }
}
