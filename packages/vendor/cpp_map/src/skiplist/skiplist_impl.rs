// SPDX-License-Identifier: MIT OR Apache-2.0

// Copyright 2025 Eadf (github.com/eadf)
// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

use crate::skiplist::{
    HEAD_INDEX, Index, SkipList, SkipNode, SkipNodeHead, SkipNodeTail, TAIL_INDEX,
};
use crate::{CppMapError, IsEqual, IsLessThan};
use std::cell::RefCell;
use std::collections::LinkedList;
use std::fmt::Debug;

/// The source of node levels. A skip list only needs levels for balance, but the beach line of a
/// Voronoi diagram compares keys that can tie, and then the levels decide which way a tie goes. A
/// fixed seed, restarted for each new list, makes the same input build the same diagram every time.
pub(super) struct Level(u64);

const LEVEL_SEED: u64 = 0x9E37_79B9_7F4A_7C15;

impl Level {
    /// A uniform number in the closed range (SplitMix64).
    pub(super) fn random_range(&mut self, range: std::ops::RangeInclusive<f64>) -> f64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        let unit = (z >> 11) as f64 / (1u64 << 53) as f64;
        range.start() + unit * (range.end() - range.start())
    }
}

thread_local! {
    pub(super) static THREAD_RNG: RefCell<Level> = const { RefCell::new(Level(LEVEL_SEED)) };
}

