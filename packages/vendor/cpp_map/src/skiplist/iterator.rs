// SPDX-License-Identifier: MIT OR Apache-2.0

// Copyright 2025 Eadf (github.com/eadf)
// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

use crate::IsLessThan;
use crate::skiplist::SkipList;
use std::fmt::Debug;

pub struct SkipListIter<'a, K, V>
where
    K: Debug + Clone + IsLessThan,
    V: Debug + Clone,
{
    skip_list: &'a SkipList<K, V>,
    front: Option<usize>,
    back: Option<usize>,
    remaining: usize,
}

impl<'a, K, V> SkipListIter<'a, K, V>
where
    K: Debug + Clone + IsLessThan,
    V: Debug + Clone,
{
    pub(super) fn new(
        list: &'a SkipList<K, V>,
        front: Option<usize>,
        back: Option<usize>,
        len: usize,
    ) -> Self {
        Self {
            skip_list: list,
            front,
            back,
            remaining: len,
        }
    }

    pub fn rev(self) -> Rev<Self> {
        Rev(self)
    }
}

// Reverse iterator wrapper
pub struct Rev<I>(pub I);

impl<'a, K, V> Iterator for SkipListIter<'a, K, V>
where
    K: Debug + Clone + IsLessThan,
    V: Debug + Clone,
{
    type Item = (&'a K, &'a V);

    fn next(&mut self) -> Option<Self::Item> {
        if let Some(idx) = self.front {
            let result = self.skip_list.get_at_(idx);
            self.front = self.skip_list.next_pos_(idx);
            result
        } else {
            None
        }
    }
}

// Implementation for the reverse iterator wrapper
impl<I> Iterator for Rev<I>
where
    I: DoubleEndedIterator,
{
    type Item = I::Item;

    fn next(&mut self) -> Option<Self::Item> {
        self.0.next_back()
    }
}

impl<I> DoubleEndedIterator for Rev<I>
where
    I: DoubleEndedIterator,
{
    fn next_back(&mut self) -> Option<Self::Item> {
        self.0.next()
    }
}

// DoubleEndedIterator for forward iterator
impl<K, V> DoubleEndedIterator for SkipListIter<'_, K, V>
where
    K: Debug + Clone + IsLessThan,
    V: Debug + Clone,
{
    fn next_back(&mut self) -> Option<Self::Item> {
        if let Some(idx) = self.back {
            let result = self.skip_list.get_at_(idx);
            self.back = self.skip_list.prev_pos_(idx);
            result
        } else {
            None
        }
    }
}

// ExactSizeIterator implementation
impl<K, V> ExactSizeIterator for SkipListIter<'_, K, V>
where
    K: Debug + Clone + IsLessThan,
    V: Debug + Clone,
{
    fn len(&self) -> usize {
        self.remaining
    }
}

impl<K, V> SkipList<K, V>
where
    K: Debug + Clone + IsLessThan,
    V: Debug + Clone,
{
    pub fn iter(&self) -> SkipListIter<'_, K, V> {
        SkipListIter::new(self, self.first_(), self.first_(), self.len())
    }
}

// Implement FromIterator for convenient initialization
impl<K, V> FromIterator<(K, V)> for SkipList<K, V>
where
    K: Debug + Clone + IsLessThan,
    V: Debug + Clone,
{
    fn from_iter<I: IntoIterator<Item = (K, V)>>(iter: I) -> Self {
        let mut skip_list = SkipList::new();
        for (k, v) in iter {
            let _ = skip_list.insert(k, v);
        }
        skip_list
    }
}
