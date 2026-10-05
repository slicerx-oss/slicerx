use crate::linkedlist::{HEAD_INDEX, Index, LinkedList, TAIL_INDEX};
use crate::{IsEqual, IsLessThan};
use std::fmt::Debug;

impl<K, V> LinkedList<K, V>
where
    K: Debug + Clone + IsLessThan,
    V: Debug + Clone,
{
    /// Removes node at current index, updating the index to point to the next valid position
    /// Returns the key-value pair if removal was successful.
    /// Moves cursor current to the old prev value if existed. Else pick old next index.
    pub fn remove_by_index(&mut self, cursor_index: &mut Option<Index>) -> Option<(K, V)> {
        let lookup_index = (*cursor_index)?.0;
        let prev = self._prev(lookup_index);
        if prev == HEAD_INDEX {
            *cursor_index = Some(Index(self._forward(lookup_index)))
        } else {
            *cursor_index = Some(Index(prev));
        }

        self.remove_at_(lookup_index)
    }

    #[inline(always)]
    /// Remove a node by key
    /// Returns the value of the removed node if found
    pub fn remove(&mut self, key: &K) -> Option<(K, V)> {
        if let Some(pos) = self.sequential_find_position_before_(key, HEAD_INDEX) {
            let index = self._forward(pos);
            if unsafe {
                let node = &self.nodes[index];
                dbg_assert!(node.kv.is_some());
                node.kv.as_ref().unwrap_unchecked().0.is_equal(key)
            } {
                return self.remove_at_(index);
            }
        }
        None
    }

    /// Remove a node by key
    /// Returns the value of the removed node if found
    fn remove_at_(&mut self, index: usize) -> Option<(K, V)> {
        #[cfg(feature = "linkedlist_midpoint")]
        let is_midpoint = self.mid_point == Some(index);

        let prev_pos = self._prev(index);
        let next_pos = self.nodes[index].forward;

        if prev_pos == HEAD_INDEX {
            self.head = next_pos;
        } else {
            self.nodes[prev_pos].forward = next_pos;
        }
        if next_pos == TAIL_INDEX {
            self.tail = prev_pos;
        } else {
            self.nodes[next_pos].prev = prev_pos;
        }
        let rv = unsafe {
            let kv = self.nodes[index].kv.take();
            dbg_assert!(kv.is_some());
            kv.unwrap_unchecked()
        };

        Self::release_index_(index, &mut self.nodes, &mut self.free_index_pool);

        #[cfg(feature = "linkedlist_midpoint")]
        // Update midpoint if needed
        // Case 1: List is now empty
        if self.is_empty() {
            self.mid_point = None;
            self.mid_point_delta = 0;
        }
        // Case 2: The removed node was the midpoint
        else if is_midpoint {
            // We need to select a new midpoint
            if next_pos != TAIL_INDEX && prev_pos == HEAD_INDEX {
                // If prev is the head, we can only move right
                self.mid_point = Some(next_pos);
                self.mid_point_delta -= 1;
                #[cfg(feature = "console_debug")]
                println!(
                    "mid node {:?} removed, new mid:{:?},#{}, ",
                    rv.0,
                    self.get_k_at_(next_pos).unwrap(),
                    next_pos
                );
            } else if prev_pos != HEAD_INDEX && next_pos == TAIL_INDEX {
                // If next is the tail, we can only move left
                self.mid_point = Some(prev_pos);
                self.mid_point_delta += 1;
                #[cfg(feature = "console_debug")]
                println!(
                    "mid node {:?} removed, new mid:{:?},#{}, ",
                    rv.0,
                    self.get_k_at_(prev_pos).unwrap(),
                    prev_pos
                );
            } else if prev_pos != HEAD_INDEX && next_pos != TAIL_INDEX {
                // Both directions are available, choose based on balancing the list
                if self.mid_point_delta < 0 {
                    // List is right-heavy, prefer moving left to balance
                    self.mid_point = Some(prev_pos);
                    self.mid_point_delta += 1;
                    #[cfg(feature = "console_debug")]
                    println!(
                        "mid node {:?} removed, list was right-heavy, new mid:{:?},#{}, ",
                        rv.0,
                        self.get_k_at_(prev_pos).unwrap(),
                        prev_pos
                    );
                } else {
                    // List is balanced or left-heavy, prefer moving right
                    self.mid_point = Some(next_pos);
                    self.mid_point_delta -= 1;
                    #[cfg(feature = "console_debug")]
                    println!(
                        "mid node {:?} removed, list was balanced/left-heavy, new mid:{:?},#{}, ",
                        rv.0,
                        self.get_k_at_(next_pos).unwrap(),
                        next_pos
                    );
                }
            } else {
                // Fallback - this should rarely happen if the implementation is correct
                self.mid_point = None;
                self.mid_point_delta = 0;
            }
        }
        // Case 3: The removed node affects the balance but wasn't the midpoint
        else if let Some(mid_idx) = self.mid_point {
            // Use key comparison to determine if the deleted node was before or after midpoint
            let mid_key = unsafe {
                let node = &self.nodes[mid_idx];
                dbg_assert!(node.kv.is_some());
                &node.kv.as_ref().unwrap_unchecked().0
            };

            if mid_key.is_less_than(&rv.0) {
                // The deleted node was after the midpoint (right side contracted)
                self.mid_point_delta -= 1;

                // If delta is too negative, we need to move midpoint left
                if self.mid_point_delta < -1 {
                    let prev_mid = self.nodes[mid_idx].prev;
                    if prev_mid != HEAD_INDEX {
                        self.mid_point = Some(prev_mid);
                        // Don't reset delta, just adjust it
                        // Moving left should increase delta by 1
                        self.mid_point_delta += 2;
                        #[cfg(feature = "console_debug")]
                        println!(
                            "node {:?} removed, old mid was less. moved mid to prev:{:?},#{}, ",
                            rv.0,
                            self.get_k_at_(prev_mid).unwrap(),
                            prev_mid
                        );
                    }
                }
            } else {
                // The deleted node was before the midpoint (left side contracted)
                self.mid_point_delta += 1;

                // If delta is too positive, we need to move midpoint right
                if self.mid_point_delta > 1 {
                    let next_mid = self.nodes[mid_idx].forward;
                    if next_mid != TAIL_INDEX {
                        self.mid_point = Some(next_mid);
                        // Don't reset delta, just adjust it
                        // Moving right should decrease delta by 1
                        self.mid_point_delta -= 2;
                        #[cfg(feature = "console_debug")]
                        println!(
                            "node {:?} removed, old mid was greater. moved mid to next:{:?},#{} ",
                            rv.0,
                            self.get_k_at_(next_mid).unwrap(),
                            next_mid
                        );
                    }
                }
            }
        }
        Some(rv)
    }

    /// Clear the LinkedList
    pub fn clear(&mut self) {
        // Start from the first element after head
        let mut current = self.next_pos_(HEAD_INDEX);

        // Traverse the list and free each node
        while let Some(idx) = current {
            if idx == TAIL_INDEX {
                break;
            }
            // Get the next node before we clear the current one
            let next = self.next_pos_(idx);
            self.nodes[idx].kv = None;

            // Free the node by setting it to None and adding its index to the free pool
            Self::release_index_(idx, &mut self.nodes, &mut self.free_index_pool);

            // Move to the next node
            current = next;
        }

        // Reset head and tail nodes without recreating them
        self.head = TAIL_INDEX;

        // Reset prev pointer to point to head
        self.tail = HEAD_INDEX;
        #[cfg(feature = "linkedlist_midpoint")]
        {
            self.mid_point = None;
        }
    }
}
