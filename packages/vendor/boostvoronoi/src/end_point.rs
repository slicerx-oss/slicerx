// SPDX-License-Identifier:BSL-1.0

// Boost.Polygon library detail/voronoi_structures.hpp header file

//          Copyright Andrii Sydorchuk 2010-2012.
// Distributed under the Boost Software License, Version 1.0.
//    (See accompanying file LICENSE_1_0.txt or copy at
//          http://www.boost.org/LICENSE_1_0.txt)

// See http://www.boost.org for updates, documentation, and revision history of C++ code..

// Ported from C++ boost 1.76.0 to Rust in 2020/2021 by Eadf (github.com/eadf)

use crate::InputType;
use crate::beach_line as vb;
use crate::geometry::Point;
use crate::predicate as vp;
use std::cmp::Ordering;

///
/// This was declared as "typedef std::pair<point_type, beach_line_iterator> end_point_type" in C++
///
#[derive(Debug)]
pub(crate) struct EndPointPair<I: InputType> {
    site_: Point<I>,
    beachline_index_: vb::BeachLineIndex,
}

impl<I: InputType> EndPointPair<I> {
    pub(crate) fn new(first: Point<I>, second: vb::BeachLineIndex) -> Self {
        Self {
            site_: first,
            beachline_index_: second,
        }
    }

    /// Returns a reference to the site point
    #[inline(always)]
    pub(crate) fn site(&self) -> Point<I> {
        self.site_
    }

    /// Returns a reference to the beachline index
    #[inline(always)]
    pub(crate) fn beachline_index(&self) -> &vb::BeachLineIndex {
        &self.beachline_index_
    }
}

impl<I: InputType> PartialOrd for EndPointPair<I> {
    #[inline(always)]
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl<I: InputType> Ord for EndPointPair<I> {
    #[inline(always)]
    fn cmp(&self, other: &Self) -> Ordering {
        if vp::point_comparison::point_comparison(self.site_, other.site_) {
            Ordering::Greater
        } else if self.site_ == other.site_ {
            Ordering::Equal
        } else {
            Ordering::Less
        }
    }
}

impl<I: InputType> PartialEq for EndPointPair<I> {
    #[inline(always)]
    fn eq(&self, other: &Self) -> bool {
        self.site_.eq(&other.site_)
    }
}

impl<I> Eq for EndPointPair<I> where I: InputType {}
