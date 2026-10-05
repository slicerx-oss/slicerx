use crate::prelude::SkipList;
use crate::skiplist::{HEAD_INDEX, Index, SkipNode, TAIL_INDEX};
use crate::{CppMapError, IsEqual, IsLessThan};
use smallvec::smallvec;
use std::fmt::Debug;

impl<K, V> SkipList<K, V>
where
    K: Debug + Clone + IsLessThan,
    V: Debug + Clone,
{
    #[inline(always)]
    /// Insert a key-value pair at the specified pos if possible.
    /// Returns the index of the inserted node
    /// Does nothing if that exact key already exists in the list
    pub fn insert_with_hint(
        &mut self,
        key: K,
        value: V,
        hint: Index,
    ) -> Result<Index, CppMapError> {
        //let key_clone = key.clone();
        let rv = self.insert_with_hint_(key, value, hint)?;
        //println!("insert_with_hint key={:?} hint={}, inserted at pos:{}", key_clone, hint, rv.0);
        Ok(rv)
    }

    /// Insert a key-value pair at the specified pos if possible.
    /// Returns the index of the inserted node
    /// Does nothing if that exact key already exists in the list
    pub(super) fn insert_with_hint_(
        &mut self,
        key: K,
        value: V,
        hint: Index,
    ) -> Result<Index, CppMapError> {
        if self.is_empty() {
            return self.insert(key, value);
        }

        // Get the initial hint position
        if let Some(pos) = self.sequential_find_position_(&key, hint.0) {
            // Short-circuit for head and tail insertion cases
            if pos == HEAD_INDEX {
                return self.insert(key, value);
            }

            // pick up the per thread rng
            return Ok(Index(crate::skiplist::skiplist_impl::THREAD_RNG.with(
                |r| {
                    let mut rng = r.borrow_mut();
                    self.single_pass_search_and_insert_(key, value, pos, &mut rng)
                },
            )));
        }

        // Fall back to standard insert if hint isn't helpful
        Ok(Index(self.insert_(key, value)))
    }

    /// single-pass function that creates and inserts the node during initial traversal
    fn single_pass_search_and_insert_(
        &mut self,
        key: K,
        value: V,
        hint_pos: usize,
        rng: &mut crate::skiplist::skiplist_impl::Level,
    ) -> usize {
        // Target rank for insertion - use rank between hint node and next node
        let target_rank = if hint_pos == TAIL_INDEX {
            self.tail.rank
        } else {
            self.nodes[hint_pos].rank + 1
        };

        // Generate a random level for the new node early
        let new_level = self.random_level(rng);

        // Update current_level if necessary
        let current_level = self.current_level;
        if new_level > current_level {
            self.current_level = new_level;
        }

        // Create/reuse a node index immediately
        let new_index = Self::next_free_index_(self.nodes.len(), &mut self.free_index_pool);

        // We'll need a list to store the connections to rewire
        // Each entry contains (node_index, level) pairs that point to our successor
        let mut connections: Vec<(usize, usize)> = Vec::with_capacity(new_level + 1);
        let mut prev_at_level_zero = HEAD_INDEX;

        // Traverse the skiplist to find the insertion point
        let mut current = HEAD_INDEX;

        // Start from the highest level and work down
        for level in (0..=self.current_level).rev() {
            // Traverse current level until we find node with rank not less than target
            loop {
                let next = self._forward(current, level);

                // If we've reached the tail or a node where the rank is not less than our target
                if next == TAIL_INDEX || self.nodes[next].rank >= target_rank {
                    // Found our insertion point at this level
                    if level <= new_level {
                        // Store this connection to rewire later
                        connections.push((current, level));
                    }

                    // Save level 0 predecessor for the rank calculation
                    if level == 0 {
                        prev_at_level_zero = current;
                    }

                    break;
                }

                // Continue moving forward at the current level
                current = next;
            }
        }

        // Now we have our insertion point, check for duplicate keys
        let next_idx = self._forward_0(prev_at_level_zero);
        dbg_assert!(next_idx != HEAD_INDEX);

        if next_idx != TAIL_INDEX && self.nodes[next_idx].k().is_equal(&key) {
            // Just like c++ std::map, do nothing on duplicate keys
            return next_idx;
        }

        // Calculate the true rank for the new node
        let (new_rank, is_congested) = self.get_rank_in_between(prev_at_level_zero, next_idx);
        if is_congested {
            self.is_congested = true;
        }

        // Create the new node with forward pointers to our successors
        let forward_pointers = smallvec![TAIL_INDEX; new_level + 1];

        // Initialize the node
        if new_index == self.nodes.len() {
            // Create and insert a new node
            let new_node = SkipNode {
                kv: Some((key, value)),
                forward: forward_pointers, // We'll update this shortly
                prev: prev_at_level_zero,
                rank: new_rank,
            };
            Self::store_node_(new_node, new_index, &mut self.nodes);
        } else {
            // Reuse a node
            let node = &mut self.nodes[new_index];
            node.forward = forward_pointers; // We'll update this shortly
            node.kv = Some((key, value));
            node.prev = prev_at_level_zero;
            node.rank = new_rank;
        }

        // Rewire the connections
        for (node_idx, level) in connections {
            // Get the next node at this level before we modify pointers
            let next_at_level = self._forward(node_idx, level);

            // Update the predecessor to point to our new node
            match node_idx {
                HEAD_INDEX => self.head.forward[level] = new_index,
                TAIL_INDEX => panic!("Unexpected node type in insert update"),
                _ => {
                    let node = &mut self.nodes[node_idx];
                    if level < node.forward.len() {
                        node.forward[level] = new_index;
                    }
                }
            }

            // Update the new node's forward pointer at this level
            match new_index {
                HEAD_INDEX | TAIL_INDEX => panic!("Unexpected node type at new_index"),
                _ => self.nodes[new_index].forward[level] = next_at_level,
            }
        }

        // Update the prev pointer of the next node
        match next_idx {
            TAIL_INDEX => self.tail.prev = new_index,
            HEAD_INDEX => panic!("Unexpected node type for next node"),
            _ => self.nodes[next_idx].prev = new_index,
        }

        self.maybe_adjust_max_level(rng);
        if self.is_congested {
            self.rebalance_ranks();
        }
        new_index
    }

    #[inline(always)]
    /// Insert a key-value pair
    /// Returns the index of the inserted node
    /// Does nothing if that exact key already exists in the list
    pub fn insert(&mut self, key: K, value: V) -> Result<Index, CppMapError> {
        Ok(Index(self.insert_(key, value)))
    }

    #[inline(always)]
    /// Insert a key-value pair
    /// Returns the index of the inserted node
    /// Does nothing if that exact key already exists in the list
    fn insert_(&mut self, key: K, value: V) -> usize {
        let path = self.find_position_with_path_(&key);
        //let found_pos = path[0];
        self.insert_with_path_(key, value, path)
        //println!("normal insert. found pos={}, inserted_at:{}", found_pos, inserted_at);
    }

    #[inline(always)]
    /// Insert a key-value pair
    /// Returns the index of the inserted node
    /// Does nothing if that exact key already exists in the list
    fn insert_with_path_(&mut self, key: K, value: V, path: Vec<usize>) -> usize {
        // pick up the per thread rng
        crate::skiplist::skiplist_impl::THREAD_RNG.with(|r| {
            let mut rng = r.borrow_mut();
            self.insert_with_path_and_rng_(key, value, path, &mut rng)
        })
    }

    fn insert_with_path_and_rng_(
        &mut self,
        key: K,
        value: V,
        mut path: Vec<usize>,
        rng: &mut crate::skiplist::skiplist_impl::Level,
    ) -> usize {
        let next_idx = self._forward_0(path[0]);
        dbg_assert!(next_idx != HEAD_INDEX);

        if next_idx != TAIL_INDEX && self.nodes[next_idx].k().is_equal(&key) {
            // Just like c++ std::map, do nothing on duplicate keys
            return next_idx;
        }

        // Generate a random level for the new node
        let level = self.random_level(rng);

        // Update current_level if necessary
        #[allow(clippy::needless_range_loop)]
        if level > self.current_level {
            for i in (self.current_level + 1)..=level {
                path[i] = HEAD_INDEX;
            }
            self.current_level = level;
        }

        // Create/reuse a node index
        let new_index = Self::next_free_index_(self.nodes.len(), &mut self.free_index_pool);

        // Find the prev and next nodes at level 0
        let prev = path[0];
        let next = self._forward_0(prev);
        let (new_rank, is_congested) = self.get_rank_in_between(prev, next);
        if is_congested {
            self.is_congested = true;
        }

        if new_index == self.nodes.len() {
            // Create and insert a new node
            let new_node = SkipNode {
                kv: Some((key, value)),
                forward: smallvec![TAIL_INDEX; level + 1],
                prev,
                rank: new_rank,
            };
            Self::store_node_(new_node, new_index, &mut self.nodes);
        } else {
            // reuse a node
            let node = &mut self.nodes[new_index];
            // todo! should we try to re-use the existing smallvec instead?
            node.forward = smallvec![TAIL_INDEX; level + 1];
            node.kv = Some((key, value));
            node.prev = prev;
            node.rank = new_rank;
        }

        // Update the forward pointers of all nodes in the update vector
        #[allow(clippy::needless_range_loop)]
        for i in 0..=level {
            let update_node = path[i];
            let next_at_level = self._forward(update_node, i);

            // Update the update_node to point to new_index
            match update_node {
                HEAD_INDEX => self.head.forward[i] = new_index,
                TAIL_INDEX => panic!("Unexpected node type in insert update"),
                _ => {
                    let node = &mut self.nodes[update_node];
                    if i < node.forward.len() {
                        node.forward[i] = new_index;
                    }
                }
            }

            // Update the new node's forward pointer at this level
            match new_index {
                HEAD_INDEX | TAIL_INDEX => panic!("Unexpected node type at new_index"),
                _ => self.nodes[new_index].forward[i] = next_at_level,
            }
        }

        // Update the prev pointer of the next node
        match next {
            TAIL_INDEX => self.tail.prev = new_index,
            HEAD_INDEX => panic!("Unexpected node type for next node"),
            _ => self.nodes[next].prev = new_index,
        }

        self.maybe_adjust_max_level(rng);
        if self.is_congested {
            self.rebalance_ranks();
        }
        new_index
    }
}
