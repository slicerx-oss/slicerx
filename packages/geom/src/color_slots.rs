// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Colors to filament slots: the nearest filament as people see colors (CIEDE2000 in CIELAB, D65), and a palette of a
//! few colors for a weighted color set (k-means in CIELAB). Kept apart from the readers that find the colors, so
//! every reader that maps a model's colors to filaments can share it.
// fixed-size colors and points, indexed by 0, 1 and 2
#![allow(clippy::indexing_slicing)]

use crate::fm::Fm as _;

/// A color in CIELAB (D65): lightness 0 to 100, then a and b.
pub type Lab = [f64; 3];

fn linear(c: u8) -> f64 {
    let v = f64::from(c) / 255.0;
    if v <= 0.040_45 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).m_powf(2.4)
    }
}

fn encoded(v: f64) -> u8 {
    let v = v.clamp(0.0, 1.0);
    let s = if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.m_powf(1.0 / 2.4) - 0.055
    };
    // within 0 to 255 after the clamp
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let out = (s * 255.0).round().clamp(0.0, 255.0) as u8;
    out
}

const WHITE: [f64; 3] = [0.950_47, 1.0, 1.088_83];

fn f(t: f64) -> f64 {
    if t > 216.0 / 24389.0 {
        t.m_cbrt()
    } else {
        (24389.0 / 27.0 * t + 16.0) / 116.0
    }
}

fn f_inv(t: f64) -> f64 {
    let c = t * t * t;
    if c > 216.0 / 24389.0 {
        c
    } else {
        (116.0 * t - 16.0) * 27.0 / 24389.0
    }
}

