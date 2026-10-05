// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Type detection from content. The file name is never consulted here.

use crate::limits::Limits;
use crate::reject::Reject;

/// What the bytes are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sniffed {
    /// Binary or ASCII STL, with the triangle count it declares or contains.
    Stl { triangles: u64 },
    /// A zip container, which may be a 3MF or an sx3mf.
    Zip,
}

/// Names a file type that is never acceptable, from its first bytes.
pub fn forbidden_magic(head: &[u8]) -> Option<&'static str> {
    const MAGICS: &[(&[u8], &str)] = &[
        (b"MZ", "a Windows executable"),
        (b"\x7fELF", "an ELF executable"),
        (b"\xfe\xed\xfa\xce", "a Mach-O executable"),
        (b"\xfe\xed\xfa\xcf", "a Mach-O executable"),
        (b"\xce\xfa\xed\xfe", "a Mach-O executable"),
        (b"\xcf\xfa\xed\xfe", "a Mach-O executable"),
        (b"\xca\xfe\xba\xbe", "a Mach-O universal binary or Java class"),
        (b"#!", "a script"),
        (
            b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1",
            "an Office or installer container",
        ),
        (b"%PDF", "a PDF"),
        (b"\x1f\x8b", "a gzip archive"),
        (b"BZh", "a bzip2 archive"),
        (b"\xfd7zXZ\x00", "an xz archive"),
        (b"7z\xbc\xaf\x27\x1c", "a 7z archive"),
        (b"Rar!\x1a\x07", "a RAR archive"),
        (b"MSCF", "a cabinet archive"),
        (b"\x28\xb5\x2f\xfd", "a zstd archive"),
        (b"<?php", "a PHP script"),
        (b"<?xml-stylesheet", "an XML stylesheet"),
    ];
    for (magic, what) in MAGICS {
        if head.starts_with(magic) {
            return Some(what);
        }
    }
    let text: Vec<u8> = head
        .iter()
        .take(256)
        .skip_while(|b| b.is_ascii_whitespace())
        .map(u8::to_ascii_lowercase)
        .collect();
    for (prefix, what) in [
        (&b"<script"[..], "a script"),
        (b"<html", "an HTML page"),
        (b"<!doctype html", "an HTML page"),
        (b"<svg", "an SVG image"),
        (b"@echo off", "a batch script"),
    ] {
        if text.starts_with(prefix) {
            return Some(what);
        }
    }
    None
}

/// Detects the type of an upload. Only STL and zip pass.
pub fn sniff(bytes: &[u8], limits: &Limits) -> Result<Sniffed, Reject> {
    if bytes.is_empty() {
        return Err(Reject::new("empty_file", "the file is empty"));
    }
    if bytes.starts_with(b"PK\x03\x04") {
        check_zip_tail(bytes)?;
        return Ok(Sniffed::Zip);
    }
    if bytes.starts_with(b"PK") {
        return Err(Reject::new(
            "zip_invalid",
            "the zip archive is empty, split or damaged",
        ));
    }
    if let Some(what) = forbidden_magic(bytes) {
        return Err(Reject::new(
            "forbidden_type",
            format!("the file is {what}; only 3MF, sx3mf and STL are accepted"),
        ));
    }
    if let Some(triangles) = binary_stl(bytes) {
        return Ok(Sniffed::Stl { triangles });
    }
    if let Some(triangles) = ascii_stl(bytes, limits)? {
        return Ok(Sniffed::Stl { triangles });
    }
    Err(Reject::new(
        "unsupported_type",
        "the file is not a 3MF, sx3mf or STL model",
    ))
}

/// A binary STL declares its triangle count and must have exactly that many
/// 50 byte records, the same rule `sx-core` applies.
fn binary_stl(bytes: &[u8]) -> Option<u64> {
    let n = u64::from(u32::from_le_bytes(bytes.get(80..84)?.try_into().ok()?));
    let len = u64::try_from(bytes.len()).ok()?;
    (84 + 50 * n == len).then_some(n)
}

const STL_KEYWORDS: &[&str] = &[
    "solid", "facet", "outer", "vertex", "endloop", "endfacet", "endsolid",
];

