// SPDX-License-Identifier:BSL-1.0

// Boost.Polygon library detail/voronoi_structures.hpp header file

//          Copyright Andrii Sydorchuk 2010-2012.
// Distributed under the Boost Software License, Version 1.0.
//    (See accompanying file LICENSE_1_0.txt or copy at
//          http://www.boost.org/LICENSE_1_0.txt)

// See http://www.boost.org for updates, documentation, and revision history of C++ code.

// Ported from C++ boost 1.76.0 to Rust in 2020/2021,2025 by Eadf (github.com/eadf)

use crate::InputType;
use crate::beach_line::{BeachLine, BeachLineNodeData, BeachLineNodeKey, BeachlineCursor};
use cpp_map::prelude::*;
use std::cell::RefCell;
use std::cmp::Ordering;
use std::fmt;
use std::hash::{Hash, Hasher};
use std::rc::Rc;

impl fmt::Debug for BeachLineNodeData {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "BeachLineNodeData{{circle_event:")?;
        match self.circle_event_ {
            Some(idx) => write!(f, "{idx},")?,
            None => write!(f, "-,")?,
        };
        write!(f, "edge_:{:?}", self.edge_)?;
        write!(f, "}}")
    }
}

impl<I: InputType> Default for BeachLine<I> {
    fn default() -> Self {
        Self {
            beach_line_: Rc::from(RefCell::from(SkipList::default())),
        }
    }
}

impl<I: InputType> fmt::Debug for BeachLine<I> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f,)?;
        for (index, node) in self.beach_line_.borrow().iter().enumerate() {
            writeln!(f, "{index}: {node:?}")?;
        }
        writeln!(f,)
    }
}

impl<I: InputType> fmt::Debug for BeachLineNodeKey<I> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "L:{:?},R:{:?}", &self.left_site(), &self.right_site())
    }
}

impl<I: InputType> Ord for BeachLineNodeKey<I> {
    // todo: move the content of node_comparison_predicate to here
    #[inline(always)]
    fn cmp(&self, other: &Self) -> Ordering {
        if crate::predicate::node_comparison_predicate::node_comparison::<I>(self, other) {
            Ordering::Less
        } else if crate::predicate::node_comparison_predicate::node_comparison::<I>(other, self) {
            Ordering::Greater
        } else {
            Ordering::Equal
        }
    }
}

impl<I: InputType> PartialOrd for BeachLineNodeKey<I> {
    #[inline(always)]
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl<I: InputType> PartialEq for BeachLineNodeKey<I> {
    // todo: node1.cmp(node2)==Ordering.Equal is not the same as node1 == node2, should it be?
    #[inline(always)]
    fn eq(&self, other: &Self) -> bool {
        self.left_site_ == other.left_site_ && self.right_site_ == other.right_site_
    }
}

impl<I: InputType> IsLessThan for BeachLineNodeKey<I> {
    // todo: move the content of node_comparison_predicate to here
    #[inline(always)]
    fn is_less_than(&self, other: &Self) -> bool {
        crate::predicate::node_comparison_predicate::node_comparison::<I>(self, other)
    }
}

impl<I: InputType> Eq for BeachLineNodeKey<I> {}

impl<I: InputType> Hash for BeachLineNodeKey<I> {
    #[inline(always)]
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.left_site_.hash(state);
        self.right_site_.hash(state);
    }
}

impl<I: InputType> fmt::Debug for BeachlineCursor<I> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "PIterator({:?})", self.current)
    }
}
