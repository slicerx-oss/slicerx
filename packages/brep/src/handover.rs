// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! the hand-over between typed bodies and the table the older operations keep
//!
//! Temporary. The older operations (`cpp/sx_brep.cpp`, behind [`crate::call`]) know a body by its number in a table
//! of their own, and a [`Body`] is owned as a Rust value. Until each of those operations is made over typed bodies,
//! this is how the two meet: [`lend`] puts a typed body under a number for the older operations to read, and
//! [`adopt`] takes a body one of them made out of their table and owns it as a typed body. Between calls the older
//! table then holds nothing, and every body has one owner.
//!
//! [`ROUTED`] names the operations that still go this way. When one is made over typed bodies its name leaves the
//! list, and when the list is empty this file goes, with the three exports at the end of `cpp/sx_brep.cpp`, their
//! declarations in `cpp/sx_kernel.h` and `Solid::lend`, `take_back` and `take_over` in `src/kernel.rs`.

use crate::body::Body;
use crate::error::{Error, Result};
use crate::kernel;
use std::marker::PhantomData;

/// The older operations that still take or make a body in their own table, and so reach a typed body only through
/// [`lend`] and [`adopt`]. The list only gets shorter: `tests/typed_handover.rs` holds it to the operations
/// `cpp/sx_brep.cpp` has.
pub const ROUTED: [&str; 12] = [
    "box",
    "boolean",
    "chamfer",
    "cut",
    "cylinder",
    "extrude",
    "fillet",
    "hole",
    "load",
    "primitive",
    "push",
    "subtract",
];

/// A typed body under a number in the older operations' table, for as long as this lives. Dropping it takes the
/// number out again and deletes nothing: the body stays its owner's throughout.
#[derive(Debug)]
pub struct Lent<'b> {
    number: i64,
    body: PhantomData<&'b Body>,
}

impl Lent<'_> {
    /// The number the older operations know the body by, to put in a request where it names a body.
    #[must_use]
    pub fn number(&self) -> i64 {
        self.number
    }
}

impl Drop for Lent<'_> {
    fn drop(&mut self) {
        kernel::take_back(self.number);
    }
}

/// Puts `body` in the older operations' table until the answer is dropped. Every older operation works on a copy of
/// a body it is given, so the body is as it was afterwards; the older `free` refuses a lent number and [`adopt`]
/// finds nothing under one.
pub fn lend(body: &Body) -> Result<Lent<'_>> {
    Ok(Lent {
        number: body.solid().lend()?,
        body: PhantomData,
    })
}

/// Takes the body an older operation made out of its table and owns it as a typed body. It is read back like any
/// other body, and one that is not a solid is freed and refused. A number the table does not have, one already
/// taken, and one that is only lent are refused.
pub fn adopt(number: i64) -> Result<Body> {
    if !crate::KERNEL {
        return Err(Error::NoKernel);
    }
    Body::checked(
        "adopt",
        || Ok(()),
        || {
            kernel::take_over(number)
                .ok_or_else(|| Error::input("body", "no body an operation made is under this number"))
        },
    )
}
