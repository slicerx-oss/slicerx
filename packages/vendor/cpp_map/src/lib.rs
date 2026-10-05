// SPDX-License-Identifier: MIT OR Apache-2.0

// Copyright 2021, 2025 Eadf (github.com/eadf)
// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

//! A simple C++ `std::map` emulator for Rust.
//!
//! This crate provides a data structure that emulates C++'s `std::map`, particularly its pointer-based cursors/iterators.
//!
//! Key features replicated from C++:
//! - `std::map::insert(key, value)` is a no-op if the key already exists (the new value isn't even used)
//!
//! Two implementations are provided:
//! - **Skip list**: O(log n) search and insert, O(1) sequential access
//! - **Linked list**: O(n) search and insert, O(1) sequential access
//!
//! Note: For mostly position/hint-based operations, the linked list implementation will be faster.

#![deny(
    rust_2018_compatibility,
    rust_2018_idioms,
    nonstandard_style,
    unused,
    future_incompatible,
    non_camel_case_types,
    unused_parens,
    non_upper_case_globals,
    unused_qualifications,
    unused_results,
    unused_imports,
    unused_variables,
    bare_trait_objects,
    ellipsis_inclusive_range_patterns,
    elided_lifetimes_in_paths
)]

/// The Error type of the library
#[derive(thiserror::Error, Debug)]
pub enum CppMapError {
    #[error("error: Some error with the index map")]
    InvalidIndex,
    #[error("error: Some error with the index map")]
    IndexError(String),
    #[error("error: a key was missing rank")]
    MissingRank,
    #[error("error: rank collision")]
    KeyError(String),
}

pub trait IsLessThan {
    fn is_less_than(&self, other: &Self) -> bool;
}

macro_rules! impl_is_less_than {
    ($($t:ty),*) => {
        $(
            impl IsLessThan for $t {
                fn is_less_than(&self, other: &Self) -> bool {
                    self < other
                }
            }
        )*
    };
}

// Implement for all the basic types you want
impl_is_less_than!(i8, i16, i32, i64, i128, isize);
impl_is_less_than!(u8, u16, u32, u64, u128, usize);
impl_is_less_than!(f32, f64);
impl_is_less_than!(char);
impl_is_less_than!(&str);
impl_is_less_than!(String);

#[doc(hidden)]
// a debug_assert!() that actually ignores the input parameters when not active
#[cfg(any(test, debug_assertions))]
#[macro_export]
macro_rules! dbg_assert {
    ($($arg:tt)*) => {
        assert!($($arg)*);
    };
}

// a debug_assert!() that actually ignores the input parameters when not active
#[cfg(not(any(test, debug_assertions)))]
#[macro_export]
macro_rules! dbg_assert {
    ($($arg:tt)*) => {};
}

pub trait IsEqual {
    fn is_equal(&self, other: &Self) -> bool;
}

// Blanket implementation of IsEqual for all types that implement IsLessThan
impl<T: IsLessThan> IsEqual for T {
    #[inline(always)]
    fn is_equal(&self, other: &Self) -> bool {
        !self.is_less_than(other) && !other.is_less_than(self)
    }
}

pub mod linkedlist;
pub mod skiplist;

pub mod prelude {
    pub use crate::CppMapError;
    pub use crate::IsLessThan;
    pub use crate::linkedlist::LinkedList;
    pub use crate::skiplist::SkipList;
}