/// An sRGB color in CIELAB.
#[must_use]
pub fn lab(c: [u8; 3]) -> Lab {
    let [r, g, b] = c.map(linear);
    let x = 0.412_456_4 * r + 0.357_576_1 * g + 0.180_437_5 * b;
    let y = 0.212_672_9 * r + 0.715_152_2 * g + 0.072_175 * b;
    let z = 0.019_333_9 * r + 0.119_192 * g + 0.950_304_1 * b;
    let (fx, fy, fz) = (f(x / WHITE[0]), f(y / WHITE[1]), f(z / WHITE[2]));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

/// A CIELAB color back in sRGB, clamped to what sRGB holds.
#[must_use]
pub fn srgb(l: Lab) -> [u8; 3] {
    let fy = (l[0] + 16.0) / 116.0;
    let fx = fy + l[1] / 500.0;
    let fz = fy - l[2] / 200.0;
    let (x, y, z) = (f_inv(fx) * WHITE[0], f_inv(fy) * WHITE[1], f_inv(fz) * WHITE[2]);
    let r = 3.240_454_2 * x - 1.537_138_5 * y - 0.498_531_4 * z;
    let g = -0.969_266 * x + 1.876_010_8 * y + 0.041_556 * z;
    let b = 0.055_643_4 * x - 0.204_025_9 * y + 1.057_225_2 * z;
    [encoded(r), encoded(g), encoded(b)]
}

/// How far apart two colors look (CIEDE2000): about 1 is the smallest difference people notice.
#[must_use]
pub fn delta_e(a: Lab, b: Lab) -> f64 {
    let (l1, a1, b1) = (a[0], a[1], a[2]);
    let (l2, a2, b2) = (b[0], b[1], b[2]);
    let c1 = a1.m_hypot(b1);
    let c2 = a2.m_hypot(b2);
    let cm = f64::midpoint(c1, c2);
    let c7 = cm.m_powi(7);
    let g = 0.5 * (1.0 - (c7 / (c7 + 25f64.m_powi(7))).sqrt());
    let (a1p, a2p) = (a1 * (1.0 + g), a2 * (1.0 + g));
    let (c1p, c2p) = (a1p.m_hypot(b1), a2p.m_hypot(b2));
    let hue = |bb: f64, ap: f64| {
        if bb == 0.0 && ap == 0.0 {
            0.0
        } else {
            bb.m_atan2(ap).to_degrees().rem_euclid(360.0)
        }
    };
    let (h1, h2) = (hue(b1, a1p), hue(b2, a2p));
    let dl = l2 - l1;
    let dc = c2p - c1p;
    let dh = if c1p * c2p == 0.0 {
        0.0
    } else if (h2 - h1).abs() <= 180.0 {
        h2 - h1
    } else if h2 <= h1 {
        h2 - h1 + 360.0
    } else {
        h2 - h1 - 360.0
    };
    let dhh = 2.0 * (c1p * c2p).sqrt() * (dh / 2.0).to_radians().m_sin();
    let lm = f64::midpoint(l1, l2);
    let cmp = f64::midpoint(c1p, c2p);
    let hm = if c1p * c2p == 0.0 {
        h1 + h2
    } else if (h1 - h2).abs() <= 180.0 {
        f64::midpoint(h1, h2)
    } else if h1 + h2 < 360.0 {
        (h1 + h2 + 360.0) / 2.0
    } else {
        (h1 + h2 - 360.0) / 2.0
    };
    let t = 1.0 - 0.17 * (hm - 30.0).to_radians().m_cos()
        + 0.24 * (2.0 * hm).to_radians().m_cos()
        + 0.32 * (3.0 * hm + 6.0).to_radians().m_cos()
        - 0.20 * (4.0 * hm - 63.0).to_radians().m_cos();
    let d_theta = 30.0 * (-((hm - 275.0) / 25.0).m_powi(2)).m_exp();
    let c7p = cmp.m_powi(7);
    let rc = 2.0 * (c7p / (c7p + 25f64.m_powi(7))).sqrt();
    let l50 = (lm - 50.0).m_powi(2);
    let sl = 1.0 + 0.015 * l50 / (20.0 + l50).sqrt();
    let sc = 1.0 + 0.045 * cmp;
    let sh = 1.0 + 0.015 * cmp * t;
    let rt = -(2.0 * d_theta).to_radians().m_sin() * rc;
    let (x, y, z) = (dl / sl, dc / sc, dhh / sh);
    (x * x + y * y + z * z + rt * y * z).max(0.0).sqrt()
}

/// The 1 based slot of the nearest filament color for each color (CIEDE2000); ties go to the lower slot. With no
/// filaments every color gets 0, no slot.
#[must_use]
pub fn nearest_slots(colors: &[[u8; 3]], filaments: &[[u8; 3]]) -> Vec<u8> {
    let labs: Vec<Lab> = filaments.iter().map(|&c| lab(c)).collect();
    colors
        .iter()
        .map(|&c| {
            let x = lab(c);
            let mut best: Option<(usize, f64)> = None;
            for (i, &l) in labs.iter().enumerate() {
                let d = delta_e(x, l);
                if best.is_none_or(|(_, bd)| d < bd) {
                    best = Some((i, d));
                }
            }
            best.map_or(0, |(i, _)| u8::try_from(i + 1).unwrap_or(u8::MAX))
        })
        .collect()
}

fn dist2(a: Lab, b: Lab) -> f64 {
    (a[0] - b[0]).m_powi(2) + (a[1] - b[1]).m_powi(2) + (a[2] - b[2]).m_powi(2)
}

/// Up to `n` colors for a weighted color set, by k-means in CIELAB. The first seed is the heaviest color, each next
/// one the color farthest from the seeds so far by weight times squared distance, so the result is the same every
/// time. Fewer colors come back when the set has fewer distinct ones.
#[must_use]
pub fn palette(colors: &[([u8; 3], f64)], n: usize) -> Vec<[u8; 3]> {
    let pts: Vec<(Lab, f64)> = colors
        .iter()
        .filter(|(_, w)| *w > 0.0 && w.is_finite())
        .map(|&(c, w)| (lab(c), w))
        .collect();
    if pts.is_empty() || n == 0 {
        return Vec::new();
    }
    let mut seeds: Vec<Lab> = Vec::new();
    let heaviest = pts
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.1.total_cmp(&b.1.1).then(b.0.cmp(&a.0)))
        .map_or(pts[0].0, |(_, p)| p.0);
    seeds.push(heaviest);
    while seeds.len() < n {
        let far = pts
            .iter()
            .map(|&(p, w)| {
                let d = seeds.iter().map(|&s| dist2(p, s)).fold(f64::INFINITY, f64::min);
                (p, w * d)
            })
            .enumerate()
            .max_by(|a, b| a.1.1.total_cmp(&b.1.1).then(b.0.cmp(&a.0)));
        match far {
            Some((_, (p, score))) if score > 1e-9 => seeds.push(p),
            _ => break,
        }
    }
    let mut centers = seeds;
    for _ in 0..24 {
        let mut sums = vec![([0.0f64; 3], 0.0f64); centers.len()];
        for &(p, w) in &pts {
            let k = (0..centers.len())
                .min_by(|&a, &b| dist2(p, centers[a]).total_cmp(&dist2(p, centers[b])))
                .unwrap_or(0);
            let s = &mut sums[k];
            for (sum, c) in s.0.iter_mut().zip(p) {
                *sum += c * w;
            }
            s.1 += w;
        }
        let mut moved = 0.0f64;
        for (c, (s, w)) in centers.iter_mut().zip(sums) {
            if w > 0.0 {
                let next = [s[0] / w, s[1] / w, s[2] / w];
                moved = moved.max(dist2(*c, next));
                *c = next;
            }
        }
        if moved < 1e-6 {
            break;
        }
    }
    let mut out: Vec<[u8; 3]> = Vec::with_capacity(centers.len());
    for c in centers {
        let rgb = srgb(c);
        if !out.contains(&rgb) {
            out.push(rgb);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const RED: [u8; 3] = [230, 20, 30];
    const GREEN: [u8; 3] = [20, 200, 40];
    const BLUE: [u8; 3] = [20, 40, 220];
    const BLACK: [u8; 3] = [10, 10, 10];
    const WHITE_C: [u8; 3] = [245, 245, 245];

    #[test]
    fn pure_colors_go_to_their_own_filament() {
        let fil = [BLACK, WHITE_C, RED, GREEN, BLUE];
        let got = nearest_slots(
            &[[255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 0, 0], [255, 255, 255]],
            &fil,
        );
        assert_eq!(got, vec![3, 4, 5, 1, 2]);
    }

    #[test]
    fn a_light_gray_is_nearer_white_and_a_dark_gray_nearer_black() {
        let fil = [BLACK, WHITE_C];
        assert_eq!(nearest_slots(&[[200, 200, 200], [60, 60, 60]], &fil), vec![2, 1]);
    }

    #[test]
    fn a_tie_goes_to_the_lower_slot_and_no_filament_is_slot_0() {
        assert_eq!(nearest_slots(&[RED], &[BLUE, BLUE]), vec![1]);
        assert_eq!(nearest_slots(&[RED, BLUE], &[]), vec![0, 0]);
        assert_eq!(nearest_slots(&[RED, BLUE], &[GREEN]), vec![1, 1]);
    }

    #[test]
    fn lab_goes_back_to_the_same_srgb() {
        for c in [
            RED,
            GREEN,
            BLUE,
            BLACK,
            WHITE_C,
            [128, 64, 200],
            [0, 0, 0],
            [255, 255, 255],
        ] {
            assert_eq!(srgb(lab(c)), c);
        }
    }

    #[test]
    fn ciede2000_matches_the_published_pairs() {
        // Sharma, Wu and Dalal's test data, pairs 1, 7 and 17
        let pairs = [
            ([50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485], 2.0425),
            ([50.0, 0.0, 0.0], [50.0, -1.0, 2.0], 2.3669),
            ([50.0, 2.5, 0.0], [73.0, 25.0, -18.0], 27.1492),
        ];
        for (a, b, want) in pairs {
            assert!(
                (delta_e(a, b) - want).abs() < 1e-3,
                "{a:?} {b:?}: {}",
                delta_e(a, b)
            );
            assert!((delta_e(b, a) - want).abs() < 1e-3);
        }
    }

    #[test]
    fn palette_is_the_same_every_time_and_gives_distinct_colors_back() {
        let set = [(RED, 10.0), ([220, 30, 40], 5.0), (BLUE, 8.0), (GREEN, 1.0)];
        let a = palette(&set, 3);
        assert_eq!(a, palette(&set, 3));
        assert_eq!(a.len(), 3);
        // the reds merge into one center; blue and green keep their own
        assert_eq!(nearest_slots(&[RED, BLUE, GREEN], &a), vec![1, 2, 3]);
        let exact = palette(&[(RED, 1.0), (BLUE, 1.0)], 2);
        assert_eq!(exact.len(), 2);
        assert!(exact.contains(&RED) && exact.contains(&BLUE));
        assert_eq!(palette(&[(RED, 1.0)], 4), vec![RED]);
        assert!(palette(&[], 3).is_empty());
    }
}
