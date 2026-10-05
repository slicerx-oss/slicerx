// SPDX-License-Identifier: MIT OR Apache-2.0

// Copyright 2021, 2025 Eadf (github.com/eadf)
// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

use crate::IsLessThan;
use crate::skiplist::{HEAD_INDEX, SkipList, SkipNode, TAIL_INDEX};
use std::fmt::Debug;
use std::marker::PhantomData;

type PhantomType<K, V> = PhantomData<fn(K, V) -> (K, V)>;

/// Structure to hold all the needed updates for node extension
struct NodeExtensionUpdate<K, V>
where
    K: Debug + Clone + IsLessThan,
    V: Debug + Clone,
{
    node_idx: usize,
    new_levels: Vec<(usize, usize)>, // (level, next_idx) pairs to add to the node's forward vector
    pointer_updates: Vec<(usize, usize, usize)>, // (node_idx, level, new_next) to update other nodes' pointers
    new_current_level: Option<usize>,            // New current_level if it needs to be updated
    _pd: PhantomType<K, V>,
}

impl<K, V> SkipList<K, V>
where
    K: Debug + Clone + IsLessThan,
    V: Debug + Clone,
{
    /// Two-phase approach to extend a node's level while satisfying the borrow checker
    pub(super) fn extend_node_level(
        &mut self,
        node_idx: usize,
        current_node_level: usize,
        rng: &mut crate::skiplist::skiplist_impl::Level,
    ) {
        // Phase 1: Calculate all the updates without modifying the nodes
        // This collects all information about what needs to be changed
        let updates = self.calculate_node_extension(node_idx, current_node_level, rng);

        // Phase 2: Apply the collected updates
        self.apply_node_extension(updates);
    }

    /// Phase 1: Calculate all the updates needed without modifying nodes
    fn calculate_node_extension(
        &self,
        node_idx: usize,
        current_node_level: usize,
        rng: &mut crate::skiplist::skiplist_impl::Level,
    ) -> NodeExtensionUpdate<K, V> {
        let mut update = NodeExtensionUpdate {
            node_idx,
            new_levels: Vec::new(),
            pointer_updates: Vec::new(),
            new_current_level: None,
            _pd: PhantomData,
        };

        // Don't proceed if we're already at max_level
        if current_node_level >= self.max_level {
            return update;
        }

        let mut level = current_node_level;

        // Get the node's key (we need it for comparison)
        let node_key = if node_idx != HEAD_INDEX && node_idx != TAIL_INDEX {
            self.nodes[node_idx].k()
        } else {
            return update; // Not a normal node, nothing to do
        };

        // Perform coin tosses to determine if this node should extend to higher levels
        while level < self.max_level && self.coin_flip(rng, level) {
            level += 1;

            // Find where this node should be placed at the new level
            let mut update_positions = vec![HEAD_INDEX; self.max_level];
            let mut x = HEAD_INDEX;

            // Find the insertion position at the new level
            for i in (0..level).rev() {
                // Skip levels we've already processed
                if i < current_node_level {
                    break;
                }

                // Move forward as long as the next key is less than our key
                loop {
                    let next_idx = self._forward(x, i);

                    if next_idx == TAIL_INDEX {
                        break;
                    }

                    if next_idx != HEAD_INDEX
                        && next_idx != TAIL_INDEX
                        && !self.nodes[next_idx].k().is_less_than(node_key)
                    {
                        break;
                    }

                    x = next_idx;
                }

                update_positions[i] = x;
            }

            // Get the node that should come after this node at the new level
            let next_at_level = {
                let id = update_positions[level - 1];
                if id == HEAD_INDEX {
                    self.head.forward[level - 1]
                } else if id == TAIL_INDEX {
                    TAIL_INDEX
                } else {
                    self.nodes[id].forward[level - 1]
                }
            };

            // Record the new level to add to this node's forward vector
            update.new_levels.push((level - 1, next_at_level));

            // Record pointer update for the previous node
            update
                .pointer_updates
                .push((update_positions[level - 1], level - 1, node_idx));

            // Update current_level if needed
            if level > self.current_level {
                update.new_current_level = Some(level);
            }
        }

        update
    }

    /// Phase 2: Apply the calculated updates to the nodes
    fn apply_node_extension(&mut self, update: NodeExtensionUpdate<K, V>) {
        // Extend the node's forward vector with new levels
        if let Some(SkipNode { forward, .. }) = &mut self.nodes.get_mut(update.node_idx) {
            for (level, next_idx) in update.new_levels {
                // Make sure the forward vector is large enough
                while forward.len() <= level {
                    forward.push(TAIL_INDEX);
                }
                forward[level] = next_idx;
            }
        }

        // Update pointers from other nodes
        for (prev_idx, level, new_next) in update.pointer_updates {
            if prev_idx == HEAD_INDEX {
                if level < self.head.forward.len() {
                    self.head.forward[level] = new_next;
                }
            } else {
                let forward = &mut self.nodes[prev_idx].forward;
                if level < forward.len() {
                    forward[level] = new_next;
                }
            }
        }

        // Update current_level if needed
        if let Some(new_level) = update.new_current_level {
            if new_level > self.current_level {
                self.current_level = new_level;
            }
        }
    }

    /// Adjust max_level based on the current size of the skip list
    /// Should be called after each insert operation
    pub(super) fn adjust_max_level(&mut self, rng: &mut crate::skiplist::skiplist_impl::Level) {
        // Calculate ideal max level based on list size
        // Common formula: log₂(n)
        let node_count = self.len();
        let ideal_max_level = (node_count as f64).log2().ceil() as usize;

        // Don't decrease max_level, only increase it if needed
        if ideal_max_level <= self.max_level {
            return;
        }

        // Calculate how many new levels we need to add
        let levels_to_add = ideal_max_level - self.max_level;
        let old_max_level = self.max_level;
        self.max_level = ideal_max_level;

        // Extend head's forward vector
        self.head.forward.extend(vec![TAIL_INDEX; levels_to_add]);

        // First phase: Collect all candidate nodes that need to be extended
        let mut candidates = Vec::new();

        // Handle case where we need to add multiple levels
        for level_diff in 1..=levels_to_add {
            let check_level = old_max_level - level_diff;
            // Don't go below level 0
            if check_level == 0 {
                break;
            }

            let candidate_node = self.head.forward[check_level - 1];

            // If head points directly to a node (not tail) at this level
            if candidate_node != TAIL_INDEX {
                candidates.push((candidate_node, old_max_level - level_diff + 1));
            }
        }

        // Second phase: Extend each candidate node
        for (node_idx, current_level) in candidates {
            self.extend_node_level(node_idx, current_level, rng);
        }
    }

    #[inline(always)]
    /// Function to be called after each insert operation
    pub(super) fn maybe_adjust_max_level(&mut self, rng: &mut crate::skiplist::skiplist_impl::Level) {
        // This wrapper function can be called after every insert
        // It will check if max_level needs adjustment and perform it if necessary
        self.adjust_max_level(rng);
    }

    #[inline(always)]
    pub fn current_level(&self) -> usize {
        self.current_level
    }

    #[inline(always)]
    pub fn max_level(&self) -> usize {
        self.max_level
    }
}
