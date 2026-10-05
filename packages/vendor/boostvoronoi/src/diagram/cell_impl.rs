// SPDX-License-Identifier:BSL-1.0

// Boost.Polygon library detail/robust_fpt.hpp header file

//          Copyright Andrii Sydorchuk 2010-2012.
// Distributed under the Boost Software License, Version 1.0.
//    (See accompanying file LICENSE_1_0.txt or copy at
//          http://www.boost.org/LICENSE_1_0.txt)

// See http://www.boost.org for updates, documentation, and revision history of C++ code..

// Ported from C++ boost 1.76.0 to Rust in 2020/2021, 2025 by Eadf (github.com/eadf)

use super::{ColorBits, SourceCategory};
use crate::prelude::*;

impl CellIndex {
    pub const INVALID: Self = Self(u32::MAX);

    pub fn usize(self) -> usize {
        self.0 as usize
    }

    pub fn u32(self) -> u32 {
        self.0
    }
}

impl Cell {
    pub fn new(id: CellIndex, source_index: SourceIndex, source_category: ColorType) -> Self {
        Cell {
            id_: id,
            source_index_: source_index,
            incident_edge_: None,
            color_: source_category,
        }
    }

    #[inline(always)]
    pub(crate) fn internal_color(&self) -> ColorBits {
        ColorBits(self.color_ & ColorBits::RESERVED__MASK.0)
    }

    #[inline(always)]
    pub fn source_category(&self) -> SourceCategory {
        match self.internal_color() {
            ColorBits::SINGLE_POINT__BIT => SourceCategory::SinglePoint,
            ColorBits::SEGMENT_START_POINT__BIT => SourceCategory::SegmentStart,
            ColorBits::SEGMENT_END_POINT__BIT => SourceCategory::SegmentEnd,
            _ => SourceCategory::Segment,
        }
    }

    /// Returns true if the cell contains point site, false else.
    #[inline(always)]
    pub fn contains_point(&self) -> bool {
        let geometry = self.internal_color().0 >> ColorBits::GEOMETRY__SHIFT.0;
        geometry == ColorBits::GEOMETRY_CATEGORY_POINT__BIT.0
    }

    /// Returns true if the cell contains segment site, false otherwise.
    #[inline(always)]
    pub fn contains_segment(&self) -> bool {
        let geometry = self.internal_color().0 >> ColorBits::GEOMETRY__SHIFT.0;
        geometry == ColorBits::GEOMETRY_CATEGORY_SEGMENT__BIT.0
    }

    /// Returns true if the cell contains segment start point, false otherwise.
    #[inline(always)]
    pub fn contains_segment_startpoint(&self) -> bool {
        self.internal_color().0 == ColorBits::SEGMENT_START_POINT__BIT.0
    }

    /// Returns true if the cell contains segment end point, false otherwise.
    #[inline(always)]
    pub fn contains_segment_endpoint(&self) -> bool {
        self.internal_color().0 == ColorBits::SEGMENT_END_POINT__BIT.0
    }

    #[inline(always)]
    pub fn id(&self) -> CellIndex {
        self.id_
    }

    /// Returns the origin index of the cell.
    #[inline(always)]
    pub fn source_index(&self) -> SourceIndex {
        self.source_index_
    }

    /// Returns the origin index of the point that created this cell.
    /// It also returns the source category
    #[inline(always)]
    pub fn source_index_2(&self) -> (SourceIndex, SourceCategory) {
        (self.source_index_, self.source_category())
    }

    /// Degenerate cells don't have any incident edges.
    pub fn is_degenerate(&self) -> bool {
        self.incident_edge_.is_none()
    }

    /// returns a random edge defined by this cell.
    #[inline(always)]
    pub fn get_incident_edge(&self) -> Option<EdgeIndex> {
        self.incident_edge_
    }
}
