// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! a body as text, written the way the `save` operation writes it, so `load` and every operation that takes a
//! body as text reads it
//!
//! The text is the kernel's own format, then a line of face keys when the body has them, then a line of the keys
//! of the faces they came from when some face has one, then a line with a checksum of everything before it.

use crate::body::Body;
use crate::error::{Error, Result};

/// The line a saved body ends with: a checksum of everything before it.
pub(crate) const SEAL: &str = "//sx-brep fnv1a64 ";
/// The line the face keys are on, after the kernel's own text. The kernel's text has no place for them.
pub(crate) const KEYS: &str = "//sx-brep keys";
/// The line after the keys line with the key of the face each face came from, when a join cleared its own. A reader
/// that knows only the keys line drops this one with it.
pub(crate) const FROM: &str = "//sx-brep from";

/// The checksum a saved body ends with: FNV-1a over the bytes, from the wrapper's own starting value.
pub(crate) fn checksum(text: &str) -> u64 {
    text.bytes().fold(1_469_598_103_934_665_603_u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(1_099_511_628_211)
    })
}

/// The kernel's text with the keys line, when any face has a key or came from one, the from line when some face
/// came from one, and the checksum line.
fn sealed(mut text: String, keys: &[u64], from: &[u64]) -> String {
    let came = from.iter().any(|&k| k != 0);
    let line = |text: &mut String, tag: &str, values: &[u64], n: usize| {
        text.push_str(tag);
        for i in 0..n {
            text.push(' ');
            text.push_str(&values.get(i).copied().unwrap_or(0).to_string());
        }
        text.push('\n');
    };
    if came || keys.iter().any(|&k| k != 0) {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        let n = keys.len().max(from.len());
        line(&mut text, KEYS, keys, n);
        if came {
            line(&mut text, FROM, from, n);
        }
    }
    let seal = format!("{SEAL}{:016x}\n", checksum(&text));
    text + &seal
}

impl Body {
    /// The body as text that `load` reads back, with `keys` as its faces' keys: one for each face in face order (0
    /// for a face without), or none at all.
    pub fn saved(&self, keys: &[u64]) -> Result<String> {
        self.saved_with_from(keys, &[])
    }

    /// The body as text as [`Body::saved`] writes it, with `from` as the key of the face each face came from (0 for
    /// none, or none at all) on a line of its own.
    pub fn saved_with_from(&self, keys: &[u64], from: &[u64]) -> Result<String> {
        let faces = self.faces()?.len();
        if !keys.is_empty() && keys.len() != faces {
            return Err(Error::input(
                "keys",
                "must be one for each face of the body, or none",
            ));
        }
        if !from.is_empty() && from.len() != faces {
            return Err(Error::input(
                "from",
                "must be one for each face of the body, or none",
            ));
        }
        Ok(sealed(self.solid().text()?, keys, from))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_keys_line_is_there_only_when_a_face_has_a_key() {
        let seal = |text: &str| format!("{SEAL}{:016x}\n", checksum(text));
        assert_eq!(
            sealed("body\n".into(), &[], &[]),
            format!("body\n{}", seal("body\n"))
        );
        assert_eq!(
            sealed("body\n".into(), &[0, 0], &[]),
            format!("body\n{}", seal("body\n"))
        );
        let keyed = "body\n//sx-brep keys 7 0 9\n";
        assert_eq!(
            sealed("body\n".into(), &[7, 0, 9], &[]),
            format!("{keyed}{}", seal(keyed))
        );
        // a text that does not end its last line gets the keys on a line of their own
        assert_eq!(
            sealed("body".into(), &[7, 0, 9], &[]),
            format!("{keyed}{}", seal(keyed))
        );
    }

    #[test]
    fn the_from_line_follows_the_keys_line_only_when_a_face_came_from_one() {
        let seal = |text: &str| format!("{SEAL}{:016x}\n", checksum(text));
        let keyed = "body\n//sx-brep keys 7 0 9\n";
        assert_eq!(
            sealed("body\n".into(), &[7, 0, 9], &[0, 0, 0]),
            format!("{keyed}{}", seal(keyed))
        );
        let came = "body\n//sx-brep keys 7 0 9\n//sx-brep from 0 5 0\n";
        assert_eq!(
            sealed("body\n".into(), &[7, 0, 9], &[0, 5, 0]),
            format!("{came}{}", seal(came))
        );
        // every key cleared: the keys line is still there, so the from line always follows one
        let cleared = "body\n//sx-brep keys 0 0\n//sx-brep from 5 6\n";
        assert_eq!(
            sealed("body\n".into(), &[], &[5, 6]),
            format!("{cleared}{}", seal(cleared))
        );
    }
}
