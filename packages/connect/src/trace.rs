// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! An opt-in connection log for field reports: with `SX_CONNECT_LOG` set to a file path, connectors
//! append one line per connection event (opened, signed in, dropped and why). Off by default, and
//! never given secrets: callers log ids, addresses and error text only.
use std::io::Write;
use std::sync::{Mutex, OnceLock, PoisonError};

static FILE: OnceLock<Option<Mutex<std::fs::File>>> = OnceLock::new();

/// A secret as the log may show it: its length and the first 4 hex digits of its SHA-256, enough
/// to tell two codes apart and nothing to recover one from.
pub(crate) fn fingerprint(secret: &str) -> String {
    use sha2::{Digest, Sha256};
    let h = Sha256::digest(secret.as_bytes());
    format!(
        "length {}, sha256 {:02x}{:02x}",
        secret.chars().count(),
        h.first().copied().unwrap_or(0),
        h.get(1).copied().unwrap_or(0)
    )
}

/// Appends `line` under the printer `id` when the log is on.
pub fn trace(id: &str, line: impl std::fmt::Display) {
    let file = FILE.get_or_init(|| {
        let path = std::env::var_os("SX_CONNECT_LOG")?;
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .ok()
            .map(Mutex::new)
    });
    let Some(f) = file else { return };
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let mut f = f.lock().unwrap_or_else(PoisonError::into_inner);
    let _ = writeln!(f, "{ms} {id} {line}");
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_fingerprint_shows_length_and_four_hex_digits_only() {
        // SHA-256("12345678") starts ef797c81.
        assert_eq!(super::fingerprint("12345678"), "length 8, sha256 ef79");
        assert_ne!(super::fingerprint("12345679"), super::fingerprint("12345678"));
    }
}
