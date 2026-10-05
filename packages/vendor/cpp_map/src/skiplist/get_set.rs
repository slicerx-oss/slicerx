// SPDX-License-Identifier: MIT OR Apache-2.0

// Copyright 2025 Eadf (github.com/eadf)
// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

use crate::prelude::SkipList;
use crate::skiplist::{HEAD_INDEX, Index, SkipNode, TAIL_INDEX};
use crate::{IsEqual, IsLessThan};
use std::fmt::Debug;
use std::mem;

impl<K, V> SkipNode<K, V>
where
    K: Debug + Clone + IsLessThan,
    V: Debug + Clone,
{
    #[inline(always)]
    pub(super) fn k(&self) -> &K {
        unsafe {
            dbg_assert!(self.kv.is_some());
            &self.kv.as_ref().unwrap_unchecked().0
        }
    }

    #[inline(always)]
    pub(super) fn k_mut(&mut self) -> &mut K {
        unsafe {
            dbg_assert!(self.kv.is_some());
            &mut self.kv.as_mut().unwrap_unchecked().0
        }
    }

    #[inline(always)]
    pub(super) fn v(&self) -> &V {
        unsafe {
            dbg_assert!(self.kv.is_some());
            &self.kv.as_ref().unwrap_unchecked().1
        }
    }

    #[inline(always)]
    pub(super) fn v_mut(&mut self) -> &mut V {
        unsafe {
            dbg_assert!(self.kv.is_some());
            &mut self.kv.as_mut().unwrap_unchecked().1
        }
    }

    #[inline(always)]
    pub(super) fn kv(&self) -> (&K, &V) {
        unsafe {
            dbg_assert!(self.kv.is_some());
            let kv = self.kv.as_ref().unwrap_unchecked();
            (&kv.0, &kv.1)
        }
    }

    #[inline(always)]
    pub(super) fn kv_mut(&mut self) -> (&K, &mut V) {
        unsafe {
            dbg_assert!(self.kv.is_some());
            let kv = self.kv.as_mut().unwrap_unchecked();
            (&kv.0, &mut kv.1)
        }
    }
}

impl<K, V> SkipList<K, V>
where
    K: Debug + Clone + IsLessThan,
    V: Debug + Clone,
{
    #[inline(always)]
    /// Check if a key exists in the SkipList
    pub fn contains_key(&self, key: &K) -> bool {
        let node_idx = self.lower_bound_(key);
        if node_idx == TAIL_INDEX || node_idx == HEAD_INDEX {
            return false;
        }
        self.nodes[node_idx].k().is_equal(key)
    }

    /// Get a reference to the value associated with a key
    pub fn get(&self, search_key: &K) -> Option<&V> {
        let index = self.lower_bound_(search_key);
        if index == TAIL_INDEX || index == HEAD_INDEX {
            return None;
        }

        let kv = self.nodes[index].kv();
        if kv.0.is_equal(search_key) {
            Some(kv.1)
        } else {
            None
        }
    }

    #[inline(always)]
    /// Get a reference to the key and value at a given node index
    pub fn get_at(&self, index: Index) -> Option<(&K, &V)> {
        self.get_at_(index.0)
    }

    #[inline(always)]
    /// Get a reference to the key and value at a given node index
    pub(super) fn get_at_(&self, index: usize) -> Option<(&K, &V)> {
        if index == HEAD_INDEX || index == TAIL_INDEX {
            return None;
        }
        Some(self.nodes[index].kv())
    }

    #[inline(always)]
    pub(super) fn get_kr_at_(&self, index: usize) -> Option<(&K, i64)> {
        if index == HEAD_INDEX || index == TAIL_INDEX {
            return None;
        }

        let node = &self.nodes[index];
        Some((node.k(), node.rank))
    }

    #[inline(always)]
    /// Get a reference to the key and value at a given node index
    pub fn get_k_at(&self, index: Index) -> Option<&K> {
        self.get_k_at_(index.0)
    }

    #[inline(always)]
    /// Get a reference to the key and value at a given node index
    pub(super) fn get_k_at_(&self, index: usize) -> Option<&K> {
        if index == HEAD_INDEX || index == TAIL_INDEX {
            return None;
        }

        Some(self.nodes[index].k())
    }

    #[inline(always)]
    /// Get a reference to the key and value at a given node index
    pub fn get_v_at(&self, index: Index) -> Option<&V> {
        self.get_v_at_(index.0)
    }

    #[inline(always)]
    /// Get a reference to the key and value at a given node index
    pub(super) fn get_v_at_(&self, index: usize) -> Option<&V> {
        if index == HEAD_INDEX || index == TAIL_INDEX {
            return None;
        }
        Some(self.nodes[index].v())
    }

    /// Get a reference to the value associated with a key
    pub fn get_kv(&self, search_key: &K) -> Option<(&K, &V)> {
        let kv = self.get_at_(self.lower_bound_(search_key))?;
        if kv.0.is_equal(search_key) {
            Some(kv)
        } else {
            None
        }
    }

    /// Get a mutable reference to the value associated with a key
    pub fn get_mut(&mut self, search_key: &K) -> Option<&mut V> {
        let kv = self.get_mut_at_(self.lower_bound_(search_key))?;
        if kv.0.is_equal(search_key) {
            Some(kv.1)
        } else {
            None
        }
    }

    #[inline(always)]
    /// Get a reference to the key and value at a given node index
    pub fn set_v_at(&mut self, index: Index, input_val: V) -> Option<V> {
        self.set_v_at_(index.0, input_val)
    }

    /// Set the value of a specific node, return the old value
    pub(super) fn set_v_at_(&mut self, index: usize, input_val: V) -> Option<V> {
        if index == HEAD_INDEX || index == TAIL_INDEX {
            return None;
        }
        Some(mem::replace(self.nodes[index].v_mut(), input_val))
    }

    #[inline(always)]
    /// Get a mutable reference to the value at a given node index
    pub fn get_mut_at(&mut self, index: Index) -> Option<(&K, &mut V)> {
        self.get_mut_at_(index.0)
    }

    #[inline(always)]
    /// Get a mutable reference to the value at a given node index
    fn get_mut_at_(&mut self, index: usize) -> Option<(&K, &mut V)> {
        if index == HEAD_INDEX || index == TAIL_INDEX {
            return None;
        }
        Some(self.nodes[index].kv_mut())
    }
}
