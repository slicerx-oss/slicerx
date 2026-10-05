// SPDX-License-Identifier:BSL-1.0

// Boost.Polygon library detail/voronoi_structures.hpp header file

//          Copyright Andrii Sydorchuk 2010-2012.
// Distributed under the Boost Software License, Version 1.0.
//    (See accompanying file LICENSE_1_0.txt or copy at
//          http://www.boost.org/LICENSE_1_0.txt)

// See http://www.boost.org for updates, documentation, and revision history of C++ code.

// Ported from C++ boost 1.76.0 to Rust in 2020/2021, 2025 by Eadf (github.com/eadf)

//! The data structures needed for the beachline.

use crate::InputType;
use crate::circle_event::CircleEventIndex;
use crate::prelude::*;
use crate::site_event as vse;
use cpp_map::skiplist::{Index, SkipList};
use std::cell::{Cell, RefCell};
use std::rc::Rc;

mod beach_line_impl;
mod trait_impl;

/// Type-checked placeholder for usize
/// Hopefully rust zero cost abstractions will flatten this out.
pub(crate) type BeachLineIndex = Index;

pub type BeachLineNodeDataType = Rc<Cell<Option<BeachLineNodeData>>>;

/// Container for BeachLineNodeKey and BeachLineNodeDataType.
/// Has a priority queue and indexed list for BeachLineNodeKey.
///
/// The ordering of beach_line_vec_ is intentionally reversed, pop() will return the last element.
/// Before this change the beach-line ordering was unpredictable.
pub struct BeachLine<I: InputType> {
    pub(crate) beach_line_: Rc<RefCell<SkipList<BeachLineNodeKey<I>, BeachLineNodeDataType>>>,
}

/// Represents a bisector node made by two arcs that correspond to the left
/// and right sites. Arc is defined as a curve with points equidistant from
/// the site and from the sweep line. If the site is a point then arc is
/// a parabola, otherwise it's a line segment. A segment site event will
/// produce different bisectors based on its direction.
/// In general case two sites will create two opposite bisectors. That's
/// why the order of the sites is important to define the unique bisector.
/// The one site is considered to be newer than the other one if it was
/// processed by the algorithm later (has greater index).
#[derive(Copy, Clone)]
pub struct BeachLineNodeKey<I: InputType> {
    left_site_: vse::SiteEvent<I>,
    right_site_: vse::SiteEvent<I>,
}

/// Represents edge data structure from the Voronoi output, that is
/// associated as a value with beach line bisector in the beach
/// line. Contains pointer to the circle event in the circle event
/// queue if the edge corresponds to the right bisector of the circle event.
// Todo! this should be rust:ified and made into an Enum
#[derive(Copy, Clone)]
pub struct BeachLineNodeData {
    circle_event_: Option<CircleEventIndex>,
    edge_: EdgeIndex,
}

/// An effort to emulate a C++ std::map iterator in Rust.
/// It will have functionality like:
/// prev(), next(), get(), erase(), lower_bound(), replace_key()
#[derive(Clone)]
pub(crate) struct BeachlineCursor<I: InputType> {
    pub(crate) current: Option<Index>,
    pub(crate) list: Rc<RefCell<SkipList<BeachLineNodeKey<I>, BeachLineNodeDataType>>>,
}

#[cfg(test)]
mod tests {
    mod common;
    mod test1;
    mod test2;
    mod test3;
}
