// SPDX-License-Identifier:BSL-1.0

//! The big integer of the exact circle predicates, in a fixed array of chunks.
//!
//! [`FixedInt`] does what [`ExtendedInt`](super::extended_int::ExtendedInt) does for a new value (every
//! operator of the predicates makes one), with the same chunks and the same chunk count: sums keep the
//! longer operand's count and one more for a carry, differences drop equal top chunks of operands of equal
//! length and then at most one zero top chunk, products have `n1 + n2 - 1` chunks and one more for a
//! carry. The conversion to floating point reads the top three chunks, so the counts matter as much as the
//! values.
//!
//! A value is a signed count and [`CHUNKS`] chunks, and it is `Copy`: no spill to the heap, no drop, no
//! length kept apart from the count. A result that would need more chunks (a handful in a slice, deep in
//! the nested square root evaluations) raises a flag on the thread instead, and the predicate that saw it
//! runs again on `ExtendedInt` (see [`take_overflow`]).

use num_traits::{One, PrimInt as InputType, Zero};
use std::cell::Cell;
use std::{cmp, fmt, ops};

/// Chunks a value holds.
pub const CHUNKS: usize = 24;

thread_local! {
    static OVERFLOW: Cell<bool> = const { Cell::new(false) };
}

/// Whether an operation on this thread needed more than [`CHUNKS`] chunks since the last call, and clears
/// the flag.
#[inline]
pub(crate) fn take_overflow() -> bool {
    OVERFLOW.with(|o| o.replace(false))
}

/// A stand-in for a result too long to hold: zero, with the flag raised.
#[cold]
fn overflow() -> FixedInt {
    OVERFLOW.with(|o| o.set(true));
    FixedInt::zero()
}

/// A big integer of up to [`CHUNKS`] 32-bit chunks, least significant first, and a count of them signed
/// with the value.
#[derive(Clone, Copy)]
pub struct FixedInt {
    n: i32,
    c: [u32; CHUNKS],
}

impl<I: InputType> From<I> for FixedInt {
    #[inline]
    fn from(that: I) -> Self {
        let that = crate::cast::<I, i64>(that);
        let mut c = [0_u32; CHUNKS];
        if that == 0 {
            return Self { n: 0, c };
        }
        let m = that.unsigned_abs();
        c[0] = m as u32;
        c[1] = (m >> 32) as u32;
        let n = if c[1] != 0 { 2 } else { 1 };
        Self {
            n: if that < 0 { -n } else { n },
            c,
        }
    }
}

impl Zero for FixedInt {
    #[inline]
    fn zero() -> Self {
        Self { n: 0, c: [0; CHUNKS] }
    }
    #[inline]
    fn is_zero(&self) -> bool {
        self.n == 0
    }
}

impl One for FixedInt {
    #[inline]
    fn one() -> Self {
        Self::from(1_i32)
    }
}

impl Default for FixedInt {
    #[inline]
    fn default() -> Self {
        Self::zero()
    }
}

impl FixedInt {
    #[inline(always)]
    fn size(&self) -> usize {
        self.n.unsigned_abs() as usize
    }

    #[inline(always)]
    fn chunks(&self) -> &[u32] {
        &self.c[..self.size()]
    }

    /// The mantissa and exponent of the value: `value` = `mantissa` * 2^`exponent`, from the top three
    /// chunks as `ExtendedInt::p` reads them.
    pub fn p(&self) -> (f64, i32) {
        let sep = 0x1_0000_0000_u64 as f64;
        let n = self.size();
        let c = &self.c;
        let mut rv = match n {
            0 => return (0.0, 0),
            1 => (f64::from(c[0]), 0),
            2 => (f64::from(c[1]) * sep + f64::from(c[0]), 0),
            _ => {
                let mut m = f64::from(c[n - 1]);
                m *= sep;
                m += f64::from(c[n - 2]);
                m *= sep;
                m += f64::from(c[n - 3]);
                (m, ((n - 3) << 5) as i32)
            }
        };
        if self.n < 0 {
            rv.0 = -rv.0;
        }
        rv
    }

