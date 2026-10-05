// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! float functions that round the same on every target

pub trait Fm: Copy {
    #[must_use]
    fn m_sin(self) -> Self;
    #[must_use]
    fn m_cos(self) -> Self;
    fn m_sin_cos(self) -> (Self, Self);
    #[must_use]
    fn m_tan(self) -> Self;
    #[must_use]
    fn m_acos(self) -> Self;
    #[must_use]
    fn m_atan(self) -> Self;
    #[must_use]
    fn m_atan2(self, other: Self) -> Self;
    #[must_use]
    fn m_hypot(self, other: Self) -> Self;
    #[must_use]
    fn m_exp(self) -> Self;
    #[must_use]
    fn m_log10(self) -> Self;
    #[must_use]
    fn m_powf(self, n: Self) -> Self;
    /// `self` to the power `n` by squaring and multiplying. `powi` has no fixed precision: unoptimized Windows
    /// builds round it differently from optimized ones, so meshes would change with the build.
    #[must_use]
    fn m_powi(self, n: i32) -> Self;
    #[must_use]
    fn m_cbrt(self) -> Self;
}

impl Fm for f64 {
    #[inline]
    fn m_sin(self) -> Self {
        libm::sin(self)
    }
    #[inline]
    fn m_cos(self) -> Self {
        libm::cos(self)
    }
    #[inline]
    fn m_sin_cos(self) -> (Self, Self) {
        libm::sincos(self)
    }
    #[inline]
    fn m_tan(self) -> Self {
        libm::tan(self)
    }
    #[inline]
    fn m_acos(self) -> Self {
        libm::acos(self)
    }
    #[inline]
    fn m_atan(self) -> Self {
        libm::atan(self)
    }
    #[inline]
    fn m_atan2(self, other: Self) -> Self {
        libm::atan2(self, other)
    }
    #[inline]
    fn m_hypot(self, other: Self) -> Self {
        libm::hypot(self, other)
    }
    #[inline]
    fn m_exp(self) -> Self {
        libm::exp(self)
    }
    #[inline]
    fn m_log10(self) -> Self {
        libm::log10(self)
    }
    #[inline]
    fn m_powf(self, n: Self) -> Self {
        libm::pow(self, n)
    }
    #[inline]
    fn m_cbrt(self) -> Self {
        libm::cbrt(self)
    }
    #[inline]
    fn m_powi(self, n: i32) -> Self {
        // Square and multiply from the low bit, as LLVM expands a constant power.
        let mut base = self;
        let mut e = n.unsigned_abs();
        let mut out: Option<f64> = None;
        while e > 0 {
            if e & 1 == 1 {
                out = Some(out.map_or(base, |o| o * base));
            }
            e >>= 1;
            if e > 0 {
                base *= base;
            }
        }
        let out = out.unwrap_or(1.0);
        if n < 0 { 1.0 / out } else { out }
    }
}

#[cfg(test)]
mod tests {
    use super::Fm;

    #[test]
    fn powi_is_the_multiplication_an_optimized_build_does() {
        for x in [0.1, 0.7, 1.3, 2.5, 17.25, 333.3] {
            let y = x * x;
            assert_eq!(x.m_powi(2).to_bits(), y.to_bits());
            assert_eq!(x.m_powi(3).to_bits(), (x * y).to_bits());
            assert_eq!(x.m_powi(4).to_bits(), (y * y).to_bits());
            assert_eq!(x.m_powi(-2).to_bits(), (1.0 / y).to_bits());
            assert_eq!(x.m_powi(0).to_bits(), 1.0f64.to_bits());
        }
    }
}
