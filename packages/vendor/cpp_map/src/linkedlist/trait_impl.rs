use crate::IsLessThan;
use crate::linkedlist::{HEAD_INDEX, Index, LinkedList, TAIL_INDEX};
use std::fmt;
use std::fmt::Debug;
use std::ops::Deref;
/*// Implement for types that already have Ord
impl<T: Ord> IsLessThan for T {
    fn is_less_than(&self, other: &Self) -> bool {
        self < other
    }
}*/

impl<K, V> Default for LinkedList<K, V>
where
    K: Debug + Clone + IsLessThan,
    V: Debug + Clone,
{
    fn default() -> Self {
        Self {
            head: TAIL_INDEX,
            tail: HEAD_INDEX,
            nodes: vec![],
            free_index_pool: Default::default(),
            #[cfg(feature = "linkedlist_midpoint")]
            mid_point: None,
            #[cfg(feature = "linkedlist_midpoint")]
            mid_point_delta: 0,
        }
    }
}

impl fmt::Display for Index {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl Debug for Index {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<Index> for usize {
    fn from(index: Index) -> usize {
        index.0
    }
}

impl PartialEq<usize> for Index {
    #[inline(always)]
    fn eq(&self, other: &usize) -> bool {
        self.0 == *other
    }
}

impl Deref for Index {
    type Target = usize;
    #[inline(always)]
    fn deref(&self) -> &usize {
        &self.0
    }
}