    #[inline(always)]
    pub fn is_pos(&self) -> bool {
        self.n > 0
    }

    #[inline(always)]
    pub fn is_neg(&self) -> bool {
        self.n < 0
    }

    #[inline(always)]
    pub fn is_zero(&self) -> bool {
        self.n == 0
    }

    /// The value as `f64`.
    pub fn d(&self) -> f64 {
        let p = self.p();
        libm::ldexp(p.0, p.1)
    }

    #[inline(always)]
    fn negated(mut self) -> Self {
        self.n = -self.n;
        self
    }

    /// The sum of two magnitudes: the longer one's chunk count, one more for a carry.
    #[inline]
    fn add_mag(c1: &[u32], c2: &[u32]) -> Self {
        let (c1, c2) = if c1.len() < c2.len() { (c2, c1) } else { (c1, c2) };
        let mut c = [0_u32; CHUNKS];
        let mut t = 0_u64;
        for i in 0..c2.len() {
            t += u64::from(c1[i]) + u64::from(c2[i]);
            c[i] = t as u32;
            t >>= 32;
        }
        for i in c2.len()..c1.len() {
            t += u64::from(c1[i]);
            c[i] = t as u32;
            t >>= 32;
        }
        let mut n = c1.len();
        if t != 0 {
            if n == CHUNKS {
                return overflow();
            }
            c[n] = t as u32;
            n += 1;
        }
        Self { n: n as i32, c }
    }

    /// The difference of two magnitudes as the original works it out: a shorter first operand swaps them;
    /// operands of equal length (unless `rec`) first drop their equal top chunks; the result is computed
    /// over the first operand's chunks and loses at most one zero top chunk.
    fn dif_mag(c1: &[u32], c2: &[u32], rec: bool) -> Self {
        let (mut sz1, mut sz2) = (c1.len(), c2.len());
        if sz1 < sz2 {
            return Self::dif_mag(c2, c1, true).negated();
        }
        if sz1 == sz2 && !rec {
            loop {
                sz1 -= 1;
                match c1[sz1].cmp(&c2[sz1]) {
                    cmp::Ordering::Less => {
                        sz1 += 1;
                        return Self::dif_mag(&c2[..sz1], &c1[..sz1], true).negated();
                    }
                    cmp::Ordering::Greater => {
                        sz1 += 1;
                        break;
                    }
                    cmp::Ordering::Equal => (),
                }
                if sz1 == 0 {
                    return Self::zero();
                }
            }
            sz2 = sz1;
        }
        let mut c = [0_u32; CHUNKS];
        let mut borrow = 0_u64;
        for i in 0..sz2 {
            let d = u64::from(c1[i])
                .wrapping_sub(u64::from(c2[i]))
                .wrapping_sub(borrow);
            c[i] = d as u32;
            borrow = d >> 63;
        }
        for i in sz2..sz1 {
            let d = u64::from(c1[i]).wrapping_sub(borrow);
            c[i] = d as u32;
            borrow = d >> 63;
        }
        let n = if c[sz1 - 1] != 0 { sz1 } else { sz1 - 1 };
        Self { n: n as i32, c }
    }

    /// The product of two magnitudes: `n1 + n2 - 1` chunks, one more for a carry.
    #[inline]
    fn mul_mag(c1: &[u32], c2: &[u32]) -> Self {
        let count = c1.len() + c2.len() - 1;
        let mut c = [0_u32; CHUNKS];
        if c1.len() <= 2 && c2.len() <= 2 {
            let value = |x: &[u32]| -> u128 {
                if x.len() == 2 {
                    (u128::from(x[1]) << 32) | u128::from(x[0])
                } else {
                    u128::from(x[0])
                }
            };
            let p = value(c1) * value(c2);
            c[0] = p as u32;
            c[1] = (p >> 32) as u32;
            c[2] = (p >> 64) as u32;
            c[3] = (p >> 96) as u32;
            let n = if c[count] != 0 { count + 1 } else { count };
            return Self { n: n as i32, c };
        }
        if count > CHUNKS {
            return overflow();
        }
        // Row by row: the exact product, whose chunks are the ones the original's column loop writes.
        let mut wide = [0_u32; 2 * CHUNKS];
        for (i, &a) in c1.iter().enumerate() {
            let mut carry = 0_u64;
            for (j, &b) in c2.iter().enumerate() {
                let t = u64::from(a) * u64::from(b) + u64::from(wide[i + j]) + carry;
                wide[i + j] = t as u32;
                carry = t >> 32;
            }
            wide[i + c2.len()] = carry as u32;
        }
        let mut n = count;
        if wide[count] != 0 {
            if count == CHUNKS {
                return overflow();
            }
            n += 1;
        }
        c[..n].copy_from_slice(&wide[..n]);
        Self { n: n as i32, c }
    }
}

