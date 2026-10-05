// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors

/// Why a file was refused. `code` is stable and machine readable, `message`
/// is safe to show to the uploader and never carries file contents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reject {
    pub code: &'static str,
    pub message: String,
}

impl Reject {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for Reject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for Reject {}

/// Entry names can be hostile: show them with control characters replaced and
/// cut short.
pub(crate) fn printable(s: &str) -> String {
    let mut out: String = s
        .chars()
        .take(80)
        .map(|c| if c.is_control() { '?' } else { c })
        .collect();
    if s.chars().count() > 80 {
        out.push_str("...");
    }
    out
}
