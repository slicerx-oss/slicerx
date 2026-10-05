use crate::IsLessThan;
use crate::linkedlist::{HEAD_INDEX, LinkedList, TAIL_INDEX};
use std::fmt::{Debug, Display};

impl<K, V> LinkedList<K, V>
where
    K: Debug + Display + Clone + IsLessThan,
    V: Debug + Clone,
{
    pub fn validate(&self) {
        // Check ordering between nodes
        self.validate_ordering();
        self.assert_is_in_order();
    }

    fn validate_ordering(&self) {
        let mut prev_index = HEAD_INDEX;
        let mut current_index = self.head;
        #[cfg(feature = "linkedlist_midpoint")]
        let mut mid_delta = 0;
        #[cfg(feature = "linkedlist_midpoint")]
        let mut _mid_offset: i32 = 0;
        #[cfg(feature = "linkedlist_midpoint")]
        if self.mid_point.is_some() {
            mid_delta = -1;
        }

        while current_index != TAIL_INDEX {
            let current_node = &self.nodes[current_index];
            assert!(
                current_node.kv.is_some(),
                "index {current_index} was not active",
            );
            // Check prev pointer is consistent
            assert_eq!(
                current_node.prev,
                prev_index,
                "Node {:?} has incorrect prev pointer. Expected {:?}, got {:?}",
                current_node.kv.as_ref().unwrap().0,
                prev_index,
                current_node.prev
            );
            #[cfg(feature = "linkedlist_midpoint")]
            if let Some(mid_index) = self.mid_point {
                if mid_index == current_index {
                    mid_delta = 1;
                } else {
                    _mid_offset += mid_delta;
                    if mid_delta > 0 {
                        //println!("greater than mid: {:?}", self.get_v_at_(current_index).unwrap());
                    } else {
                        //println!("less than mid: {:?}", self.get_v_at_(current_index).unwrap());
                    }
                }
            }
            // Check ordering between current and previous node
            if prev_index != HEAD_INDEX {
                if let Some(prev_node_key) = (prev_index != HEAD_INDEX && prev_index != TAIL_INDEX)
                    .then(|| &self.nodes[prev_index].kv.as_ref().unwrap().0)
                {
                    assert!(
                        prev_node_key.is_less_than(&current_node.kv.as_ref().unwrap().0),
                        "Ordering violation: {:?} should come before {:?}",
                        prev_node_key,
                        current_node.kv.as_ref().unwrap().0
                    );

                    assert!(
                        !current_node
                            .kv
                            .as_ref()
                            .unwrap()
                            .0
                            .is_less_than(prev_node_key),
                        "Ordering violation: {:?} should come after {:?}",
                        current_node.kv.as_ref().unwrap().0,
                        prev_node_key
                    );
                }
            }

            prev_index = current_index;
            current_index = current_node.forward
        }

        // Check tail's prev pointer
        assert_eq!(
            self.tail, prev_index,
            "Tail's prev pointer incorrect. Expected {:?}, got {:?}",
            prev_index, self.tail
        );
        #[cfg(feature = "linkedlist_midpoint")]
        assert!(
            _mid_offset.abs() < 3,
            "mid offset incorrect, delta={}",
            _mid_offset
        );
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

    /// Print the LinkedList in a visual tabulated format for debugging
    pub fn debug_print(&self)
    where
        K: Display,
    {
        if self.is_empty() {
            print!("{{empty list}}")
        }
        for (k, v) in self.iter() {
            print!("{{{k},{v:?}}}")
        }
        #[cfg(feature = "linkedlist_midpoint")]
        if let Some(mid) = self.mid_point {
            dbg_assert!(
                mid == HEAD_INDEX || self.nodes[mid].kv.is_some(),
                "Mid index {} was not active",
                mid
            );
            println!(
                " mid_k:{:?},#{},delta:{}",
                self.get_k_at_(mid).unwrap(),
                mid,
                self.mid_point_delta
            );
        } else {
            println!(" mid_k:None,delta:{}", self.mid_point_delta);
        }
    }
}
