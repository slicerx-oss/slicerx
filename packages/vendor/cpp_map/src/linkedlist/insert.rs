use crate::linkedlist::{HEAD_INDEX, Index, LinkedList, ListNode, TAIL_INDEX};
use crate::{CppMapError, IsEqual, IsLessThan};
use std::fmt::Debug;

impl<K, V> LinkedList<K, V>
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
        let rv = Index(self.insert_with_hint_(key, value, hint.0));
        //println!("insert_with_hint key={:?} hint={}, inserted at pos:{}", key_clone, hint, rv.0);
        Ok(rv)
    }

    /// Insert a key-value pair at the specified pos if possible.
    /// Returns the index of the inserted node
    /// Does nothing if that exact key already exists in the list
    pub(super) fn insert_with_hint_(&mut self, key: K, value: V, hint: usize) -> usize {
        if self.is_empty() {
            return self.insert_after_head_(key, value);
        }
        dbg_assert!(hint != TAIL_INDEX);
        #[cfg(feature = "linkedlist_midpoint")]
        let hint = if hint == HEAD_INDEX && self.mid_point.is_some() {
            self.mid_point.unwrap()
        } else {
            hint
        };
        dbg_assert!(hint != TAIL_INDEX);
        dbg_assert!(
            hint == HEAD_INDEX || self.nodes[hint].kv.is_some(),
            "search_hint {} was not active",
            hint
        );

        if let Some(pos) = self.sequential_find_position_before_(&key, hint) {
            if pos == HEAD_INDEX {
                return self.insert_after_head_(key, value);
            }
            return self.insert_after_(key, value, pos);
        }
        unreachable!("hint:{}", hint);
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
        self.insert_with_hint_(key, value, HEAD_INDEX)
    }

    /// Insert a key-value pair
    /// Returns the index of the inserted node
    /// Does nothing if that exact key already exists in the list.
    fn insert_after_head_(&mut self, key: K, value: V) -> usize {
        let next_idx = self.head;
        dbg_assert!(next_idx != HEAD_INDEX);
        self.prepare_node_(key, value, HEAD_INDEX, next_idx)
    }

    /// Insert a key-value pair
    /// Returns the index of the inserted node
    /// Does nothing if that exact key already exists in the list.
    /// This method should not be called with pos=HEAD_INDEX, use insert_after_head_() for that.
    fn insert_after_(&mut self, key: K, value: V, pos: usize) -> usize {
        dbg_assert!(pos != HEAD_INDEX);
        let next_idx = self._forward(pos);
        dbg_assert!(next_idx != HEAD_INDEX);
        self.prepare_node_(key, value, pos, next_idx)
    }

    // Helper function to prepare and initialize a node at a given index.
    // This will be called for all insert() operations.
    #[inline]
    fn prepare_node_(&mut self, key: K, value: V, prev_idx: usize, next_idx: usize) -> usize {
        // Check for duplicate key
        if next_idx != TAIL_INDEX
            && unsafe {
                let node = &self.nodes[next_idx];
                dbg_assert!(node.kv.is_some());
                node.kv.as_ref().unwrap_unchecked().0.is_equal(&key)
            }
        {
            // Just like c++ std::map, do nothing on duplicate keys
            return next_idx;
        }

        #[cfg(feature = "linkedlist_midpoint")]
        let midpoint_less = if let Some(mid_idx) = self.mid_point {
            // Determine if the new node is before or after the midpoint
            unsafe {
                let node = &self.nodes[mid_idx];
                dbg_assert!(node.kv.is_some());
                Some(node.kv.as_ref().unwrap_unchecked().0.is_less_than(&key))
            }
        } else {
            None
        };

        // Create/reuse a node index
        let new_index = self.next_free_index_();

        // Initialize the node content
        if new_index < self.nodes.len() {
            // Reusing an existing node position
            let node = &mut self.nodes[new_index];
            // Reset the node
            node.kv = Some((key, value));
            node.forward = next_idx;
            node.prev = prev_idx;
        } else {
            // Create a new node when there's no free node to reuse
            let new_node = ListNode {
                kv: Some((key, value)),
                forward: next_idx,
                prev: prev_idx,
            };
            self.nodes.push(new_node);
        }

        dbg_assert!(
            self.nodes[new_index].kv.is_some(),
            "new_index {} was not active",
            new_index
        );

        // Update the forward pointer of previous node
        if prev_idx == HEAD_INDEX {
            self.head = new_index;
        } else {
            self.nodes[prev_idx].forward = new_index;
        }

        // Update the prev pointer of the next node
        match next_idx {
            TAIL_INDEX => self.tail = new_index,
            HEAD_INDEX => panic!("Unexpected node type for next node"),
            _ => self.nodes[next_idx].prev = new_index,
        }

        #[cfg(feature = "linkedlist_midpoint")]
        // Update midpoint if needed

        // If we have a midpoint already
        if let Some(mid_idx) = self.mid_point {
            // Determine if the new node is before or after the midpoint
            if midpoint_less.unwrap() {
                dbg_assert!(
                    self.get_k_at_(mid_idx)
                        .unwrap()
                        .is_less_than(self.get_k_at_(new_index).unwrap())
                );
                // Inserted right of mid → right side grows
                self.mid_point_delta += 1;
                // If right side is now too big, move mid right/forward
                if self.mid_point_delta > 1 {
                    // New node is after midpoint, move midpoint forward
                    let next_mid = self._forward(mid_idx);
                    if next_mid != TAIL_INDEX {
                        self.mid_point = Some(next_mid);
                        self.mid_point_delta = 0;
                    }
                    #[cfg(feature = "console_debug")]
                    println!(
                        "new key inserted: {:?}>=mid, move mid to next: new mid={:?},delta:{}",
                        self.get_k_at_(new_index).unwrap(),
                        self.get_k_at_(next_mid).unwrap(),
                        self.mid_point_delta,
                    )
                } else {
                    #[cfg(feature = "console_debug")]
                    println!(
                        "new key inserted: {:?}>=mid, no move:mid={:?},delta:{}",
                        self.get_k_at_(new_index).unwrap(),
                        self.get_k_at_(self.mid_point.unwrap()).unwrap(),
                        self.mid_point_delta,
                    )
                }
            } else {
                dbg_assert!(
                    !self
                        .get_k_at_(mid_idx)
                        .unwrap()
                        .is_less_than(self.get_k_at_(new_index).unwrap())
                );
                // Inserted left of mid → left side grows
                self.mid_point_delta -= 1;

                // If left side is now too big, move mid left
                if self.mid_point_delta < -1 {
                    // New node is before midpoint, move midpoint backward
                    let prev_mid = self._prev(mid_idx);
                    if prev_mid != HEAD_INDEX {
                        self.mid_point = Some(prev_mid);
                        self.mid_point_delta = 0;
                    }
                    #[cfg(feature = "console_debug")]
                    println!(
                        "new key inserted: {:?}<=mid, move mid to prev",
                        self.get_k_at_(new_index).unwrap()
                    )
                } else {
                    #[cfg(feature = "console_debug")]
                    println!(
                        "new key inserted: {:?}<=mid, no change",
                        self.get_k_at_(new_index).unwrap()
                    )
                }
            }
        } else {
            // If no midpoint exists yet, set it to the first real node
            let first_idx = self.head;
            if first_idx != TAIL_INDEX {
                self.mid_point = Some(first_idx);
            } else {
                self.mid_point = Some(new_index)
            }
            self.mid_point_delta = 0;
            #[cfg(feature = "console_debug")]
            println!(
                "new key inserted,new midpoint: {:?}",
                self.get_k_at_(self.mid_point.unwrap())
            )
        }
        new_index
    }
}
