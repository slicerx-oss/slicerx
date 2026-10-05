// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Coherent noise for fuzzy skin, the four generators `OrcaSlicer` takes from libnoise 1.0 (Perlin, Billow,
//! ridged multifractal and Voronoi), with the module defaults and the settings Orca gives them.
//!
//! Orca: `Feature/FuzzySkin/FuzzySkin.cpp` (`get_noise_module`); libnoise `noisegen.cpp`,
//! `module/{perlin,billow,ridgedmulti,voronoi}.cpp`. The generators are pure functions of position, so a
//! texture is repeatable and the same on every shard. The gradient table is our own, generated (see `table.rs`); the method is standard
//! gradient noise (hashed lattice gradients, dot product, smooth interpolation), so only the table differs from libnoise.

// The generated table's values are written as the generator prints them, six decimals each.
#[allow(clippy::unreadable_literal, reason = "generated table")]
mod table;

use crate::fm::Fm;
use table::VECTORS;

/// Which generator makes the displacement.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Noise {
    Perlin {
        frequency: f64,
        octaves: i32,
        persistence: f64,
    },
    Billow {
        frequency: f64,
        octaves: i32,
        persistence: f64,
    },
    Ridged {
        frequency: f64,
        octaves: i32,
    },
    Voronoi {
        frequency: f64,
    },
}

const LACUNARITY: f64 = 2.0;
const X_GEN: i32 = 1619;
const Y_GEN: i32 = 31337;
const Z_GEN: i32 = 6971;
const SEED_GEN: i32 = 1013;
const SHIFT_GEN: u32 = 8;

fn floor_int(v: f64) -> i32 {
    // libnoise's `(x > 0.0 ? (int)x : (int)x - 1)`: the cube below the point, truncating toward zero.
    #[allow(
        clippy::cast_possible_truncation,
        reason = "the input is kept in the i32 range"
    )]
    let t = v as i32;
    if v > 0.0 { t } else { t.wrapping_sub(1) }
}

/// Keeps a coordinate in the range of a 32 bit integer, as libnoise's `MakeInt32Range`.
fn int32_range(n: f64) -> f64 {
    const R: f64 = 1_073_741_824.0;
    if n >= R {
        2.0 * (n % R) - R
    } else if n <= -R {
        2.0 * (n % R) + R
    } else {
        n
    }
}

fn s_curve3(a: f64) -> f64 {
    a * a * (3.0 - 2.0 * a)
}

fn lerp(n0: f64, n1: f64, a: f64) -> f64 {
    (1.0 - a) * n0 + a * n1
}

/// The dot product of the cube corner's pseudo-random gradient with the offset to the point.
fn gradient_noise(fx: f64, fy: f64, fz: f64, ix: i32, iy: i32, iz: i32, seed: i32) -> f64 {
    let mut index = X_GEN
        .wrapping_mul(ix)
        .wrapping_add(Y_GEN.wrapping_mul(iy))
        .wrapping_add(Z_GEN.wrapping_mul(iz))
        .wrapping_add(SEED_GEN.wrapping_mul(seed));
    index ^= index >> SHIFT_GEN;
    index &= 0xff;
    let row = usize::try_from(index).unwrap_or(0) << 2;
    let g = |k: usize| VECTORS.get(row + k).copied().unwrap_or(0.0);
    (g(0) * (fx - f64::from(ix)) + g(1) * (fy - f64::from(iy)) + g(2) * (fz - f64::from(iz))) * 2.12
}

/// libnoise `GradientCoherentNoise3D` at standard quality (the S-curve of 3a^2 - 2a^3).
fn gradient_coherent(x: f64, y: f64, z: f64, seed: i32) -> f64 {
    let (x0, y0, z0) = (floor_int(x), floor_int(y), floor_int(z));
    let (x1, y1, z1) = (x0.wrapping_add(1), y0.wrapping_add(1), z0.wrapping_add(1));
    let xs = s_curve3(x - f64::from(x0));
    let ys = s_curve3(y - f64::from(y0));
    let zs = s_curve3(z - f64::from(z0));
    let n = |ix: i32, iy: i32, iz: i32| gradient_noise(x, y, z, ix, iy, iz, seed);
    let ix0 = lerp(n(x0, y0, z0), n(x1, y0, z0), xs);
    let ix1 = lerp(n(x0, y1, z0), n(x1, y1, z0), xs);
    let iy0 = lerp(ix0, ix1, ys);
    let ix0 = lerp(n(x0, y0, z1), n(x1, y0, z1), xs);
    let ix1 = lerp(n(x0, y1, z1), n(x1, y1, z1), xs);
    let iy1 = lerp(ix0, ix1, ys);
    lerp(iy0, iy1, zs)
}

/// libnoise `IntValueNoise3D`: a hash of the cube corner.
fn int_value_noise(x: i32, y: i32, z: i32, seed: i32) -> i32 {
    let mut n = X_GEN
        .wrapping_mul(x)
        .wrapping_add(Y_GEN.wrapping_mul(y))
        .wrapping_add(Z_GEN.wrapping_mul(z))
        .wrapping_add(SEED_GEN.wrapping_mul(seed))
        & 0x7fff_ffff;
    n = (n >> 13) ^ n;
    n.wrapping_mul(n.wrapping_mul(n).wrapping_mul(60493).wrapping_add(19_990_303))
        .wrapping_add(1_376_312_589)
        & 0x7fff_ffff
}

fn value_noise(x: i32, y: i32, z: i32, seed: i32) -> f64 {
    1.0 - f64::from(int_value_noise(x, y, z, seed)) / 1_073_741_824.0
}