impl<'b> ops::Add<&'b FixedInt> for &FixedInt {
    type Output = FixedInt;
    #[inline]
    fn add(self, that: &'b FixedInt) -> FixedInt {
        if self.n == 0 {
            return *that;
        }
        if that.n == 0 {
            return *self;
        }
        let r = if (self.n > 0) ^ (that.n > 0) {
            FixedInt::dif_mag(self.chunks(), that.chunks(), false)
        } else {
            FixedInt::add_mag(self.chunks(), that.chunks())
        };
        if self.n < 0 { r.negated() } else { r }
    }
}

impl<'b> ops::Sub<&'b FixedInt> for &FixedInt {
    type Output = FixedInt;
    #[inline]
    fn sub(self, that: &'b FixedInt) -> FixedInt {
        if self.n == 0 {
            return that.negated();
        }
        if that.n == 0 {
            return *self;
        }
        let r = if (self.n > 0) ^ (that.n > 0) {
            FixedInt::add_mag(self.chunks(), that.chunks())
        } else {
            FixedInt::dif_mag(self.chunks(), that.chunks(), false)
        };
        if self.n < 0 { r.negated() } else { r }
    }
}

impl<'b> ops::Mul<&'b FixedInt> for &FixedInt {
    type Output = FixedInt;
    #[inline]
    fn mul(self, that: &'b FixedInt) -> FixedInt {
        if self.n == 0 || that.n == 0 {
            return FixedInt::zero();
        }
        let r = FixedInt::mul_mag(self.chunks(), that.chunks());
        if (self.n > 0) ^ (that.n > 0) {
            r.negated()
        } else {
            r
        }
    }
}

impl ops::Add for FixedInt {
    type Output = Self;
    #[inline]
    fn add(self, that: Self) -> Self {
        &self + &that
    }
}

impl<'b> ops::Add<&'b FixedInt> for FixedInt {
    type Output = Self;
    #[inline]
    fn add(self, that: &'b FixedInt) -> Self {
        &self + that
    }
}

impl ops::Sub for FixedInt {
    type Output = Self;
    #[inline]
    fn sub(self, that: Self) -> Self {
        &self - &that
    }
}

impl<'b> ops::Sub<&'b FixedInt> for FixedInt {
    type Output = Self;
    #[inline]
    fn sub(self, that: &'b FixedInt) -> Self {
        &self - that
    }
}

impl ops::Mul for FixedInt {
    type Output = Self;
    #[inline]
    fn mul(self, that: Self) -> Self {
        &self * &that
    }
}

impl<'b> ops::Mul<&'b FixedInt> for FixedInt {
    type Output = Self;
    #[inline]
    fn mul(self, that: &'b FixedInt) -> Self {
        &self * that
    }
}

impl ops::Mul<i32> for FixedInt {
    type Output = Self;
    #[inline]
    fn mul(self, that: i32) -> Self {
        &self * &FixedInt::from(that)
    }
}

impl ops::Neg for FixedInt {
    type Output = Self;
    #[inline]
    fn neg(self) -> Self {
        self.negated()
    }
}

impl fmt::Debug for FixedInt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:.0}", self.d())
    }
}

#[cfg(test)]
mod tests {
    use super::{CHUNKS, FixedInt, take_overflow};
    use crate::extended_scalar::extended_int::ExtendedInt;

