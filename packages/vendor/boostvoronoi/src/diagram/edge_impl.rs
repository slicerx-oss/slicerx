// SPDX-License-Identifier:BSL-1.0

// Boost.Polygon library detail/robust_fpt.hpp header file

//          Copyright Andrii Sydorchuk 2010-2012.
// Distributed under the Boost Software License, Version 1.0.
//    (See accompanying file LICENSE_1_0.txt or copy at
//          http://www.boost.org/LICENSE_1_0.txt)

// See http://www.boost.org for updates, documentation, and revision history of C++ code..

// Ported from C++ boost 1.76.0 to Rust in 2020/2021, 2025 by Eadf (github.com/eadf)

use crate::diagram::ColorBits;
use crate::prelude::*;

impl EdgeIndex {
    pub const INVALID: Self = Self(u32::MAX);

    pub fn usize(self) -> usize {
        self.0 as usize
    }

    pub fn u32(self) -> u32 {
        self.0
    }
}

impl Edge {
    // todo: this is super suspicious, doesn't this collide with SEGMENT_START_POINT & SEGMENT_END_POINT?
    const BIT_IS_LINEAR: ColorType = 0x1; // linear is opposite to curved
    const BIT_IS_PRIMARY: ColorType = 0x2; // primary is opposite to secondary

    pub(super) fn new_(id: EdgeIndex, cell: CellIndex, is_linear: bool, is_primary: bool) -> Edge {
        let mut rv = Self {
            id_: id,
            cell_: Some(cell),
            vertex_: None,
            twin_: None,
            next_ccw_: None,
            prev_ccw_: None,
            color_: 0,
        };
        if is_linear {
            rv.color_ |= Self::BIT_IS_LINEAR;
        }
        if is_primary {
            rv.color_ |= Self::BIT_IS_PRIMARY;
        }
        rv
    }

    /// Returns the edge index
    #[inline(always)]
    pub fn id(&self) -> EdgeIndex {
        self.id_
    }

    #[inline(always)]
    pub(crate) fn cell_(&self) -> Option<CellIndex> {
        self.cell_
    }

    /// Returns the cell index of this edge, or a BvError
    #[inline(always)]
    pub fn cell(&self) -> Result<CellIndex, BvError> {
        self.cell_.ok_or_else(|| {
            BvError::ValueError("Edge didn't have any valid cell associated to it.".to_string())
        })
    }

    /// Returns vertex0, it is perfectly ok for an edge to not contain a vertex0 so no
    /// Result<..> is needed here.
    #[inline(always)]
    pub fn vertex0(&self) -> Option<VertexIndex> {
        self.vertex_
    }

    /// Returns the twin edge
    #[inline(always)]
    pub(crate) fn twin_(&self) -> Option<EdgeIndex> {
        self.twin_
    }

    /// Returns the twin edge or an error
    #[inline(always)]
    pub fn twin(&self) -> Result<EdgeIndex, BvError> {
        self.twin_.ok_or_else(|| {
            BvError::ValueError(
                "Edge didn't have any valid twin edge associated to it.".to_string(),
            )
        })
    }

    /// returns the next edge (counterclockwise winding)
    #[inline(always)]
    pub(crate) fn next_(&self) -> Option<EdgeIndex> {
        self.next_ccw_
    }

    /// returns the next edge (counterclockwise winding) or an error
    #[inline(always)]
    pub fn next(&self) -> Result<EdgeIndex, BvError> {
        self.next_ccw_.ok_or_else(|| {
            BvError::ValueError(format!(
                "Edge {} didn't have any valid next edge associated to it. {}:{}",
                self.id_.0,
                file!(),
                line!()
            ))
        })
    }

    /// returns the previous edge (counterclockwise winding)
    #[inline(always)]
    pub(crate) fn prev_(&self) -> Option<EdgeIndex> {
        self.prev_ccw_
    }

    /// returns the previous edge (counterclockwise winding)
    #[inline(always)]
    pub fn prev(&self) -> Result<EdgeIndex, BvError> {
        self.prev_().ok_or_else(|| {
            BvError::InternalError("The edge does not have a previous edge".to_string())
        })
    }

    /// Returns true if the edge is linear (segment, ray, line).
    /// Returns false if the edge is curved (parabolic arc).
    #[inline]
    pub fn is_linear(&self) -> bool {
        (self.color_ & Self::BIT_IS_LINEAR) != 0
    }

    /// Returns true if the edge is curved (parabolic arc).
    /// Returns false if the edge is linear (segment, ray, line).
    #[inline]
    pub fn is_curved(&self) -> bool {
        !self.is_linear()
    }

    /// Returns false if edge goes through the endpoint of the segment.
    /// Returns true else.
    #[inline]
    pub fn is_primary(&self) -> bool {
        (self.color_ & Self::BIT_IS_PRIMARY) != 0
    }

    /// Returns true if edge goes through the endpoint of the segment.
    /// Returns false else.
    #[inline]
    pub fn is_secondary(&self) -> bool {
        !self.is_primary()
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

    /// or_color sets the custom edge info together with the previous value. (does not affect the reserved bits)
    #[inline(always)]
    pub fn or_color(&mut self, color: ColorType) -> ColorType {
        self.set_color(self.get_color() | color)
    }
}
