// SPDX-License-Identifier:BSL-1.0

// Boost.Polygon library detail/robust_fpt.hpp header file

//          Copyright Andrii Sydorchuk 2010-2012.
// Distributed under the Boost Software License, Version 1.0.
//    (See accompanying file LICENSE_1_0.txt or copy at
//          http://www.boost.org/LICENSE_1_0.txt)

// See http://www.boost.org for updates, documentation, and revision history of C++ code..

// Ported from C++ boost 1.76.0 to Rust in 2020/2021, 2025 by Eadf (github.com/eadf)

use super::{Cell, CellIndex, Edge, EdgeIndex, SourceIndex, Vertex, VertexIndex};
use std::fmt;

impl fmt::Debug for Cell {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "(id:{:?} ii:{} ie:{} col:{})",
            self.id_.0,
            self.source_index_.0,
            crate::utils::ctypes::format_id(self.incident_edge_.map(|x| x.0)),
            self.color_
        )
    }
}

impl fmt::Debug for CellIndex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "CellIndex({})", self.0)
    }
}

impl fmt::Debug for EdgeIndex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "EdgeIndex({})", self.0)
    }
}

impl fmt::Debug for VertexIndex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "VertexIndex({})", self.0)
    }
}

impl fmt::Debug for SourceIndex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl fmt::Debug for Vertex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "(id:{} x:{} y:{} ie:{} co:{})",
            self.id_.0,
            self.x_,
            self.y_,
            crate::utils::ctypes::format_id(self.incident_edge_.map(|x| x.0)),
            self.color_
        )
    }
}

impl fmt::Debug for Edge {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "id:{} cell:{} v0:{} t:{} n:{} p:{} c:{}",
            self.id_.0,
            crate::utils::ctypes::format_id(self.cell_.map(|c| c.0)),
            crate::utils::ctypes::format_id(self.vertex_.map(|v| v.0)),
            crate::utils::ctypes::format_id(self.twin_.map(|e| e.0)),
            crate::utils::ctypes::format_id(self.next_ccw_.map(|e| e.0)),
            crate::utils::ctypes::format_id(self.prev_ccw_.map(|e| e.0)),
            self.color_
        )
    }
}

impl PartialEq<u32> for CellIndex {
    #[inline(always)]
    fn eq(&self, other: &u32) -> bool {
        self.0 == *other
    }
}

impl PartialEq<u32> for EdgeIndex {
    #[inline(always)]
    fn eq(&self, other: &u32) -> bool {
        self.0 == *other
    }
}

impl PartialEq<u32> for VertexIndex {
    #[inline(always)]
    fn eq(&self, other: &u32) -> bool {
        self.0 == *other
    }
}

impl PartialEq<usize> for SourceIndex {
    #[inline(always)]
    fn eq(&self, other: &usize) -> bool {
        (self.0 as usize) == *other
    }
}