    /// An `ExtendedInt` and a `FixedInt` with the same chunks and signed count.
    fn pair(chunks: &[u32], neg: bool) -> (ExtendedInt, FixedInt) {
        let mut f = FixedInt::from(0_i32);
        f.c[..chunks.len()].copy_from_slice(chunks);
        let n = chunks.len() as i32;
        f.n = if neg { -n } else { n };
        (ExtendedInt::from_chunks_for_test(chunks, neg), f)
    }

    fn same(e: &ExtendedInt, f: &FixedInt) -> bool {
        let (chunks, count) = e.chunks_and_count_for_test();
        count == f.n && chunks == f.chunks()
    }

    /// Sums, differences and products of operands of 0 to 12 chunks, with all-ones, zero and equal chunks and
    /// zero top chunks (the original's differences leave them), give the same chunks and count as
    /// `ExtendedInt`, and so the same floating point value.
    #[test]
    fn operations_match_extended_int() {
        let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        for round in 0..300_000_u32 {
            let chunks = |next: &mut dyn FnMut() -> u64, len: usize| -> Vec<u32> {
                (0..len)
                    .map(|k| {
                        let r = next();
                        let c = match r % 9 {
                            0 => u32::MAX,
                            1 | 2 => 0,
                            3 => 1,
                            _ => (r >> 20) as u32,
                        };
                        if k + 1 == len && c == 0 && r % 4 != 0 {
                            5
                        } else {
                            c
                        }
                    })
                    .collect()
            };
            let la = (next() % 13) as usize;
            let lb = (next() % 13) as usize;
            let ca = chunks(&mut next, la);
            let mut cb = chunks(&mut next, lb);
            if round % 3 == 0 && la == lb && la > 0 {
                // Equal top chunks, for the differences.
                cb[la - 1] = ca[la - 1];
                if round % 6 == 0 && la > 1 {
                    cb[la - 2] = ca[la - 2];
                }
            }
            if round % 11 == 0 {
                cb.clone_from(&ca);
            }
            let (ea, fa) = pair(&ca, next() % 2 == 0);
            let (eb, fb) = pair(&cb, next() % 2 == 0);
            let checks = [
                (&ea + &eb, &fa + &fb, "sum"),
                (&ea - &eb, &fa - &fb, "difference"),
                (&ea * &eb, &fa * &fb, "product"),
            ];
            for (e, f, what) in checks {
                assert!(!take_overflow(), "no overflow at these sizes");
                assert!(same(&e, &f), "{what}, round {round}: {ca:?} {cb:?}");
                assert_eq!(
                    e.p().0.to_bits(),
                    f.p().0.to_bits(),
                    "{what} mantissa, round {round}"
                );
                assert_eq!(e.p().1, f.p().1, "{what} exponent, round {round}");
            }
            let k = (next() % 7) as i32 - 3;
            assert!(same(&(ea.clone() * k), &(fa * k)), "times {k}, round {round}");
            assert!(same(&(-ea.clone()), &(-fa)), "negation, round {round}");
        }
    }

    /// Integers convert as `ExtendedInt` converts them.
    #[test]
    fn conversions_match_extended_int() {
        for v in [
            0_i64,
            1,
            -1,
            7,
            -7,
            i64::from(u32::MAX),
            -i64::from(u32::MAX),
            1 << 32,
            -(1 << 32),
            i64::MAX,
            i64::MIN + 1,
        ] {
            assert!(same(&ExtendedInt::from(v), &FixedInt::from(v)), "{v}");
        }
        for v in [0_i32, 1, -1, i32::MAX, i32::MIN] {
            assert!(same(&ExtendedInt::from(v), &FixedInt::from(v)), "{v}");
        }
    }

    /// A product past the fixed chunks raises the overflow flag once.
    #[test]
    fn long_results_raise_the_flag() {
        let (_, a) = pair(&[1; CHUNKS / 2 + 1], false);
        let _ = take_overflow();
        let _ = &a * &a;
        assert!(take_overflow());
        assert!(!take_overflow());
    }
}
