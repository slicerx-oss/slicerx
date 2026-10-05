// SPDX-License-Identifier:BSL-1.0

// Boost.Polygon library
//          Copyright Andrii Sydorchuk 2010-2012.
// Distributed under the Boost Software License, Version 1.0.
//    (See accompanying file LICENSE_1_0.txt or copy at
//          http://www.boost.org/LICENSE_1_0.txt)
// See http://www.boost.org for updates, documentation, and revision history of C++ code.
//
// Ported from C++ boost 1.76.0 to Rust in 2020/2021 by Eadf (github.com/eadf)

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
#![doc(issue_tracker_base_url = "https://github.com/eadf/boostvoronoi.rs/issues")]

//! The `boostvoronoi` Rust library provides functionality to construct a Voronoi diagram of a set
//! of points and linear segments in 2D space with the following set of limitations:
//!
//! * Coordinates of the input points and endpoints of the input segments should have integral type.
//!   The `i32` and `i64` data types are supported by the default implementation.
//!
//! * Input points and segments should not overlap except their endpoints.
//!   This means that input point should not lie inside the input segment and input segments
//!   should not intersect except their endpoints.
//!
//! This library is a port of the C++ boost voronoi implementation
//! <https://www.boost.org/doc/libs/1_76_0/libs/polygon/doc/voronoi_main.htm>

use cpp_map::CppMapError;
use num_traits::{AsPrimitive, NumCast, PrimInt, Signed};
use std::cell::{BorrowError, BorrowMutError};
use std::{fmt, hash::Hash};

mod beach_line;
#[doc(hidden)]
pub mod builder;
mod circle_event;
#[doc(hidden)]
pub mod diagram;
mod end_point;
#[doc(hidden)]
pub mod geometry;
pub(crate) mod predicate;
mod site_event;

#[doc(hidden)]
pub mod utils {
    pub mod ctypes;
    pub mod file_reader;
    pub mod visual_utils;
}
#[doc(hidden)]
pub mod extended_scalar {
    pub mod extended_exp_fpt;
    pub mod extended_int;
    #[cfg(not(target_arch = "wasm32"))]
    pub mod fixed_int;
    pub mod robust_fpt;
    pub(crate) mod robust_sqrt_expr;
}

/// A feature gated print(), will only be active when the feature "console_debug" is selected.
macro_rules! t {
    ($($arg:tt)*) => ({
     #[cfg(feature = "console_debug")]
     print!($($arg)*)
    });
}
pub(crate) use t;

/// A feature gated println(), will only be active when the feature "console_debug" is selected.
macro_rules! tln {
    ($($arg:tt)*) => ({
     #[cfg(feature = "console_debug")]
     println!($($arg)*)
    });
}
pub(crate) use tln;

#[doc(hidden)]
/// The Error type of the library
#[derive(thiserror::Error, Debug)]
pub enum BvError {
    #[error("error: Some error with the index map")]
    IndexError(String),
    #[error(transparent)]
    BorrowError(#[from] BorrowError),
    #[error(transparent)]
    CppMapError(#[from] CppMapError),
    #[error(transparent)]
    BorrowMutError(#[from] BorrowMutError),
    #[error("error: Some error with object id")]
    IdError(String),
    #[error("error: Some error with a value")]
    ValueError(String),
    #[error("error: Some error with the beach-line")]
    BeachLineError(String),
    #[error("error: given value for the radius is less than 0.0.")]
    RadiusLessThanZero,
    #[error("error: vertices should be added before segments")]
    VerticesGoesFirst(String),
    #[error("error: Some error")]
    InternalError(String),
    #[error("Suspected self-intersecting input data")]
    SelfIntersecting(String),
    #[error("Could not cast number")]
    NumberConversion(String),
    #[error(transparent)]
    BvError(#[from] std::io::Error),
}

#[doc(hidden)]
/// This is the integer input type of the algorithm. i32 or i64.
pub trait InputType:
    NumCast
    + AsPrimitive<f64>
    + AsPrimitive<i64>
    + AsPrimitive<i32>
    + PrimInt
    + Sync
    + Hash
    + Copy
    + Default
    + Unpin
    + Signed
    + fmt::Debug
    + fmt::Display
    + std::str::FromStr<Err: fmt::Debug>
{
}

impl InputType for i64 {}
impl InputType for i32 {}

#[doc(hidden)]
/// Convert from one numeric type to another.
/// # Panics
/// panics if the conversion fails
pub fn cast<T: NumCast, U: NumCast>(n: T) -> U {
    NumCast::from(n).unwrap()
}

#[doc(hidden)]
#[inline(always)]
/// Try to convert from one numeric type to another
/// # Errors
/// Will return an BvError::NumberConversion if the conversion fails
pub fn try_cast<T: NumCast + fmt::Debug + Copy, U: NumCast>(n: T) -> Result<U, BvError> {
    NumCast::from(n).ok_or_else(|| {
        BvError::NumberConversion(format!(
            "Could not convert {:?} to {}",
            n,
            std::any::type_name::<U>()
        ))
    })
}

pub(crate) type VobU32 = vob::Vob<u32>;

pub(crate) trait GrowingVob {
    /// Will create a new Vob and fill it with `false`
    fn fill(initial_size: usize) -> Self;
    /// Conditionally grow to fit required size, set `bit` to `state` value
    fn set_grow(&mut self, bit: usize, state: bool);
    /// get() with default value `false`
    fn get_f(&self, bit: usize) -> bool;
}

impl<T: PrimInt + fmt::Debug> GrowingVob for vob::Vob<T> {
    #[inline]
    fn fill(initial_size: usize) -> Self {
        let mut v = Self::new_with_storage_type(0);
        v.resize(initial_size, false);
        v
    }

    #[inline]
    fn set_grow(&mut self, bit: usize, state: bool) {
        if bit >= self.len() {
            self.resize(bit + size_of::<T>(), false);
        }
        let _ = self.set(bit, state);
    }

    #[inline(always)]
    fn get_f(&self, bit: usize) -> bool {
        self.get(bit).unwrap_or(false)
    }
}

#[cfg(feature = "cgmath")]
// Allowing integration tests access to `cgmath` without needing to add `cgmath` to dev-dependencies.
pub use cgmath;

#[cfg(feature = "mint")]
// Allowing integration tests access to `mint` without needing to add `mint` to dev-dependencies.
pub use mint;

#[cfg(feature = "geo")]
// Allowing integration tests access to `geo` without needing to add `geo` to dev-dependencies.
pub use geo;

#[cfg(feature = "glam")]
// Allowing integration tests access to `glam` without needing to add `glam` to dev-dependencies.
pub use glam;

#[cfg(feature = "nalgebra")]
// Allowing integration tests access to `nalgebra` without needing to add `nalgebra` to dev-dependencies.
pub use nalgebra;

pub mod prelude {
    pub use crate::builder::Builder;
    pub use crate::diagram::{
        Cell, CellIndex, ColorType, Diagram, Edge, EdgeIndex, SourceCategory, SourceIndex, Vertex,
        VertexIndex,
    };
    pub use crate::geometry::{Line, Point};
    pub use crate::utils::file_reader::{read_boost_input_buffer, read_boost_input_file};
    pub use crate::utils::visual_utils::VoronoiVisualUtils;
    pub use crate::{BvError, InputType};
}
