// SPDX-License-Identifier: MIT OR Apache-2.0

// Copyright 2025 Eadf (github.com/eadf)
// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

use crate::IsLessThan;
use crate::prelude::SkipList;
use crate::skiplist::{HEAD_INDEX, SkipNode, TAIL_INDEX};
use std::fmt::Debug;

impl<K, V> SkipList<K, V>
where
    K: Debug + Clone + IsLessThan,
    V: Debug + Clone,
{
    pub(super) fn get_rank_in_between(&self, current_idx: usize, next_idx: usize) -> (i64, bool) {
        if current_idx == HEAD_INDEX && next_idx == TAIL_INDEX {
            return (0, false);
        }
        let current_rank = match current_idx {
            HEAD_INDEX => self.head.rank,
            TAIL_INDEX => unreachable!(),
            _ => self.nodes[current_idx].rank,
        };
        let next_rank = match next_idx {
            HEAD_INDEX => unreachable!(),
            TAIL_INDEX => self.tail.rank,
            _ => self.nodes[next_idx].rank,
        };

        get_rank_between(current_rank, next_rank)
    }

    /// rebalance the ranks of the nodes, they should keep their relative position
    pub(super) fn rebalance_ranks(&mut self) {
        // Skip if empty or only one element
        if self.len() < 2 {
            self.is_congested = false;
            return;
        }

        // Step 2: Calculate new ranks with even distribution between: -i64::MAX/2..i64::MAX/2
        let rank_step = i64::MAX / (self.len() as i64);

        //println!("rank_step:{}, self.len():{} self.nodes.len():{}",rank_step, self.len(), self.nodes.len());

        let mut current_rank: i64 = (-i64::MAX / 2).saturating_add(1);

        //println!("starting rank:{:?}", current_rank);
        if let Some(mut idx) = self.first_() {
            while idx != TAIL_INDEX {
                if let Some(SkipNode { rank, forward, .. }) = self.nodes.get_mut(idx) {
                    // Update the node's key with the new rank
                    *rank = current_rank;

                    // Calculate new rank
                    current_rank += rank_step;
                    idx = forward[0];
                } else {
                    // should not really happen
                    break;
                }
            }
        }

        //println!("end rank:{:?}", current_rank-rank_step);

        // Reset congestion flag
        self.is_congested = false;
        #[cfg(feature = "console_debug")]
        {
            println!("new ranks");
            self.debug_print_ranks();
            println!("end new ranks");
        }
    }

    /// Find the position of a node key using only rank comparisons.
    /// Returns the search path for insertion
    pub(super) fn find_position_by_rank_with_path_(&self, rank: i64) -> Vec<usize> {
        let mut update = vec![HEAD_INDEX; self.max_level];
        let mut current = HEAD_INDEX;

        // Start from the highest level and work down
        for level in (0..=self.current_level).rev() {
            // Traverse current level until we find a node with a key not less than our search key
            loop {
                let next = self._forward(current, level);

                // If we've reached the tail or a node where the key is not less than our search key
                if next == TAIL_INDEX || self.nodes[next].rank >= rank {
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

    #[cfg(feature = "console_debug")]
    /// Print the SkipList in a visual tabulated format for debugging
    pub(super) fn debug_print_ranks(&self) {
        let mut cursor = self.first();
        while cursor.is_some() {
            let node = &self.nodes[cursor.unwrap().0];
            print!(
                "[index:{}, rank:{}, key:{:?}, val:{:?}]",
                cursor.unwrap().0,
                node.rank,
                node.k(),
                node.v()
            );

            cursor = self.next_pos(cursor);
            if cursor.is_some() {
                println!(",");
            }
        }
        println!();
    }
}

/// returns the median, and a flag indicating if it's time to re-rebalance the ranks.
#[inline(always)]
pub(super) fn get_rank_between(prev: i64, next: i64) -> (i64, bool) {
    dbg_assert!(prev < next, "prev:{} next:{}", prev, next);

    // Branchless median calculation using wrapping operations
    let half_sum = (prev >> 1).wrapping_add(next >> 1);

    // Handle remainder adjustment
    let remainder_adjustment = ((prev & 1).wrapping_add(next & 1)) >> 1;
    let mid = half_sum.wrapping_add(remainder_adjustment);
    dbg_assert!(mid > prev, "prev:{} <! mid:{} next:{}", prev, mid, next);
    dbg_assert!(mid < next, "prev:{} mid:{} <! next:{}", prev, mid, next);

    const THRESHOLD: i64 = 6;
    //println!("prev:{} mid:{}, next:{}", prev, next, next);
    let dist_to_prev = mid - prev;
    let dist_to_next = next - mid;

    (mid, dist_to_prev < THRESHOLD || dist_to_next < THRESHOLD)
}
