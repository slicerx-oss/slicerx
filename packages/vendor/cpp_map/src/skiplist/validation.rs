use crate::IsLessThan;
use crate::prelude::SkipList;
use crate::skiplist::{HEAD_INDEX, TAIL_INDEX};
use std::fmt::{Debug, Display};

impl<K, V> SkipList<K, V>
where
    K: Debug + Display + Clone + IsLessThan,
    V: Debug + Clone,
{
    pub fn validate(&self) {
        // Check ordering between nodes
        self.validate_ordering();
        self.assert_is_in_order();
        // Check forward pointers at each level
        for level in (0..=self.max_level).rev() {
            self.validate_level(level);
        }
    }

    fn validate_ordering(&self) {
        let mut prev_index = HEAD_INDEX;
        let mut current_index = if !self.head.forward.is_empty() {
            self.head.forward[0]
        } else {
            TAIL_INDEX
        };

        while current_index != TAIL_INDEX {
            let current_node = &self.nodes[current_index];
            assert!(current_node.kv.is_some());
            // Check prev pointer is consistent
            assert_eq!(
                current_node.prev,
                prev_index,
                "Node {:?} has incorrect prev pointer. Expected {:?}, got {:?}",
                current_node.kv.as_ref().unwrap().0,
                prev_index,
                current_node.prev
            );

            // Check ordering between current and previous node
            if prev_index != HEAD_INDEX {
                if let Some(prev_node_key) = (prev_index != HEAD_INDEX && prev_index != TAIL_INDEX)
                    .then(|| self.nodes[prev_index].k())
                {
                    assert!(
                        prev_node_key.is_less_than(current_node.k()),
                        "Ordering violation: {:?} should come before {:?}",
                        prev_node_key,
                        current_node.k()
                    );

                    assert!(
                        !current_node.k().is_less_than(prev_node_key),
                        "Ordering violation: {:?} should come after {:?}",
                        current_node.k(),
                        prev_node_key
                    );
                }
            }

            prev_index = current_index;
            current_index = if !current_node.forward.is_empty() {
                current_node.forward[0]
            } else {
                TAIL_INDEX
            };
        }

        // Check tail's prev pointer
        assert_eq!(
            self.tail.prev, prev_index,
            "Tail's prev pointer incorrect. Expected {:?}, got {:?}",
            prev_index, self.tail.prev
        );
    }

    fn validate_level(&self, level: usize) {
        let mut current_index = HEAD_INDEX;
        let mut next_index = if level < self.head.forward.len() {
            self.head.forward[level]
        } else {
            // Head doesn't have this level, so it should point directly to tail
            TAIL_INDEX
        };
        if next_index == TAIL_INDEX {
            assert!(self.current_level < level)
        }

        // Check head's forward pointer at this level
        if level < self.head.forward.len() {
            let next_node_idx = self.head.forward[level];
            if next_node_idx != TAIL_INDEX {
                let next_node = &self.nodes[next_node_idx];
                assert!(
                    level < next_node.forward.len(),
                    "Head's level {} forward points to node {:?} that doesn't have this level",
                    level,
                    next_node.k()
                );
            }
        }

        while next_index != TAIL_INDEX {
            let node = &self.nodes[next_index];

            // Check node has this level
            assert!(
                level < node.forward.len(),
                "Node {:?} is in level {} chain but doesn't have this level",
                node.k(),
                level
            );

            // Check next node's key is greater than current node's key
            let next_next_index = node.forward[level];
            if next_next_index != TAIL_INDEX {
                let next_node = &self.nodes[next_next_index];
                if !node.k().is_less_than(next_node.k()) {
                    self.debug_print();
                }
                dbg_assert!(
                    node.k().is_less_than(next_node.k()),
                    "Level {} ordering violation: {:?} should come before {:?}",
                    level,
                    node.k(),
                    next_node.k()
                );
            }

            current_index = next_index;
            next_index = node.forward[level];
        }

        // The last node at this level should point to tail
        if current_index != HEAD_INDEX {
            let forward = if current_index == HEAD_INDEX {
                self.head.forward[level]
            } else {
                self.nodes[current_index].forward[level]
            };

            assert_eq!(
                forward,
                TAIL_INDEX,
                "Last node {:?} at level {} should point to tail",
                if current_index == HEAD_INDEX {
                    "HEAD"
                } else {
                    "node"
                },
                level
            );
        }
    }

    pub fn assert_is_in_order(&self)
    where
        K: Debug + Clone + IsLessThan,
        V: Debug + Clone,
    {
        let mut prev: Option<K> = None;
        for (k, _) in self.iter() {
            if let Some(prev_sample) = &prev {
                if !prev_sample.is_less_than(k) {
                    self.debug_print()
                }
                assert!(
                    prev_sample.is_less_than(k),
                    "{prev_sample:?} is not less than {k:?}",
                );
            }
            prev = Some(k.clone());
        }
    }

    /// Print the SkipList in a visual tabulated format for debugging
    pub fn debug_print(&self)
    where
        K: Display,
    {
        // Print levels from top to bottom, starting from max_level-1 down to 0
        for level in (0..self.max_level).rev() {
            if self.head.forward[level] == TAIL_INDEX {
                continue;
            }
            print!("{level} ");

            // Start from head node
            let mut current_idx = HEAD_INDEX;

            // Print connections at this level
            loop {
                // Get the forward index at this level
                let next_idx = match current_idx {
                    HEAD_INDEX => {
                        print!("- ");
                        self.head.forward[0]
                    }
                    TAIL_INDEX => unreachable!(),
                    _ => {
                        let forward = &self.nodes[current_idx].forward;
                        // Check if this node has connections at this level
                        if level < forward.len() {
                            if forward[level] == TAIL_INDEX {
                                print!("> ");
                            } else {
                                print!("- ");
                            }

                            forward[0]
                        } else {
                            print!("  ");
                            // Skip nodes that don't exist at this level
                            if forward[0] == TAIL_INDEX {
                                break;
                            }
                            current_idx = forward[0];
                            continue;
                        }
                    }
                };

                // If we've reached the tail, exit the loop for this level
                if next_idx == TAIL_INDEX {
                    break;
                }
                current_idx = next_idx;
            }
            println!();
        }

        // Print the node values on the bottom row
        print!("< ");

        // Start from the first real node (after head)
        let mut current = self.next_pos_(HEAD_INDEX);

        // Print each node's key
        while let Some(idx) = current {
            if idx != HEAD_INDEX && idx != TAIL_INDEX {
                // Assuming keys can be displayed as single characters
                print!("{} ", self.nodes[idx].k());
            }
            current = self.next_pos_(idx);
        }

        print!(">");
        println!();
    }
}
impl<K, V> SkipList<K, V>
where
    K: Debug + Clone + IsLessThan,
    V: Debug + Clone,
{
    #[allow(dead_code)]
    pub(super) fn print_path_(&self, path: &[usize]) {
        let mut buff = String::new();
        for i in path.iter() {
            match *i {
                HEAD_INDEX => buff.push('<'),
                TAIL_INDEX => buff.push('>'),
                _ => buff.push_str(format!("{i}").as_str()),
            }
        }
        println!("path:{buff}");
    }
}
