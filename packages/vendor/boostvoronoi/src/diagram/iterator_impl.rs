// SPDX-License-Identifier:BSL-1.0

// Boost.Polygon library detail/robust_fpt.hpp header file

//          Copyright Andrii Sydorchuk 2010-2012.
// Distributed under the Boost Software License, Version 1.0.
//    (See accompanying file LICENSE_1_0.txt or copy at
//          http://www.boost.org/LICENSE_1_0.txt)

// See http://www.boost.org for updates, documentation, and revision history of C++ code..

// Ported from C++ boost 1.76.0 to Rust in 2020/2021, 2025 by Eadf (github.com/eadf)

use super::{CellIndex, Diagram, EdgeIndex, VertexIndex};
use smallvec::SmallVec;
use std::iter::Map;
use std::ops::Range;

impl Diagram {
    /// Returns a decoupled iterator of the edge indices (that does not borrow &self)
    /// Do *not* add or remove edges during the iterator lifetime.
    pub fn decoupled_edges_iter(&self) -> Map<Range<u32>, fn(u32) -> EdgeIndex> {
        (0..(self.edges_.len() as u32)).map(EdgeIndex)
    }

    /// Returns a decoupled iterator of the cell indices (that does not borrow &self)
    /// Do *not* add or remove cells during the iterator lifetime.
    pub fn decoupled_cells_iter(&self) -> Map<Range<u32>, fn(u32) -> CellIndex> {
        (0..(self.cells_.len() as u32)).map(CellIndex)
    }

    /// Returns a decoupled iterator of the cell indices (that does not borrow &self)
    /// Do *not* add or remove vertices during the iterator lifetime.
    pub fn decoupled_vertices_iter(&self) -> Map<Range<u32>, fn(u32) -> VertexIndex> {
        (0..(self.vertices_.len() as u32)).map(VertexIndex)
    }

    /// Returns an edge iterator. This iterates over the edges belonging to this cell starting with
    /// the incident edge.
    #[inline(always)]
    pub fn cell_edge_iterator(&self, cell_id: CellIndex) -> EdgeNextIterator<'_> {
        EdgeNextIterator::<'_>::new(self, self.cell_get_incident_edge_(cell_id))
    }

    #[inline]
    /// Returns an edge iterator, the edges will all originate at the same vertex as 'edge_id'.
    ///  'edge_id' will be the first edge returned by the iterator.
    /// Do *NOT* use this when altering next, prev or twin edges.
    pub fn edge_rot_next_iterator(&self, edge_id: EdgeIndex) -> EdgeRotNextIterator<'_> {
        EdgeRotNextIterator::new(self, edge_id)
    }

    #[inline]
    /// Returns a collected edge list, the edges will all originate at the same vertex as 'edge_id'.
    ///  'edge_id' will be the first edge returned by the iterator.
    /// Do *NOT* use this when altering next, prev or twin edges.
    pub fn edge_rot_next_edges(&self, edge_id: EdgeIndex) -> SmallVec<[EdgeIndex; 6]> {
        self.edge_rot_next_iterator(edge_id).collect()
    }

    #[inline]
    /// Returns an edge iterator, the edges will all originate at the same vertex as 'edge_id'.
    ///  'edge_id' will be the first edge returned by the iterator.
    /// Do *NOT* use this when altering next, prev or twin edges.
    pub fn edge_rot_prev_iterator(&self, edge_id: EdgeIndex) -> EdgeRotPrevIterator<'_> {
        EdgeRotPrevIterator::new(self, Some(edge_id))
    }
}

/// EdgeIndex based iterator over edges of a Cell.
/// Do *NOT* use this while altering the std::cell::Cell values of next, prev or twin edges.
pub struct EdgeNextIterator<'s> {
    diagram_: &'s Diagram,
    start_edge_: EdgeIndex,
    next_edge_: Option<EdgeIndex>,
}

impl<'s> EdgeNextIterator<'s> {
    pub(crate) fn new(diagram: &'s Diagram, starting_edge: Option<EdgeIndex>) -> Self {
        if let Some(starting_edge) = starting_edge {
            Self {
                diagram_: diagram,
                start_edge_: starting_edge,
                next_edge_: Some(starting_edge),
            }
        } else {
            Self {
                diagram_: diagram,
                // Value does not matter: next edge is None
                start_edge_: EdgeIndex(0),
                next_edge_: None,
            }
        }
    }
}

impl Iterator for EdgeNextIterator<'_> {
    type Item = EdgeIndex;
    #[inline(always)]
    fn next(&mut self) -> Option<EdgeIndex> {
        let rv = self.next_edge_?;
        self.next_edge_ = self
            .diagram_
            .edge_get_next_(rv)
            .filter(|&nne| nne != self.start_edge_);
        Some(rv)
    }
}

/// Iterator over edges pointing away from the vertex indicated by the initial edge.
/// edge.vertex()
/// Do *NOT* use this when altering the std::cell::Cell values of next, prev or twin edges.
pub struct EdgeRotNextIterator<'s> {
    diagram_: &'s Diagram,
    start_edge: EdgeIndex,
    next_edge: Option<EdgeIndex>,
}

impl<'s> EdgeRotNextIterator<'s> {
    pub(crate) fn new(diagram: &'s Diagram, starting_edge: EdgeIndex) -> Self {
        Self {
            diagram_: diagram,
            start_edge: starting_edge,
            next_edge: Some(starting_edge),
        }
    }
}

impl Iterator for EdgeRotNextIterator<'_> {
    type Item = EdgeIndex;
    #[inline(always)]
    fn next(&mut self) -> Option<EdgeIndex> {
        let rv = self.next_edge?;
        self.next_edge = self
            .diagram_
            .edge_rot_next(rv)
            .filter(|&nne| nne != self.start_edge);
        Some(rv)
    }
}

/// Iterator over edges pointing away from the vertex indicated by the initial edge.
/// edge.vertex()
/// Do *NOT* use this when altering the std::cell::Cell values of next, prev or twin edges.
pub struct EdgeRotPrevIterator<'s> {
    diagram_: &'s Diagram,
    start_edge: EdgeIndex,
    next_edge: Option<EdgeIndex>,
}

impl<'s> EdgeRotPrevIterator<'s> {
    pub(crate) fn new(diagram: &'s Diagram, starting_edge: Option<EdgeIndex>) -> Self {
        if let Some(starting_edge) = starting_edge {
            Self {
                diagram_: diagram,
                start_edge: starting_edge,
                next_edge: Some(starting_edge),
            }
        } else {
            Self {
                diagram_: diagram,
                // Value does not matter next edge is None
                start_edge: EdgeIndex(0),
                next_edge: None,
            }
        }
    }
}

impl Iterator for EdgeRotPrevIterator<'_> {
    type Item = EdgeIndex;
    #[inline(always)]
    fn next(&mut self) -> Option<EdgeIndex> {
        let rv = self.next_edge?;
        self.next_edge = self
            .diagram_
            .edge_rot_prev(rv)
            .filter(|&nne| nne != self.start_edge);
        Some(rv)
    }
}
