// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! where a made body is kept, by number
// temporary: the engine's table of exact bodies is not on this branch yet. this holds bodies the same way, behind
// the same calls, until the loft is rebuilt on the branch that has it; then this file goes and `exact.rs` uses the
// engine's.

use crate::error::{Error, Result};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use sx_brep::Body;

/// A body in the table, with the key of each of its faces in face order (none at all for a body without keys).
pub struct Held {
    pub body: Body,
    pub keys: Vec<u64>,
}

/// The first number the table gives out.
pub const FIRST: u32 = 1 << 31;

#[allow(clippy::cast_lossless, reason = "u64::from is not const")]
static NEXT: AtomicU64 = AtomicU64::new(FIRST as u64);

thread_local! {
    static TABLE: RefCell<BTreeMap<u32, Rc<Held>>> = const { RefCell::new(BTreeMap::new()) };
}

/// Whether a body number is one this table gives out, held or not.
#[must_use]
pub fn is_handle(n: u64) -> bool {
    (u64::from(FIRST)..=u64::from(u32::MAX)).contains(&n)
}

/// Keeps a body and returns its number. Refused, and the body dropped, when `keys` is neither empty nor one per
/// face.
pub fn hold(body: Body, keys: Vec<u64>) -> Result<u32> {
    let faces = body
        .faces()
        .map_err(|e| Error::geometry("brep", e.to_string()))?
        .len();
    if !keys.is_empty() && keys.len() != faces {
        return Err(Error::invalid(
            "keys",
            "must be one for each face of the body, or none",
        ));
    }
    let n = u32::try_from(NEXT.fetch_add(1, Ordering::Relaxed))
        .map_err(|_| Error::geometry("brep", "no body numbers are left in this session"))?;
    TABLE.with(|t| t.borrow_mut().insert(n, Rc::new(Held { body, keys })));
    Ok(n)
}

/// Runs `f` on a held body, or returns none for a number that is not held.
pub fn with<R>(handle: u32, f: impl FnOnce(&Held) -> R) -> Option<R> {
    let held = TABLE.with(|t| t.borrow().get(&handle).cloned());
    held.map(|held| f(&held))
}

/// Drops a held body. False for a number that is not held.
pub fn free(handle: u32) -> bool {
    // dropped after the table is let go: freeing a body goes into the kernel
    let gone = TABLE.with(|t| t.borrow_mut().remove(&handle));
    gone.is_some()
}

/// How many bodies this thread holds.
#[must_use]
pub fn count() -> usize {
    TABLE.with(|t| t.borrow().len())
}
