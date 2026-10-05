// SPDX-License-Identifier: MIT OR Apache-2.0

// Copyright 2021, 2025 Eadf (github.com/eadf)
// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

use crate::IsLessThan;
use smallvec::SmallVec;
use std::collections::LinkedList;
use std::fmt::Debug;

mod extend;
mod get_set;
mod insert;
mod iterator;
mod rank;
mod skiplist_impl;
mod trait_impl;
#[cfg(any(test, debug_assertions))]
mod validation;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Index(usize);

#[derive(Debug)]
struct SkipNodeHead {
    rank: i64,
    // Forward pointers at different levels
    forward: Vec<usize>,
}

#[derive(Debug)]
struct SkipNode<K, V>
where
    K: Debug + Clone + IsLessThan,
    V: Debug + Clone,
{
    kv: Option<(K, V)>,
    // Rank for stable ordering
    rank: i64,
    // Forward pointers at different levels
    forward: SmallVec<[usize; 1]>,
    // Backward pointer
    prev: usize,
}

#[derive(Debug)]
struct SkipNodeTail {
    rank: i64,
    // Backward pointer
    prev: usize,
}

const HEAD_INDEX: usize = usize::MAX - 1;
const TAIL_INDEX: usize = usize::MAX;

/// A SkipList implementation that mimics std::map behavior from C++
/// - Supports bidirectional iteration
/// - Uses only the less-than operation for comparisons
/// - Provides hint-based insertion
#[derive(Debug)]
pub struct SkipList<K, V>
where
    K: Debug + Clone + IsLessThan,
    V: Debug + Clone,
{
    // Probability factor for level generation (commonly 0.25 or 0.5)
    p: f64,
    // Maximum level of the skip list (this can grow if needed)
    // It is based on the number of elements in the list log2(n).
    max_level: usize,
    original_max_level: usize,
    // Current highest level with elements
    current_level: usize,
    // Head node index (sentinel)
    head: SkipNodeHead,
    // Tail node index (sentinel)
    tail: SkipNodeTail,
    // Storage for all nodes
    nodes: Vec<SkipNode<K, V>>,
    // Storage for free node indexes.
    // If the index is in here, the value of self.node[index].is_active should be false
    free_index_pool: LinkedList<usize>,
    // tells us if the ranks should be re-distributed.
    is_congested: bool,
}