impl Noise {
    /// The value at a position, mm, roughly in -1 to 1 (Billow and Voronoi can leave that range).
    pub(crate) fn value(&self, x: f64, y: f64, z: f64) -> f64 {
        match *self {
            Self::Perlin {
                frequency,
                octaves,
                persistence,
            } => {
                let (mut x, mut y, mut z) = (x * frequency, y * frequency, z * frequency);
                let (mut value, mut cur) = (0.0, 1.0);
                for octave in 0..octaves {
                    let signal = gradient_coherent(int32_range(x), int32_range(y), int32_range(z), octave);
                    value += signal * cur;
                    (x, y, z) = (x * LACUNARITY, y * LACUNARITY, z * LACUNARITY);
                    cur *= persistence;
                }
                value
            }
            Self::Billow {
                frequency,
                octaves,
                persistence,
            } => {
                let (mut x, mut y, mut z) = (x * frequency, y * frequency, z * frequency);
                let (mut value, mut cur) = (0.0, 1.0);
                for octave in 0..octaves {
                    let signal = gradient_coherent(int32_range(x), int32_range(y), int32_range(z), octave);
                    value += (2.0 * signal.abs() - 1.0) * cur;
                    (x, y, z) = (x * LACUNARITY, y * LACUNARITY, z * LACUNARITY);
                    cur *= persistence;
                }
                value + 0.5
            }
            Self::Ridged { frequency, octaves } => {
                let (mut x, mut y, mut z) = (x * frequency, y * frequency, z * frequency);
                let (mut value, mut weight) = (0.0, 1.0);
                for octave in 0..octaves {
                    let signal = gradient_coherent(int32_range(x), int32_range(y), int32_range(z), octave);
                    let mut signal = 1.0 - signal.abs();
                    signal *= signal;
                    signal *= weight;
                    weight = (signal * 2.0).clamp(0.0, 1.0);
                    // The spectral weight of this octave: lacunarity ^ -octave.
                    value += signal * LACUNARITY.m_powi(-octave);
                    (x, y, z) = (x * LACUNARITY, y * LACUNARITY, z * LACUNARITY);
                }
                value * 1.25 - 1.0
            }
            Self::Voronoi { frequency } => voronoi(x * frequency, y * frequency, z * frequency),
        }
    }
}

/// libnoise `Voronoi` with displacement 1 and no distance term: every cell takes the value noise of
/// its seed point.
fn voronoi(x: f64, y: f64, z: f64) -> f64 {
    let (xi, yi, zi) = (floor_int(x), floor_int(y), floor_int(z));
    let mut min = 2_147_483_647.0_f64;
    let mut best = (0.0, 0.0, 0.0);
    for zc in zi - 2..=zi + 2 {
        for yc in yi - 2..=yi + 2 {
            for xc in xi - 2..=xi + 2 {
                let px = f64::from(xc) + value_noise(xc, yc, zc, 0);
                let py = f64::from(yc) + value_noise(xc, yc, zc, 1);
                let pz = f64::from(zc) + value_noise(xc, yc, zc, 2);
                let d = (px - x).m_powi(2) + (py - y).m_powi(2) + (pz - z).m_powi(2);
                if d < min {
                    min = d;
                    best = (px, py, pz);
                }
            }
        }
    }
    #[allow(clippy::cast_possible_truncation, reason = "libnoise casts the cell to int")]
    let at = |v: f64| v.floor() as i32;
    value_noise(at(best.0), at(best.1), at(best.2), 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_rows_are_unit_vectors() {
        for row in VECTORS.chunks(4) {
            let l = (row[0] * row[0] + row[1] * row[1] + row[2] * row[2]).sqrt();
            assert!((l - 1.0).abs() < 1e-3, "{row:?}");
            assert!(row[3].abs() < 1e-12);
        }
    }

    #[test]
    fn a_gradient_noise_is_zero_on_the_lattice_and_smooth_between() {
        let p = Noise::Perlin {
            frequency: 1.0,
            octaves: 1,
            persistence: 0.5,
        };
        assert!(p.value(3.0, 4.0, 5.0).abs() < 1e-12);
        let (a, b) = (p.value(3.40, 4.2, 5.1), p.value(3.41, 4.2, 5.1));
        assert!((a - b).abs() < 0.05 && a.abs() < 1.5, "{a} {b}");
    }

    #[test]
    fn the_generators_are_repeatable_and_bounded_over_a_plane() {
        let kinds = [
            Noise::Perlin {
                frequency: 1.0,
                octaves: 4,
                persistence: 0.5,
            },
            Noise::Billow {
                frequency: 1.0,
                octaves: 4,
                persistence: 0.5,
            },
            Noise::Ridged {
                frequency: 1.0,
                octaves: 4,
            },
            Noise::Voronoi { frequency: 1.0 },
        ];
        for k in kinds {
            let (mut lo, mut hi) = (f64::MAX, f64::MIN);
            for i in 0..2000 {
                let (x, y) = (f64::from(i) * 0.137, f64::from(i % 37) * 0.291);
                let v = k.value(x, y, 0.3);
                assert_eq!(v.to_bits(), k.value(x, y, 0.3).to_bits());
                (lo, hi) = (lo.min(v), hi.max(v));
            }
            assert!(lo > -3.0 && hi < 3.0 && hi - lo > 0.3, "{k:?} {lo} {hi}");
        }
    }

    #[test]
    fn a_voronoi_cell_has_one_value() {
        let v = Noise::Voronoi { frequency: 1.0 };
        // Two points a hair apart share a cell, so a value.
        assert_eq!(
            v.value(2.50, 2.50, 0.0).to_bits(),
            v.value(2.5001, 2.5, 0.0).to_bits()
        );
    }
}