impl<K, V> SkipList<K, V>
where
    K: Debug + Clone + IsLessThan,
    V: Debug + Clone,
{
    /// Create a new skip list with default parameters
    pub fn new() -> Self {
        Self::with_params(0.50, 3)
    }

    /// Create a new skip list with custom probability and max level
    pub fn with_params(p: f64, initial_max_level: usize) -> Self {
        let nodes: Vec<SkipNode<K, V>> = Vec::new();

        // Create head node
        let head = SkipNodeHead {
            forward: vec![TAIL_INDEX; initial_max_level], // Initially all point to tail
            rank: -i64::MAX,
        };

        // Create tail node
        let tail = SkipNodeTail {
            prev: HEAD_INDEX, // Initially points to head
            rank: i64::MAX,
        };

        THREAD_RNG.with(|r| *r.borrow_mut() = Level(LEVEL_SEED));
        SkipList {
            p,
            max_level: initial_max_level,
            original_max_level: initial_max_level,
            current_level: 0,
            head,
            tail,
            nodes,
            free_index_pool: LinkedList::default(),
            is_congested: false,
        }
    }

    #[inline(always)]
    /// Get the number of elements in the SkipList
    pub fn len(&self) -> usize {
        self.nodes.len().saturating_sub(self.free_index_pool.len())
    }

    #[inline(always)]
    /// Check if the SkipList is empty
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    #[inline(always)]
    pub(super) fn coin_flip(&self, rng: &mut Level, level: usize) -> bool {
        rng.random_range(0.0..=1.0_f64) < self.p && level < self.max_level - 1
    }

    #[inline(always)]
    /// Generate a random level for a new node
    pub(super) fn random_level(&self, rng: &mut Level) -> usize {
        let mut level = 0;
        while self.coin_flip(rng, level) {
            level += 1;
        }
        level
    }

    #[inline(always)]
    pub(super) fn _forward(&self, index: usize, level: usize) -> usize {
        match index {
            HEAD_INDEX => {
                if level < self.head.forward.len() {
                    self.head.forward[level]
                } else {
                    TAIL_INDEX
                }
            }
            TAIL_INDEX => TAIL_INDEX,
            _ => {
                dbg_assert!(self.nodes[index].kv.is_some());
                let forward = &self.nodes[index].forward;
                if level < forward.len() {
                    forward[level]
                } else {
                    TAIL_INDEX
                }
            }
        }
    }

    #[inline(always)]
    pub(super) fn _forward_0(&self, index: usize) -> usize {
        match index {
            HEAD_INDEX => self.head.forward[0],
            TAIL_INDEX => TAIL_INDEX,
            _ => {
                dbg_assert!(self.nodes[index].kv.is_some());
                self.nodes[index].forward[0]
            }
        }
    }

    #[inline(always)]
    pub(super) fn _prev(&self, index: usize) -> usize {
        match index {
            HEAD_INDEX => HEAD_INDEX,
            TAIL_INDEX => self.tail.prev,
            _ => {
                dbg_assert!(self.nodes[index].kv.is_some());
                self.nodes[index].prev
            }
        }
    }

    #[inline(always)]
    fn _is_key_greater_or_equal_than_node(&self, index: usize, key: &K) -> bool {
        match index {
            HEAD_INDEX => true,
            TAIL_INDEX => false,
            _ => !self.nodes[index].k().is_less_than(key),
        }
    }

    #[inline(always)]
    fn _is_key_less_than_node(&self, index: usize, key: &K) -> bool {
        match index {
            HEAD_INDEX => false,
            TAIL_INDEX => true,
            _ => key.is_less_than(self.nodes[index].k()),
        }
    }

    #[inline(always)]
    fn _is_node_less_than_key(&self, index: usize, key: &K) -> bool {
        match index {
            HEAD_INDEX => true,
            TAIL_INDEX => false,
            _ => self.nodes[index].k().is_less_than(key),
        }
    }

    /// Find the position of a key using only less-than operations
    /// Returns the search path for insertion, i.e. the index where the new node will be inserted after
    /// find_position_with_trace_()[0]->next == new node
    pub(super) fn find_position_with_path_(&self, key: &K) -> Vec<usize> {
        let mut update = vec![HEAD_INDEX; self.max_level];
        let mut current = HEAD_INDEX;

        // Start from the highest level and work down
        for level in (0..=self.current_level).rev() {
            // Traverse current level until we find a node with a key not less than our search key
            loop {
                let next = self._forward(current, level);

                // If we've reached the tail or a node where the key is not less than our search key
                if next == TAIL_INDEX || self._is_key_greater_or_equal_than_node(next, key) {
                    // Save this position in our update vector and break to the next level down
                    update[level] = current;
                    break;
                }

                // Continue moving forward at the current level
                current = next;
            }
        }
        update
    }

    /// Find the position of a key using only less-than operations
    /// Returns index of the node just before where the key would be
    /// along with the update vector for insertion
    fn find_position_(&self, key: &K) -> Option<usize> {
        let mut current = HEAD_INDEX;

        // Start from the highest level and work down
        for level in (0..=self.current_level).rev() {
            // Traverse current level until we find a node with a key not less than our search key
            loop {
                let next = self._forward(current, level);

                // If we've reached the tail or a node where the key is not less than our search key
                if next == TAIL_INDEX || self._is_key_greater_or_equal_than_node(next, key) {
                    if level == 0 {
                        return Some(current);
                    }
                    break;
                }

                // Continue moving forward at the current level
                current = next;
            }
        }
        None
    }

    #[cfg(any(test, debug_assertions))]
    pub fn sequential_find_position(&self, key: &K, hint_position: Index) -> Option<Index> {
        self.sequential_find_position_(key, hint_position.0)
            .map(Index)
    }

    /// Find the position of a key using only less-than operations.
    /// Returns index of the node just before where the new key should be inserted
    pub(super) fn sequential_find_position_(&self, key: &K, hint_position: usize) -> Option<usize> {
        if let Some(hint_k) = self.get_k_at_(hint_position) {
            if hint_k.is_less_than(key) {
                // search towards tail
                self.sequential_find_position_next_(key, hint_position)
            } else if key.is_less_than(hint_k) {
                // search towards head
                self.sequential_find_position_prev_(key, hint_position)
            } else {
                self.prev_pos_(hint_position)
            }
        } else {
            None
        }
    }

    /// should only be called from `sequential_find_position_()`
    fn sequential_find_position_next_(&self, key: &K, hint_pos: usize) -> Option<usize> {
        let mut current = hint_pos;
        // Start from the hint position and work towards the tail
        // until we find a node that is !(next.key < key)
        // we know the hint_pos.key < key
        loop {
            let next = self._forward_0(current);
            //println!("sequential_find_position_next_ current:{}, next:{}", current, next);
            // If we've reached the tail or a node where the key is not less than our search key
            if next == TAIL_INDEX || self._is_key_greater_or_equal_than_node(next, key) {
                return Some(current);
            }

            // Continue moving forward at the current level
            current = next;
        }
    }

    /// should only be called from `sequential_find_position_()`
    fn sequential_find_position_prev_(&self, key: &K, hint_pos: usize) -> Option<usize> {
        let mut current = hint_pos;
        // Traverse current level until we find a node with a key not less than our search key
        // we know the key < hint_pos.key
        loop {
            let prev = self._prev(current);

            // If we've reached the head or a node where the key is not less than our search key
            if self._is_node_less_than_key(prev, key) {
                return Some(prev);
            }

            // Continue moving backward at the current level
            current = prev;
        }
    }

    #[inline(always)]
    /// Emulates the C++ std::map.lower_bound()
    /// Returns a cursor pointing at the first element that is greater or equal than the given key.
    pub fn lower_bound(&self, key: &K) -> Option<Index> {
        let idx = self.lower_bound_(key);
        (idx != TAIL_INDEX).then_some(Index(idx))
    }

    /// Emulates the C++ std::map.lower_bound()
    /// Returns a cursor pointing at the first element that is greater or equal than the given key.
    /// This method will return TAIL_INDEXif nothing is found
    pub(super) fn lower_bound_(&self, key: &K) -> usize {
        if let Some(pos) = self.find_position_(key) {
            // Get the node after the found position
            self._forward_0(pos)
        } else {
            TAIL_INDEX
        }
    }

    #[inline(always)]
    /// Emulates the C++ std::map.upper_bound()
    /// Returns a cursor pointing at the first element in the map whose key is greater than the
    /// given key
    pub fn upper_bound(&self, key: &K) -> Option<Index> {
        let idx = self.upper_bound_(key);
        (idx != TAIL_INDEX).then_some(Index(idx))
    }

    /// Emulates the C++ std::map.upper_bound()
    /// Returns a cursor pointing at the first element in the map whose key is greater than the
    /// given key
    fn upper_bound_(&self, key: &K) -> usize {
        // pos can never be HEAD_INDEX
        let mut pos = self.lower_bound_(key);
        dbg_assert!(pos != HEAD_INDEX);
        while pos != TAIL_INDEX {
            let node = &self.nodes[pos];
            dbg_assert!(node.kv.is_some());

            if !key.is_less_than(node.k()) {
                pos = node.forward[0] // Move forward
            } else {
                break; // Found first node > key
            }
        }
        pos
    }

    #[inline(always)]
    /// Get the next node index (for iterator-like traversal)
    pub fn next_pos(&self, current: Option<Index>) -> Option<Index> {
        self.next_pos_(current?.0).map(Index)
    }

    /// Get the next node index (for iterator-like traversal)
    /// TODO: merge this with ._forward_0()
    pub(super) fn next_pos_(&self, current: usize) -> Option<usize> {
        if current == TAIL_INDEX {
            return None;
        }
        if current == HEAD_INDEX {
            return Some(self.head.forward[0]);
        }

        let next = self.nodes[current].forward[0];
        if next == TAIL_INDEX { None } else { Some(next) }
    }

    #[inline(always)]
    /// Get the previous node index (for bidirectional iterator-like traversal)
    pub fn prev_pos(&self, current: Option<Index>) -> Option<Index> {
        self.prev_pos_(current?.0).map(Index)
    }

    /// Get the previous node index (for bidirectional iterator-like traversal)
    /// TODO: consolidate with _prev()
    pub(super) fn prev_pos_(&self, current: usize) -> Option<usize> {
        if current == HEAD_INDEX {
            return None;
        }

        let prev = self._prev(current);

        if prev == HEAD_INDEX { None } else { Some(prev) }
    }

    pub fn is_pos_valid(&self, index: Option<Index>) -> bool {
        if let Some(Index(index)) = index {
            index < self.nodes.len()
        } else {
            false
        }
    }

    #[inline(always)]
    /// Get the first element (equivalent to begin() in std::map)
    pub fn first(&self) -> Option<Index> {
        self.first_().map(Index)
    }

    #[inline(always)]
    /// Get the first element (equivalent to begin() in std::map)
    pub(super) fn first_(&self) -> Option<usize> {
        let first = self.head.forward[0];
        (first != TAIL_INDEX).then_some(first)
    }

    #[inline(always)]
    /// Get the last element (equivalent to rbegin() in std::map)
    pub fn last(&self) -> Option<Index> {
        self.last_().map(Index)
    }

    #[inline(always)]
    /// Get the last element (equivalent to rbegin() in std::map)
    fn last_(&self) -> Option<usize> {
        let last = self.tail.prev;
        (last != HEAD_INDEX).then_some(last)
    }

    #[inline(always)]
    /// Return true if pointer is at head position or if the list is empty
    pub fn is_at_first(&self, pos: Option<Index>) -> bool {
        pos.map(|x| x.0) == self.first_()
    }

    #[inline(always)]
    /// Return true if pointer is at tail position or if the list is empty
    pub fn is_at_last(&self, pos: Option<Index>) -> bool {
        let last = self.tail.prev;
        match pos {
            Some(idx) => idx.0 == last && last != HEAD_INDEX, // Compare directly
            None => last == HEAD_INDEX,                       // Empty list case
        }
    }

    /// Danger zone: replace the key of a specific node.
    /// This is only supposed to be done on keys that evaluates as identical
    #[inline(always)]
    pub fn change_key_of_node(&mut self, index: Index, new_key: K) -> Result<Index, CppMapError> {
        self.change_key_of_node_(index.0, new_key)
    }

    pub(super) fn change_key_of_node_(
        &mut self,
        index: usize,
        new_key: K,
    ) -> Result<Index, CppMapError> {
        if index == HEAD_INDEX || index == TAIL_INDEX {
            return Err(CppMapError::InvalidIndex);
        }

        match self.nodes.get_mut(index) {
            Some(node) => {
                *node.k_mut() = new_key;
                Ok(Index(index))
            }
            _ => Err(CppMapError::InvalidIndex),
        }
    }

    /// Removes node at current index, updating the index to point to the next valid position
    /// Returns the key-value pair if removal was successful.
    /// Moves cursor current to the old prev value if existed. Else pick old next index.
    pub fn remove_by_index(&mut self, cursor_index: &mut Option<Index>) -> Option<(K, V)> {
        let lookup_index = (*cursor_index)?.0;
        if let Some((key, rank)) = self.get_kr_at_(lookup_index) {
            let skiplist_path = self.find_position_by_rank_with_path_(rank);
            #[cfg(any(test, debug_assertions))]
            {
                let found_index = self.next_pos_(skiplist_path[0]).unwrap();
                #[cfg(feature = "console_debug")]
                if lookup_index != found_index {
                    self.debug_print_ranks();
                }
                assert_eq!(
                    lookup_index, found_index,
                    "was asked to remove index:{lookup_index} but would remove:{found_index}",
                );
            }

            // update cursor_index
            if let Some(prev) = self.prev_pos_(lookup_index).map(Index) {
                *cursor_index = Some(prev)
            } else {
                *cursor_index = self.next_pos_(lookup_index).map(Index)
            };
            self.remove_(&key.clone(), skiplist_path)
        } else {
            None
        }
    }

    #[inline(always)]
    /// Remove a node by key
    /// Returns the value of the removed node if found
    pub fn remove(&mut self, key: &K) -> Option<(K, V)> {
        self.remove_(key, self.find_position_with_path_(key))
    }

    /// Remove a node by key
    /// Returns the value of the removed node if found
    fn remove_(&mut self, key: &K, search_path: Vec<usize>) -> Option<(K, V)> {
        // Get the node that might match our key
        let current = self._forward_0(search_path[0]);

        // Check if we found the node and it matches our key
        if current == TAIL_INDEX {
            return None;
        }

        // Check using C++ std::map equality semantics
        let is_match = self.nodes[current].k().is_equal(key);

        if !is_match {
            return None;
        }

        // Get the node's level and next pointers
        let (level, next_pointers, next) = {
            let node = &self.nodes[current];
            (
                node.forward.len() - 1,
                node.forward.clone(),
                node.forward[0],
            )
        };

        // Update the forward pointers for all nodes in the update vector
        for i in 0..=level {
            if i >= search_path.len() {
                break;
            }

            let update_node = search_path[i];
            match update_node {
                HEAD_INDEX => {
                    let forward = &mut self.head.forward;
                    if i < forward.len() && forward[i] == current {
                        forward[i] = next_pointers[i];
                    }
                }
                TAIL_INDEX => unreachable!(),
                _ => {
                    let node = &mut self.nodes[update_node];
                    if i < node.forward.len() && node.forward[i] == current {
                        node.forward[i] = next_pointers[i];
                    }
                }
            }
        }

        // Update the prev pointer of the next node
        match next {
            TAIL_INDEX => self.tail.prev = search_path[0],
            HEAD_INDEX => panic!("Next node has unexpected type"),
            _ => self.nodes[next].prev = search_path[0],
        }

        // Update current_level if necessary
        while self.current_level > 0 {
            if self.head.forward[self.current_level] == TAIL_INDEX {
                self.current_level -= 1;
            } else {
                break;
            }
        }

        // Extract the value from the node
        match current {
            HEAD_INDEX | TAIL_INDEX => None,
            _ => {
                let node = &mut self.nodes[current];
                let rv = node.kv.take();
                Self::release_index_(current, &mut self.nodes, &mut self.free_index_pool);
                rv
            }
        }
    }

    /// Clear the SkipList
    pub fn clear(&mut self) {
        // Start from the first element after head
        let mut current = self.next_pos_(HEAD_INDEX);

        // Traverse the list and free each node
        while let Some(idx) = current {
            if idx == TAIL_INDEX {
                break;
            }
            let node = &mut self.nodes[idx];
            // Get the next node before we clear the current one
            let next = node.forward[0];
            node.kv = None;

            // Free the node by setting it to None and adding its index to the free pool
            Self::release_index_(idx, &mut self.nodes, &mut self.free_index_pool);

            // Move to the next node
            current = (next != TAIL_INDEX).then_some(next);
        }

        // Reset head and tail nodes without recreating them
        self.head.forward.truncate(self.original_max_level);
        // Reset all forward pointers to point to tail
        self.head.forward.iter_mut().for_each(|x| *x = TAIL_INDEX);

        // Reset prev pointer to point to head
        self.tail.prev = HEAD_INDEX;

        // Reset current level to 0
        self.current_level = 0;
        self.max_level = self.original_max_level;
    }

    #[inline(always)]
    // get a idx from the free pool or create a new one
    // TODO: does this still need to be borrow safe?
    pub(super) fn next_free_index_(
        nodes_len: usize,
        free_id_pool: &mut LinkedList<usize>,
    ) -> usize {
        if let Some(idx) = free_id_pool.pop_front() {
            #[cfg(any(test, debug_assertions))]
            {
                assert_ne!(idx, HEAD_INDEX);
                assert_ne!(idx, TAIL_INDEX);
            }
            idx
        } else {
            nodes_len
        }
    }

    #[inline(always)]
    // put idx into the free pool
    // TODO: does this still need to be borrow safe?
    pub(super) fn release_index_(
        idx: usize,
        _nodes: &mut [SkipNode<K, V>],
        free_id_pool: &mut LinkedList<usize>,
    ) {
        #[cfg(any(test, debug_assertions))]
        {
            assert_ne!(idx, HEAD_INDEX);
            assert_ne!(idx, TAIL_INDEX);
            assert!(_nodes[idx].kv.is_none());
        }
        free_id_pool.push_back(idx);
    }

    #[cfg(any(test, debug_assertions))]
    #[inline(always)]
    // store a node
    // TODO: does this still need to be borrow safe?
    pub(super) fn store_node_(
        new_node: SkipNode<K, V>,
        new_idx: usize,
        nodes: &mut Vec<SkipNode<K, V>>,
    ) {
        #[cfg(any(test, debug_assertions))]
        {
            assert_ne!(new_idx, HEAD_INDEX);
            assert_ne!(new_idx, TAIL_INDEX);
            assert!(new_node.kv.is_some());
        }
        if new_idx < nodes.len() {
            nodes[new_idx] = new_node;
        } else {
            nodes.push(new_node);
        }
    }

    #[cfg(not(any(test, debug_assertions)))]
    #[inline(always)]
    // store a node
    // TODO: does this still need to be borrow safe?
    pub(super) fn store_node_(
        new_node: SkipNode<K, V>,
        new_idx: usize,
        nodes: &mut Vec<SkipNode<K, V>>,
    ) {
        if new_idx < nodes.len() {
            nodes[new_idx] = new_node;
        } else {
            nodes.push(new_node);
        }
    }
}
