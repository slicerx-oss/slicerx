// SPDX-License-Identifier:BSL-1.0

// Boost.Polygon library detail/robust_fpt.hpp header file

//          Copyright Andrii Sydorchuk 2010-2012.
// Distributed under the Boost Software License, Version 1.0.
//    (See accompanying file LICENSE_1_0.txt or copy at
//          http://www.boost.org/LICENSE_1_0.txt)

// See http://www.boost.org for updates, documentation, and revision history of C++ code.

// Ported from C++ boost 1.76.0 to Rust in 2020/2021, 2025 by Eadf (github.com/eadf)

//! A std::cell::Cell based version of the output data.
//! See <https://www.boost.org/doc/libs/1_76_0/libs/polygon/doc/voronoi_diagram.htm> for diagram description.

mod cell_impl;
mod colorbits_impl;
mod diagram_cell_impl;
mod diagram_edge_impl;
mod diagram_impl;
mod diagram_vertex_impl;
mod edge_impl;
mod iterator_impl;
mod trait_impl;
mod vertex_impl;

#[cfg(feature = "serde")]
use serde::{Deserialize, Serialize};

/// Typed newtype for voronoi `Source` indices
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[derive(Copy, Clone, Hash, PartialEq, Eq, Default)]
pub struct SourceIndex(pub(crate) u32);

/// Typed newtype for voronoi `Cell` indices
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[derive(Copy, Clone, Hash, PartialEq, Eq, Default)]
pub struct CellIndex(u32);

/// Typed newtype for voronoi `Edge` indices
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[derive(Copy, Clone, Hash, PartialEq, PartialOrd, Eq, Default)]
pub struct EdgeIndex(pub(crate) u32);

/// Typed newtype for voronoi `Vertex` indices
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[derive(Copy, Clone, Hash, PartialEq, Eq, Default)]
pub struct VertexIndex(u32);

pub type ColorType = u32;

/// Represents category of the input source that forms Voronoi cell.
// Todo: sort out all of these bits, seems like they overlap in functionality
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[derive(Copy, Clone, PartialEq, Eq)]
pub(crate) struct ColorBits(pub ColorType);

/// Represents the type of input geometry a voronoi `Cell` was created from
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum SourceCategory {
    /// The source was a single point
    SinglePoint,
    /// The source was a start point of a segment
    SegmentStart,
    /// The source was an end point of a segment
    SegmentEnd,
    /// The source was a segment
    Segment,
}

/// Represents a Voronoi cell.
///
/// Data members:
///   1) index of the source within the initial input set
///   2) id of the incident edge
///   3) mutable color member
///      Cell may contain point or segment site inside.
// TODO: fix the name confusing "initial index" & "source index" referring to the same thing.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[derive(Copy, Clone)]
pub struct Cell {
    // sorted_index of the site event
    id_: CellIndex,
    // source_index/initial_index of the site event
    source_index_: SourceIndex,
    incident_edge_: Option<EdgeIndex>,
    color_: ColorType,
}

/// Represents Voronoi vertex aka. Circle event.
///
/// Data members:
///   1) vertex coordinates
///   2) id of the incident edge
///   3) mutable color member
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[derive(Copy, Clone)]
pub struct Vertex {
    pub(crate) id_: VertexIndex,
    pub(crate) x_: f64,
    pub(crate) y_: f64,
    pub(crate) incident_edge_: Option<EdgeIndex>,
    pub(crate) color_: ColorType,
}

/// Half-edge data structure. Represents a Voronoi edge.
///
/// Data members:
///   1) id of the corresponding cell
///   2) id of to the vertex that is the starting
///      point of the half-edge (optional)
///   3) id of to the twin edge
///   4) id of the CCW next edge
///   5) id of to the CCW prev edge
///   6) mutable color member
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[derive(Copy, Clone)]
pub struct Edge {
    id_: EdgeIndex,
    cell_: Option<CellIndex>,
    vertex_: Option<VertexIndex>,
    twin_: Option<EdgeIndex>,
    next_ccw_: Option<EdgeIndex>,
    prev_ccw_: Option<EdgeIndex>,
    color_: ColorType,
}

/// Voronoi output data structure based on data wrapped in `Rc<Cell<T>>`.
///
/// See `SyncDiagram` for a version of this structure without the `Rc<Cell>`.
///
/// CCW ordering is used on the faces perimeter and around the vertices.
/// Mandatory reading: <https://www.boost.org/doc/libs/1_76_0/libs/polygon/doc/voronoi_diagram.htm>
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[derive(Default, Debug)]
pub struct Diagram {
    cells_: Vec<Cell>,      // indexed by CellIndex
    vertices_: Vec<Vertex>, // indexed by VertexIndex
    edges_: Vec<Edge>,      // indexed by EdgeIndex
}
