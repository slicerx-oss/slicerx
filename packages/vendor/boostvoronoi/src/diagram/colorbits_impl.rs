// SPDX-License-Identifier:BSL-1.0

// Boost.Polygon library detail/robust_fpt.hpp header file

//          Copyright Andrii Sydorchuk 2010-2012.
// Distributed under the Boost Software License, Version 1.0.
//    (See accompanying file LICENSE_1_0.txt or copy at
//          http://www.boost.org/LICENSE_1_0.txt)

// See http://www.boost.org for updates, documentation, and revision history of C++ code..

// Ported from C++ boost 1.76.0 to Rust in 2020/2021, 2025 by Eadf (github.com/eadf)

use crate::diagram::ColorBits;

#[allow(clippy::upper_case_acronyms)]
impl ColorBits {
    pub(crate) const ZERO: Self = ColorBits(0x0);
    // Point subtypes.
    pub(crate) const SINGLE_POINT__BIT: Self = ColorBits(0x0); // 0b_00000000
    pub(crate) const SEGMENT_START_POINT__BIT: Self = ColorBits(0x1); // 0b_00000001
    pub(crate) const SEGMENT_END_POINT__BIT: Self = ColorBits(0x2); // 0b_00000010
    /// Vertex subtype (does not exists not in c++ boost)
    pub(crate) const SITE_VERTEX__BIT: Self = ColorBits(0x4); // 0b_00000100

    // Segment subtypes.
    pub(crate) const INITIAL_SEGMENT: Self = ColorBits(0x8); // 0b1_00001000
    // todo: not used for anything?
    pub(crate) const REVERSE_SEGMENT: Self = ColorBits(0x9); // 0b1_00001001

    /// 5 color bits are reserved for internal use.
    pub(crate) const RESERVED_BITS__SHIFT: Self = Self(0x5);
    /// Used for clearing custom color
    pub(crate) const RESERVED__MASK: Self = ColorBits(0x1F); // 0b_00011111

    // todo: why have a GEOMETRY_SHIFT when GEOMETRY_CATEGORY_POINT and GEOMETRY_CATEGORY_SEGMENT could just indicate the bits directly?
    pub(crate) const GEOMETRY__SHIFT: Self = ColorBits(0x3);
    pub(crate) const GEOMETRY_CATEGORY_POINT__BIT: Self = ColorBits(0x0); // 0b_00000000
    pub(crate) const GEOMETRY_CATEGORY_SEGMENT__BIT: Self = ColorBits(0x1); // 0b_00000001

    /// Used on the site points (beach-line keys etc.) value exceeds the reserved bit field,
    /// but these site points are not public.
    pub(crate) const IS_INVERSE__BIT: Self = Self(0x20); // 0b_00100000

    // todo: remove this
    pub(crate) const TEMPORARY_CELL: Self = ColorBits(u32::MAX << ColorBits::GEOMETRY__SHIFT.0);
}
