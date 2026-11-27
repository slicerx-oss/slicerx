// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sorting by plain integer keys, so the callers share a few copies of std's sort
//!
//! a sort by a closure makes its own copy of std's sort code, several kilobytes in the browser build. these sort a
//! list of (key, position) pairs instead, which has one copy per key type, then move the items into place. the order
//! is the one a stable sort by the same key gives.

/// a key that orders as [`f64::total_cmp`] does, -0.0 before 0.0 and NaN at the ends, so it stands in for a
/// `total_cmp` comparator only: one by `partial_cmp` keeps -0.0 and 0.0 in their order
pub fn f64_key(x: f64) -> u64 {
    let b = x.to_bits();
    if b >> 63 == 1 { !b } else { b | 1 << 63 }
}

/// the same, largest first
pub fn f64_key_rev(x: f64) -> u64 {
    !f64_key(x)
}

/// sorts `v` by `key` as `sort_by_key` would: equal keys keep their order
pub fn sort_by_key<T, K: Ord + Copy>(v: &mut [T], key: impl Fn(&T) -> K) {
    if v.len() < 2 {
        return;
    }
    let mut order: Vec<(K, usize)> = v.iter().map(key).zip(0..).collect();
    // the positions make every pair distinct, so the quicker unstable sort gives the stable order
    order.sort_unstable();
    // v[p] takes the item at order[p].1: each cycle once, a done slot marked usize::MAX
    for start in 0..v.len() {
        let mut p = start;
        while let Some(slot) = order.get_mut(p) {
            let s = slot.1;
            if s == usize::MAX {
                break;
            }
            slot.1 = usize::MAX;
            if s == start {
                break;
            }
            v.swap(p, s);
            p = s;
        }
    }
}

/// the same for three items, with no list made
pub fn sort3_by_key<T, K: Ord>(v: &mut [T; 3], key: impl Fn(&T) -> K) {
    let mut k = [key(&v[0]), key(&v[1]), key(&v[2])];
    // an insertion sort: an item moves only past a larger key
    if k[1] < k[0] {
        k.swap(0, 1);
        v.swap(0, 1);
    }
    if k[2] < k[1] {
        k.swap(1, 2);
        v.swap(1, 2);
    }
    if k[1] < k[0] {
        k.swap(0, 1);
        v.swap(0, 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn f64_keys_order_as_total_cmp() {
        let xs = [
            f64::NEG_INFINITY,
            -1e300,
            -2.5,
            -1.0,
            -f64::MIN_POSITIVE,
            -0.0,
            0.0,
            5e-324,
            1.0,
            3.5,
            f64::INFINITY,
            f64::NAN,
            -f64::NAN,
        ];
        for a in xs {
            for b in xs {
                assert_eq!(f64_key(a).cmp(&f64_key(b)), a.total_cmp(&b), "{a} {b}");
                assert_eq!(f64_key_rev(a).cmp(&f64_key_rev(b)), b.total_cmp(&a), "{a} {b}");
            }
        }
    }

    #[test]
    fn zero_and_minus_zero_sort_as_total_cmp_puts_them() {
        // total_cmp puts -0.0 first, where a sort by partial_cmp keeps the two in their order: these keys stand in
        // for total_cmp only
        let v: [(f64, char); 4] = [(0.0, 'a'), (-0.0, 'b'), (0.0, 'c'), (-0.0, 'd')];
        let mut want = v;
        want.sort_by(|x, y| x.0.total_cmp(&y.0));
        let mut got = v;
        sort_by_key(&mut got, |x| f64_key(x.0));
        assert_eq!(got.map(|x| x.1), want.map(|x| x.1));
        assert_eq!(got.map(|x| x.1), ['b', 'd', 'a', 'c']);
        let mut got = v;
        sort_by_key(&mut got, |x| f64_key_rev(x.0));
        assert_eq!(got.map(|x| x.1), ['a', 'c', 'b', 'd']);
        // in a pair of keys, and in the sort of three
        let w: [(f64, f64, char); 4] = [
            (0.0, -0.0, 'a'),
            (0.0, 0.0, 'b'),
            (-0.0, 0.0, 'c'),
            (0.0, -0.0, 'd'),
        ];
        let mut want = w;
        want.sort_by(|x, y| x.0.total_cmp(&y.0).then(x.1.total_cmp(&y.1)));
        let mut got = w;
        sort_by_key(&mut got, |x| (f64_key(x.0), f64_key(x.1)));
        assert_eq!(got.map(|x| x.2), want.map(|x| x.2));
        assert_eq!(got.map(|x| x.2), ['c', 'a', 'd', 'b']);
        let t = [0.0, -0.0, f64::NAN];
        let mut want = [0, 1, 2];
        want.sort_by(|&i, &j| t[i].total_cmp(&t[j]));
        let mut got = [0, 1, 2];
        sort3_by_key(&mut got, |&i| f64_key(t[i]));
        assert_eq!(got, want);
        assert_eq!(got, [1, 0, 2]);
    }

    #[test]
    fn sorts_as_a_stable_sort_by_key_does() {
        // a small generator, so the lists have many equal keys
        let mut s = 12345u64;
        let mut next = || {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            s
        };
        for n in [0, 1, 2, 3, 5, 20, 21, 64, 257, 1000] {
            let v: Vec<(u64, usize)> = (0..n).map(|i| (next() % 7, i)).collect();
            let mut want = v.clone();
            want.sort_by_key(|x| x.0);
            let mut got = v.clone();
            sort_by_key(&mut got, |x| x.0);
            assert_eq!(got, want, "{n}");
            let mut want = v.clone();
            want.sort_by_key(|x| std::cmp::Reverse(x.0));
            let mut got = v;
            sort_by_key(&mut got, |x| u64::MAX - x.0);
            assert_eq!(got, want, "{n}");
        }
        for a in 0..3u64 {
            for b in 0..3 {
                for c in 0..3 {
                    let v = [(a, 0), (b, 1), (c, 2)];
                    let mut want = v;
                    want.sort_by_key(|x| x.0);
                    let mut got = v;
                    sort3_by_key(&mut got, |x| x.0);
                    assert_eq!(got, want);
                }
            }
        }
    }
}
