// Boost.Polygon library detail/robust_fpt.hpp header file

//          Copyright Andrii Sydorchuk 2010-2012.
// Distributed under the Boost Software License, Version 1.0.
//    (See accompanying file LICENSE_1_0.txt or copy at
//          http://www.boost.org/LICENSE_1_0.txt)

// See http://www.boost.org for updates, documentation, and revision history of C++ code..

// Ported from C++ boost 1.76.0 to Rust in 2020/2021, 2025 by Eadf (github.com/eadf)

use super::{ColorBits, ColorType, EdgeIndex, Vertex, VertexIndex};
use crate::BvError;
use num_traits::NumCast;
use std::cmp::Ordering;

#[allow(dead_code)]
impl VertexIndex {
    pub const INVALID: Self = Self(u32::MAX);

    pub fn usize(self) -> usize {
        self.0 as usize
    }

    pub fn u32(self) -> u32 {
        self.0
    }
}

impl Vertex {
    pub fn new_3(id: VertexIndex, x: f64, y: f64, is_site_vertex: bool) -> Vertex {
        let color = if is_site_vertex {
            ColorBits::SITE_VERTEX__BIT.0
        } else {
            ColorBits::ZERO.0
        };
        Self {
            id_: id,
            x_: x,
            y_: y,
            incident_edge_: None,
            color_: color,
        }
    }

    pub(super) fn vertex_equality_predicate_eq(&self, other: &Self) -> bool {
        let ulp = 128;
        let x1: f64 = NumCast::from(self.x()).unwrap();
        let y1: f64 = NumCast::from(self.y()).unwrap();
        let x2: f64 = NumCast::from(other.x()).unwrap();
        let y2: f64 = NumCast::from(other.y()).unwrap();

        crate::utils::ctypes::ulp_comparison(x1, x2, ulp) == Ordering::Equal
            && crate::utils::ctypes::ulp_comparison(y1, y2, ulp) == Ordering::Equal
    }

    pub fn get_id(&self) -> VertexIndex {
        self.id_
    }

    #[inline]
    #[cfg(feature = "console_debug")]
    pub(crate) fn get_incident_edge_(&self) -> Option<EdgeIndex> {
        self.incident_edge_
    }

    #[inline(always)]
    pub fn get_incident_edge(&self) -> Result<EdgeIndex, BvError> {
        self.incident_edge_.ok_or_else(|| {
            BvError::InternalError("Vertex didn't have an incident_edge".to_string())
        })
    }

    /// returns the x coordinate of the circle event
    #[inline(always)]
    pub fn x(&self) -> f64 {
        self.x_
    }

    /// returns the x coordinate of the circle event
    #[inline(always)]
    pub fn y(&self) -> f64 {
        self.y_
    }

    /// get_color returns the custom edge info. (does not contain the reserved bits)
    #[inline(always)]
    pub fn get_color(&self) -> ColorType {
        self.color_ >> ColorBits::RESERVED_BITS__SHIFT.0
    }

    /// set_color sets the custom edge info. (does not affect the reserved bits)
    #[inline(always)]
    pub fn set_color(&mut self, color: ColorType) -> ColorType {
        self.color_ &= ColorBits::RESERVED__MASK.0;
        self.color_ |= color << ColorBits::RESERVED_BITS__SHIFT.0;
        self.color_
    }

    /// or_color sets the custom vertex info together with the previous value. (does not affect the reserved bits)
    /// This is a Cell operation, remember to set() the entire cell
    #[inline(always)]
    pub fn or_color(&mut self, color: ColorType) -> ColorType {
        self.set_color(self.get_color() | color)
    }

    /// Returns true if this vertex coincides with an input site.
    #[inline(always)]
    pub fn is_site_point(&self) -> bool {
        (self.color_ & ColorBits::SITE_VERTEX__BIT.0) != 0
    }
}
