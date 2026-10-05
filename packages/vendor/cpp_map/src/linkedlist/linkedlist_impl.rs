// SPDX-License-Identifier: MIT OR Apache-2.0

// Copyright 2025 Eadf (github.com/eadf)
// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

use crate::linkedlist::{HEAD_INDEX, Index, LinkedList, ListNode, TAIL_INDEX};
use crate::{CppMapError, IsLessThan};
use std::collections::LinkedList as StdLinkedList;
use std::fmt::Debug;

impl<K, V> LinkedList<K, V>
where
    K: Debug + Clone + IsLessThan,
    V: Debug + Clone,
{
    #[inline(always)]
    /// Get the number of elements in the LinkedList
    pub fn len(&self) -> usize {
        self.nodes.len().saturating_sub(self.free_index_pool.len())
    }

    #[inline(always)]
    /// Check if the LinkedList is empty
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    #[inline(always)]
    pub(super) fn _forward(&self, index: usize) -> usize {
        match index {
            HEAD_INDEX => {
                dbg_assert!(
                    self.nodes[self.head].kv.is_some(),
                    "self.head {} was not active",
                    self.head
                );
                self.head
            }
            TAIL_INDEX => TAIL_INDEX,
            _ => {
                dbg_assert!(
                    self.nodes[index].kv.is_some(),
                    "Index {} was not active",
                    index
                );
                self.nodes[index].forward
            }
        }
    }

    #[inline(always)]
    pub(super) fn _prev(&self, index: usize) -> usize {
        match index {
            HEAD_INDEX => HEAD_INDEX,
            TAIL_INDEX => {
                dbg_assert!(
                    self.nodes[self.tail].kv.is_some(),
                    "self.tail {} was not active",
                    self.tail
                );
                self.tail
            }
            _ => {
                dbg_assert!(
                    self.nodes[index].kv.is_some(),
                    "Index {} was not active",
                    index
                );
                self.nodes[index].prev
            }
        }
    }

    // todo: this is simply !_is_node_less_than_key()
    #[inline(always)]
    fn _is_key_greater_or_equal_than_node(&self, index: usize, key: &K) -> bool {
        match index {
            HEAD_INDEX => true,
            TAIL_INDEX => false,
            _ => {
                dbg_assert!(
                    self.nodes[index].kv.is_some(),
                    "Index {} was not active",
                    index
                );
                dbg_assert!(self.nodes[index].kv.is_some());
                unsafe {
                    !self
                        .nodes
                        .get_unchecked(index)
                        .kv
                        .as_ref()
                        .unwrap_unchecked()
                        .0
                        .is_less_than(key)
                }
            }
        }
    }

    #[inline(always)]
    fn _is_key_less_than_node(&self, index: usize, key: &K) -> bool {
        match index {
            HEAD_INDEX => false,
            TAIL_INDEX => true,
            _ => {
                dbg_assert!(
                    self.nodes[index].kv.is_some(),
                    "Index {} was not active",
                    index
                );
                dbg_assert!(self.nodes[index].kv.is_some());
                unsafe { key.is_less_than(&self.nodes[index].kv.as_ref().unwrap_unchecked().0) }
            }
        }
    }

    #[inline(always)]
    fn _is_node_less_than_key(&self, index: usize, key: &K) -> bool {
        match index {
            HEAD_INDEX => true,
            TAIL_INDEX => false,
            _ => {
                dbg_assert!(
                    self.nodes[index].kv.is_some(),
                    "Index {} was not active",
                    index
                );
                dbg_assert!(self.nodes[index].kv.is_some());
                unsafe {
                    self.nodes[index]
                        .kv
                        .as_ref()
                        .unwrap_unchecked()
                        .0
                        .is_less_than(key)
                }
            }
        }
    }

    /// Find the position of a key using only less-than operations
    /// Returns index of the node just before where the key would be
    /// along with the update vector for insertion
    fn find_position_(&self, key: &K) -> Option<usize> {
        self.sequential_find_position_before_(key, HEAD_INDEX)
    }

    #[cfg(any(test, debug_assertions))]
    pub fn sequential_find_position(&self, key: &K, hint_position: Index) -> Option<Index> {
        self.sequential_find_position_before_(key, hint_position.0)
            .map(Index)
    }

    /// Find the position of a key using only less-than operations.
    /// Returns index of the node just before where the new key should be inserted
    pub(super) fn sequential_find_position_before_(
        &self,
        key: &K,
        hint_pos: usize,
    ) -> Option<usize> {
        dbg_assert!(
            hint_pos == HEAD_INDEX || self.nodes[hint_pos].kv.is_some(),
            "hint_pos {} was not active",
            hint_pos
        );
        if hint_pos == HEAD_INDEX {
            return self.sequential_find_position_next_(key, hint_pos);
        }
        if let Some(hint_k) = self.get_k_at_(hint_pos) {
            if hint_k.is_less_than(key) {
                // search towards tail
                self.sequential_find_position_next_(key, hint_pos)
            } else if key.is_less_than(hint_k) {
                // search towards head
                self.sequential_find_position_prev_(key, hint_pos)
            } else {
                self.prev_pos_(hint_pos)
            }
        } else {
            None
        }
    }

    /// should only be called from `sequential_find_position_()`
    fn sequential_find_position_next_(&self, key: &K, hint_pos: usize) -> Option<usize> {
        dbg_assert!(
            hint_pos == HEAD_INDEX || self.nodes[hint_pos].kv.is_some(),
            "hint_pos {} was not active",
            hint_pos
        );
        let mut current = hint_pos;
        // Start from the hint position and work towards the tail
        // until we find a node that is !(next.key < key)
        // we know the hint_pos.key < key
        loop {
            let next = self._forward(current);
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

    #[inline(always)]
    /// Emulates the C++ std::map.lower_bound()
    /// Returns a cursor pointing at the first element that is greater or equal than the given key.
    /// This method will return TAIL_INDEXif nothing is found
    pub(super) fn lower_bound_(&self, key: &K) -> usize {
        if let Some(pos) = self.find_position_(key) {
            // Get the node after the found position
            self._forward(pos)
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

            unsafe {
                if !key.is_less_than(&node.kv.as_ref().unwrap_unchecked().0) {
                    pos = node.forward // Move forward
                } else {
                    break; // Found first node > key
                }
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
            return Some(self.head);
        }

        let next = self.nodes[current].forward;
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
        let first = self.head;
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
        let last = self.tail;
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
        let last = self.tail;
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
            Some(ListNode {
                kv: Some((k, _)), ..
            }) => {
                *k = new_key;
                Ok(Index(index))
            }
            _ => Err(CppMapError::InvalidIndex),
        }
    }

    #[inline(always)]
    // get an idx from the free pool or create a new one
    pub(super) fn next_free_index_(&mut self) -> usize {
        if let Some(idx) = self.free_index_pool.pop_front() {
            #[cfg(any(test, debug_assertions))]
            {
                assert_ne!(idx, HEAD_INDEX);
                assert_ne!(idx, TAIL_INDEX);
            }
            idx
        } else {
            self.nodes.len()
        }
    }

    // put idx into the free pool
    #[inline(always)]
    pub(super) fn release_index_(
        idx: usize,
        _nodes: &mut [ListNode<K, V>],
        free_id_pool: &mut StdLinkedList<usize>,
    ) {
        #[cfg(any(test, debug_assertions))]
        {
            assert_ne!(idx, HEAD_INDEX);
            assert_ne!(idx, TAIL_INDEX);
            assert!(_nodes[idx].kv.is_none());
        }
        free_id_pool.push_back(idx);
    }
}
