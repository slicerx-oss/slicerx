// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! for tests: a body from the text the `save` operation writes, so one saved body can be read by the JSON
//! operations and by the typed calls
//!
//! The text is the kernel's own format, then a line of face keys when the body has them, then a line with a
//! checksum of everything before it. Face keys are not read here.

#[cfg(sx_brep_kernel)]
use crate::body::Body;
use crate::error::{Error, Result};
#[cfg(sx_brep_kernel)]
use std::ffi::CString;
#[cfg(sx_brep_kernel)]
use std::io::Write;
#[cfg(sx_brep_kernel)]
use std::sync::atomic::{AtomicU64, Ordering};

/// A body from saved text, checked as every body is.
#[cfg(sx_brep_kernel)]
pub(crate) fn body(text: &str) -> Result<Body> {
    Body::checked(
        "load",
        || saved_text(text).map(|_| ()),
        || {
            // the kernel reads its text format from a file
            let file = Scratch::write(saved_text(text)?)?;
            crate::kernel::read_text(&file.name)
        },
    )
}

/// The largest saved body read, as for the JSON `load`.
const MAX_SAVED_BYTES: usize = 8 * 1024 * 1024;
/// The line `save` ends a body with: a checksum of everything before it.
const SEAL: &str = "//sx-brep fnv1a64 ";
/// The line `save` puts the face keys on, after the kernel's own text.
const KEYS: &str = "//sx-brep keys";

/// The checksum `save` ends a body with: FNV-1a over the bytes, from the wrapper's own starting value.
fn checksum(text: &str) -> u64 {
    text.bytes().fold(1_469_598_103_934_665_603_u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(1_099_511_628_211)
    })
}

/// The kernel's own text inside what `save` wrote, once the checksum holds.
fn saved_text(sealed: &str) -> Result<&str> {
    if sealed.len() > MAX_SAVED_BYTES {
        return Err(Error::input("saved body", "exceeds 8 MiB"));
    }
    let changed = || Error::input("saved body", "not a body sx-brep saved, or changed since");
    let at = sealed.rfind(SEAL).ok_or_else(changed)?;
    let (text, seal) = sealed.split_at(at);
    if seal != format!("{SEAL}{:016x}\n", checksum(text)) {
        return Err(changed());
    }
    Ok(match text.rfind(KEYS) {
        Some(keys) if keys == 0 || text[..keys].ends_with('\n') => &text[..keys],
        _ => text,
    })
}

/// A file in the temp folder that is removed when this drops.
#[cfg(sx_brep_kernel)]
struct Scratch {
    path: std::path::PathBuf,
    name: CString,
}

#[cfg(sx_brep_kernel)]
impl Scratch {
    fn write(text: &str) -> Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let failed = |what: &str| Error::input("saved body", format!("could not {what} a scratch file"));
        // unique in this process by the counter, and between processes sharing the temp folder by the process id;
        // create_new refuses a name that is somehow taken
        let path = std::env::temp_dir().join(format!(
            "sx_brep_typed_{}_{}.smb",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let name = path
            .to_str()
            .and_then(|p| CString::new(p).ok())
            .ok_or_else(|| failed("name"))?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| failed("make"))?;
        let scratch = Self { path, name };
        file.write_all(text.as_bytes()).map_err(|_| failed("write"))?;
        Ok(scratch)
    }
}

#[cfg(sx_brep_kernel)]
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sealed(text: &str) -> String {
        format!("{text}{SEAL}{:016x}\n", checksum(text))
    }

    #[test]
    fn saved_text_needs_its_checksum_and_leaves_the_keys_out() {
        assert_eq!(saved_text(&sealed("body\n")), Ok("body\n"));
        assert_eq!(saved_text(&sealed("body\n//sx-brep keys 1 2 3\n")), Ok("body\n"));
        // the keys line counts only at the start of a line
        let inline = "body //sx-brep keys\n";
        assert_eq!(saved_text(&sealed(inline)), Ok(inline));
        let changed = Error::input("saved body", "not a body sx-brep saved, or changed since");
        assert_eq!(saved_text("body\n"), Err(changed.clone()));
        assert_eq!(
            saved_text(&sealed("body\n").replace("body", "bodY")),
            Err(changed)
        );
        assert_eq!(
            saved_text(&"x".repeat(MAX_SAVED_BYTES + 1)),
            Err(Error::input("saved body", "exceeds 8 MiB"))
        );
    }
}
