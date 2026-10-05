// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Stable sorting through one shared sort of indexes. The standard stable sort is instantiated for every
//! element type and comparator, and those copies were a large part of the WASM module; here every call sorts
//! `0..n` with the same comparator type and then moves the items into place. The result is the standard
//! stable sort's: equal items keep their order.

use std::cmp::Ordering;

/// The stable order of `n` items under `cmp` over their indexes. Not inlined, so the engine holds one copy.
#[inline(never)]
fn order(n: usize, cmp: &dyn Fn(usize, usize) -> Ordering) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..n).collect();
    idx.sort_by(|&a, &b| cmp(a, b));
    idx
}

/// Puts `v` in the order `idx`: place `k` receives the item that was at `idx[k]`.
fn permute<T>(v: &mut [T], mut idx: Vec<usize>) {
    for start in 0..idx.len() {
        let mut cur = start;
        while let Some(&next) = idx.get(cur) {
            if next == usize::MAX {
                break;
            }
            if let Some(slot) = idx.get_mut(cur) {
                *slot = usize::MAX;
            }
            if next == start {
                break;
            }
            v.swap(cur, next);
            cur = next;
        }
    }
}

/// [`slice::sort_by`], with the same result.
pub(crate) fn sort_by<T>(v: &mut [T], cmp: impl Fn(&T, &T) -> Ordering) {
    if v.len() < 2 {
        return;
    }
    let idx = {
        let s: &[T] = v;
        order(s.len(), &|a, b| match (s.get(a), s.get(b)) {
            (Some(x), Some(y)) => cmp(x, y),
            _ => Ordering::Equal,
        })
    };
    permute(v, idx);
}

/// [`slice::sort_by_key`], with the same result.
pub(crate) fn sort_by_key<T, K: Ord>(v: &mut [T], key: impl Fn(&T) -> K) {
    sort_by(v, |a, b| key(a).cmp(&key(b)));
}

#[cfg(test)]
mod tests {
    #[test]
    fn matches_the_standard_stable_sort() {
        let mut seed = 7u64;
        for n in [0usize, 1, 2, 3, 17, 20, 21, 64, 300] {
            let v: Vec<(u8, usize)> = (0..n)
                .map(|i| {
                    seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
                    ((seed >> 60) as u8, i)
                })
                .collect();
            let mut a = v.clone();
            let mut b = v;
            a.sort_by_key(|x| x.0);
            super::sort_by_key(&mut b, |x| x.0);
            assert_eq!(a, b);
        }
    }
}
