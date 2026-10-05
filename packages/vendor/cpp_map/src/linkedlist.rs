// SPDX-License-Identifier: MIT OR Apache-2.0

// Copyright 2021, 2025 Eadf (github.com/eadf)
// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

use crate::IsLessThan;
use std::collections::LinkedList as StdLinkedList;
use std::fmt::Debug;

mod get_set;
mod insert;
mod iterator;
mod linkedlist_impl;
mod remove;
mod trait_impl;
#[cfg(any(test, debug_assertions))]
mod validation;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Index(usize);

#[derive(Debug)]
struct ListNode<K, V>
where
    K: Debug + Clone + IsLessThan,
    V: Debug + Clone,
{
    kv: Option<(K, V)>,
    // Forward pointer
    forward: usize,
    // Backward pointer
    prev: usize,
}

const HEAD_INDEX: usize = usize::MAX - 1;
const TAIL_INDEX: usize = usize::MAX;

/// A LinkedList implementation that mimics std::map behavior from C++
/// - Supports bidirectional iteration
/// - Uses only the less-than operation for comparisons
/// - Provides hint-based insertion
#[derive(Debug)]
pub struct LinkedList<K, V>
where
    K: Debug + Clone + IsLessThan,
    V: Debug + Clone,
{
    // Head node index (sentinel)
    head: usize,
    // Tail node index (sentinel)
    tail: usize,
    // Storage for all nodes
    nodes: Vec<ListNode<K, V>>,
    // Storage for free node indexes.
    // If the index is in here, the value of self.node[index].is_active should be false
    free_index_pool: StdLinkedList<usize>,
    #[cfg(feature = "linkedlist_midpoint")]
    // field to track approximate midpoint
    mid_point: Option<usize>,
    #[cfg(feature = "linkedlist_midpoint")]
    // Tracks midpoint balance:
    // - `delta = (nodes_right) - (nodes_left)`
    // - If `delta > 1`, move mid right.
    // - If `delta < -1`, move mid left.
    mid_point_delta: i32,
}

