// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Floating point functions that round the same on every target.
//!
//! The standard library's `sin`, `hypot` and the like call the platform's math library natively
//! (Apple's libm on macOS) and the `libm` crate in WebAssembly. The two can differ in the last bit,
//! and a last bit can flip a tie in path ordering or a rounded coordinate, so the native and browser
//! builds would write different G-code. Every transcendental function in the core goes through this
//! trait instead, which always takes the `libm` crate's result.
//!
//! `powi` has no fixed precision either: an optimized build turns `x.powi(3)` into multiplications,
//! while an unoptimized Windows build calls a routine that rounds differently (`powi(2)` and `x * x`
//! disagree on about one value in two thousand), so the reference G-code changed with the build.
//! `m_powi` multiplies in the order the optimized builds use.

/// The `libm` crate's functions as methods on `f64` and `f32`, named like the standard ones with `m_`.
#[allow(
    dead_code,
    reason = "the whole set is here so new code has no reason to reach for the standard methods"
)]
pub trait Fm: Copy {
    fn m_sin(self) -> Self;
    fn m_cos(self) -> Self;
    fn m_sin_cos(self) -> (Self, Self);
    fn m_tan(self) -> Self;
    fn m_asin(self) -> Self;
    fn m_acos(self) -> Self;
    fn m_atan(self) -> Self;
    fn m_atan2(self, other: Self) -> Self;
    fn m_hypot(self, other: Self) -> Self;
    fn m_exp(self) -> Self;
    fn m_exp2(self) -> Self;
    fn m_exp_m1(self) -> Self;
    fn m_ln(self) -> Self;
    fn m_ln_1p(self) -> Self;
    fn m_log10(self) -> Self;
    fn m_log2(self) -> Self;
    fn m_powf(self, n: Self) -> Self;
    /// `self` to the power `n` by squaring and multiplying, the same on every target and in every build.
    fn m_powi(self, n: i32) -> Self;
    fn m_cbrt(self) -> Self;
    fn m_tanh(self) -> Self;
    fn m_sinh(self) -> Self;
    fn m_cosh(self) -> Self;
}

macro_rules! fm_impl {
    ($t:ty, $sin:ident, $cos:ident, $sincos:ident, $tan:ident, $asin:ident, $acos:ident, $atan:ident, $atan2:ident,
     $hypot:ident, $exp:ident, $exp2:ident, $expm1:ident, $log:ident, $log1p:ident, $log10:ident, $log2:ident,
     $pow:ident, $cbrt:ident, $tanh:ident, $sinh:ident, $cosh:ident) => {
        impl Fm for $t {
            #[inline]
            fn m_sin(self) -> Self {
                libm::$sin(self)
            }
            #[inline]
            fn m_cos(self) -> Self {
                libm::$cos(self)
            }
            #[inline]
            fn m_sin_cos(self) -> (Self, Self) {
                libm::$sincos(self)
            }
            #[inline]
            fn m_tan(self) -> Self {
                libm::$tan(self)
            }
            #[inline]
            fn m_asin(self) -> Self {
                libm::$asin(self)
            }
            #[inline]
            fn m_acos(self) -> Self {
                libm::$acos(self)
            }
            #[inline]
            fn m_atan(self) -> Self {
                libm::$atan(self)
            }
            #[inline]
            fn m_atan2(self, other: Self) -> Self {
                libm::$atan2(self, other)
            }
            #[inline]
            fn m_hypot(self, other: Self) -> Self {
                libm::$hypot(self, other)
            }
            #[inline]
            fn m_exp(self) -> Self {
                libm::$exp(self)
            }
            #[inline]
            fn m_exp2(self) -> Self {
                libm::$exp2(self)
            }
            #[inline]
            fn m_exp_m1(self) -> Self {
                libm::$expm1(self)
            }
            #[inline]
            fn m_ln(self) -> Self {
                libm::$log(self)
            }
            #[inline]
            fn m_ln_1p(self) -> Self {
                libm::$log1p(self)
            }
            #[inline]
            fn m_log10(self) -> Self {
                libm::$log10(self)
            }
            #[inline]
            fn m_log2(self) -> Self {
                libm::$log2(self)
            }
            #[inline]
            fn m_powf(self, n: Self) -> Self {
                libm::$pow(self, n)
            }
            #[inline]
            fn m_cbrt(self) -> Self {
                libm::$cbrt(self)
            }
            #[inline]
            fn m_tanh(self) -> Self {
                libm::$tanh(self)
            }
            #[inline]
            fn m_sinh(self) -> Self {
                libm::$sinh(self)
            }
            #[inline]
            fn m_cosh(self) -> Self {
                libm::$cosh(self)
            }
            #[inline]
            fn m_powi(self, n: i32) -> Self {
                // Square and multiply from the low bit, as LLVM expands a constant power.
                let mut base = self;
                let mut e = n.unsigned_abs();
                let mut out: Option<Self> = None;
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
    };
}

#[cfg(test)]
mod tests {
    use super::Fm;

    #[test]
    fn powi_is_the_multiplication_an_optimized_build_does() {
        let mut s: u64 = 0x9E37_79B9_7F4A_7C15;
        for _ in 0..100_000 {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            #[allow(clippy::cast_precision_loss, reason = "a sample in [0.001, 500)")]
            let x = 0.001 + (s >> 11) as f64 / (1u64 << 53) as f64 * 500.0;
            assert_eq!(x.m_powi(0).to_bits(), 1.0f64.to_bits());
            assert_eq!(x.m_powi(1).to_bits(), x.to_bits());
            assert_eq!(x.m_powi(2).to_bits(), (x * x).to_bits());
            assert_eq!(x.m_powi(3).to_bits(), (x * (x * x)).to_bits());
            let y = x * x;
            assert_eq!(x.m_powi(4).to_bits(), (y * y).to_bits());
            assert_eq!(x.m_powi(5).to_bits(), (x * (y * y)).to_bits());
            assert_eq!(x.m_powi(-1).to_bits(), (1.0 / x).to_bits());
            assert_eq!(x.m_powi(-2).to_bits(), (1.0 / (x * x)).to_bits());
        }
    }
}

fm_impl!(
    f64, sin, cos, sincos, tan, asin, acos, atan, atan2, hypot, exp, exp2, expm1, log, log1p, log10, log2,
    pow, cbrt, tanh, sinh, cosh
);
fm_impl!(
    f32, sinf, cosf, sincosf, tanf, asinf, acosf, atanf, atan2f, hypotf, expf, exp2f, expm1f, logf, log1pf,
    log10f, log2f, powf, cbrtf, tanhf, sinhf, coshf
);
