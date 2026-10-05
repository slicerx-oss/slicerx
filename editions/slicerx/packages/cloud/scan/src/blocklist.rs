// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Known-bad file hashes. The list itself is deployment data and stays out of
//! the repository.

use std::collections::HashMap;

/// A set of SHA-256 hashes the library refuses.
pub trait Blocklist: Send + Sync {
    /// The label of the entry when `sha256` (lowercase hex) is listed.
    fn check(&self, sha256: &str) -> Option<String>;
}

/// An in-memory blocklist, loaded from text.
#[derive(Debug, Default, Clone)]
pub struct HashBlocklist {
    entries: HashMap<String, String>,
}

impl HashBlocklist {
    /// Parses one entry per line: a SHA-256 in hex, then an optional label.
    /// Blank lines and lines starting with `#` are skipped. A malformed line
    /// is an error: a typo must not silently shrink the list.
    pub fn parse(text: &str) -> Result<Self, String> {
        let mut entries = HashMap::new();
        for (n, line) in text.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let (hash, label) = line.split_once(char::is_whitespace).unwrap_or((line, ""));
            if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(format!("blocklist line {}: not a SHA-256", n + 1));
            }
            let label = label.trim();
            entries.insert(
                hash.to_ascii_lowercase(),
                if label.is_empty() { "blocklisted" } else { label }.to_owned(),
            );
        }
        Ok(Self { entries })
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl Blocklist for HashBlocklist {
    fn check(&self, sha256: &str) -> Option<String> {
        self.entries.get(sha256).cloned()
    }
}
