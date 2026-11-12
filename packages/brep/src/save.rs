// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! a body as text, written the way the `save` operation writes it, so `load` and every operation that takes a
//! body as text reads it
//!
//! The text is the kernel's own format, then a line of face keys when the body has them, then a line with a
//! checksum of everything before it.

use crate::body::Body;
use crate::error::{Error, Result};

/// The line a saved body ends with: a checksum of everything before it.
pub(crate) const SEAL: &str = "//sx-brep fnv1a64 ";
/// The line the face keys are on, after the kernel's own text. The kernel's text has no place for them.
pub(crate) const KEYS: &str = "//sx-brep keys";

/// The checksum a saved body ends with: FNV-1a over the bytes, from the wrapper's own starting value.
pub(crate) fn checksum(text: &str) -> u64 {
    text.bytes().fold(1_469_598_103_934_665_603_u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(1_099_511_628_211)
    })
}

/// The kernel's text with the keys line, when any face has a key, and the checksum line.
fn sealed(mut text: String, keys: &[u64]) -> String {
    if keys.iter().any(|&k| k != 0) {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(KEYS);
        for key in keys {
            text.push(' ');
            text.push_str(&key.to_string());
        }
        text.push('\n');
    }
    let seal = format!("{SEAL}{:016x}\n", checksum(&text));
    text + &seal
}

impl Body {
    /// The body as text that `load` reads back, with `keys` as its faces' keys: one for each face in face order (0
    /// for a face without), or none at all.
    pub fn saved(&self, keys: &[u64]) -> Result<String> {
        if !keys.is_empty() && keys.len() != self.faces()?.len() {
            return Err(Error::input(
                "keys",
                "must be one for each face of the body, or none",
            ));
        }
        Ok(sealed(self.solid().text()?, keys))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_keys_line_is_there_only_when_a_face_has_a_key() {
        let seal = |text: &str| format!("{SEAL}{:016x}\n", checksum(text));
        assert_eq!(sealed("body\n".into(), &[]), format!("body\n{}", seal("body\n")));
        assert_eq!(
            sealed("body\n".into(), &[0, 0]),
            format!("body\n{}", seal("body\n"))
        );
        let keyed = "body\n//sx-brep keys 7 0 9\n";
        assert_eq!(
            sealed("body\n".into(), &[7, 0, 9]),
            format!("{keyed}{}", seal(keyed))
        );
        // a text that does not end its last line gets the keys on a line of their own
        assert_eq!(
            sealed("body".into(), &[7, 0, 9]),
            format!("{keyed}{}", seal(keyed))
        );
    }
}
