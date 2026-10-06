// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Custom G-code text as the stock table compares it: `normalizeGcode` and `gcodeFingerprint` of
//! packages/settings/js/gcode-review.ts, byte for byte.

use sha2::{Digest, Sha256};

/// Line breaks as `\n`, trailing spaces and tabs off, blank lines dropped.
pub fn normalize(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .map(|l| l.trim_end_matches([' ', '\t']))
        .filter(|l| !l.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The first 128 bits of the SHA-256 of the normalized text, as lowercase hex.
pub fn fingerprint(text: &str) -> String {
    use std::fmt::Write;
    Sha256::digest(normalize(text).as_bytes())
        .iter()
        .take(16)
        .fold(String::with_capacity(32), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        })
}