/// An ASCII STL is text made only of the STL keywords. Returns the triangle
/// count, from the number of vertex lines.
fn ascii_stl(bytes: &[u8], limits: &Limits) -> Result<Option<u64>, Reject> {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return Ok(None);
    };
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    if !text
        .trim_start()
        .get(..5)
        .is_some_and(|s| s.eq_ignore_ascii_case("solid"))
    {
        return Ok(None);
    }
    let mut vertices: u64 = 0;
    let mut ended = false;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.len() > 1024 || line.chars().any(|c| c.is_control() && c != '\t') {
            return Ok(None);
        }
        let first = line.split_whitespace().next().unwrap_or("");
        if !STL_KEYWORDS.iter().any(|k| first.eq_ignore_ascii_case(k)) {
            // The solid name line is free text on the same line as `solid`;
            // any other unknown line means this is not a plain STL.
            return Ok(None);
        }
        if first.eq_ignore_ascii_case("vertex") {
            vertices += 1;
            if vertices / 3 > limits.max_triangles as u64 {
                return Err(Reject::new(
                    "too_many_triangles",
                    format!("the model has more than {} triangles", limits.max_triangles),
                ));
            }
        }
        if first.eq_ignore_ascii_case("endsolid") {
            ended = true;
        }
    }
    Ok((ended && vertices >= 3).then_some(vertices / 3))
}

/// Refuses a zip with bytes after its end record. Data appended to an archive
/// is how polyglot files hide a second format.
fn check_zip_tail(bytes: &[u8]) -> Result<(), Reject> {
    const EOCD: &[u8] = b"PK\x05\x06";
    let bad = || {
        Reject::new(
            "zip_trailing_data",
            "the zip archive has extra data after its end record",
        )
    };
    let lowest = bytes.len().saturating_sub(22 + usize::from(u16::MAX));
    let mut at = bytes.len().checked_sub(22).ok_or_else(bad)?;
    loop {
        if bytes.get(at..at + 4) == Some(EOCD) {
            let comment_len = bytes
                .get(at + 20..at + 22)
                .map(|b| usize::from(u16::from_le_bytes([b[0], b[1]])))
                .ok_or_else(bad)?;
            return if at + 22 + comment_len == bytes.len() {
                Ok(())
            } else {
                Err(bad())
            };
        }
        if at == lowest {
            return Err(bad());
        }
        at -= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_by_content() {
        let l = Limits::default();
        let mut bin = vec![0u8; 80];
        bin.extend_from_slice(&1u32.to_le_bytes());
        bin.extend_from_slice(&[0u8; 50]);
        assert_eq!(sniff(&bin, &l), Ok(Sniffed::Stl { triangles: 1 }));
        // A wrong count is not a binary STL, and not text either.
        bin.push(0);
        assert!(sniff(&bin, &l).is_err());
        let ascii = b"solid a\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid a\n";
        assert_eq!(sniff(ascii, &l), Ok(Sniffed::Stl { triangles: 1 }));
        assert_eq!(sniff(b"PK\x03\x04", &l).unwrap_err().code, "zip_trailing_data");
        assert_eq!(sniff(b"PK\x05\x06", &l).unwrap_err().code, "zip_invalid");
        assert_eq!(sniff(b"", &l).unwrap_err().code, "empty_file");
    }

    #[test]
    fn a_binary_stl_that_starts_with_solid_is_still_binary() {
        let mut bin = b"solid exported by a slicer".to_vec();
        bin.resize(80, b' ');
        bin.extend_from_slice(&1u32.to_le_bytes());
        bin.extend_from_slice(&[1u8; 50]);
        assert_eq!(sniff(&bin, &Limits::default()), Ok(Sniffed::Stl { triangles: 1 }));
    }

    #[test]
    fn names_forbidden_formats() {
        assert!(forbidden_magic(b"MZ\x90").is_some());
        assert!(forbidden_magic(b"  <SCRIPT>").is_some());
        assert!(forbidden_magic(b"<?xml version=\"1.0\"?><model/>").is_none());
        assert!(forbidden_magic(b"\x89PNG\r\n\x1a\n").is_none());
    }
}
