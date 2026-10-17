// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// ciede2000, sharma/wu/dalal (2005), equations 2-22; unit weighting factors.

pub(super) fn distance(left: [u8; 3], right: [u8; 3]) -> f64 {
    delta_e(lab(left), lab(right))
}

fn lab(rgb: [u8; 3]) -> [f64; 3] {
    let [red, green, blue] = rgb.map(|byte| {
        let value = f64::from(byte) / 255.0;
        if value <= 0.04045 {
            value / 12.92
        } else {
            ((value + 0.055) / 1.055).powf(2.4)
        }
    });
    let xyz = [
        (0.412_456_4 * red + 0.357_576_1 * green + 0.180_437_5 * blue) / 0.95047,
        0.212_672_9 * red + 0.715_152_2 * green + 0.072_175_0 * blue,
        (0.019_333_9 * red + 0.119_192_0 * green + 0.950_304_1 * blue) / 1.08883,
    ];
    let [x, y, z] = xyz.map(|value| {
        let edge = 6.0_f64 / 29.0;
        if value > edge.powi(3) {
            value.cbrt()
        } else {
            value / (3.0 * edge.powi(2)) + 4.0 / 29.0
        }
    });
    [116.0 * y - 16.0, 500.0 * (x - y), 200.0 * (y - z)]
}

fn chroma_ratio(chroma: f64) -> f64 {
    let power = chroma.powi(7);
    (power / (power + 25.0_f64.powi(7))).sqrt()
}

fn hue(a: f64, b: f64) -> f64 {
    if a.abs() + b.abs() <= f64::EPSILON {
        0.0
    } else {
        b.atan2(a).to_degrees().rem_euclid(360.0)
    }
}

fn delta_e(left: [f64; 3], right: [f64; 3]) -> f64 {
    let [light_left, a_left, b_left] = left;
    let [light_right, a_right, b_right] = right;
    let adjustment = 0.5 * (1.0 - chroma_ratio(a_left.hypot(b_left).midpoint(a_right.hypot(b_right))));
    let a_left = a_left * (1.0 + adjustment);
    let a_right = a_right * (1.0 + adjustment);
    let chroma_left = a_left.hypot(b_left);
    let chroma_right = a_right.hypot(b_right);
    let hue_left = hue(a_left, b_left);
    let hue_right = hue(a_right, b_right);
    let achromatic = chroma_left * chroma_right <= f64::EPSILON;
    let hue_gap = hue_right - hue_left;
    let hue_delta = if achromatic {
        0.0
    } else if hue_gap > 180.0 {
        hue_gap - 360.0
    } else if hue_gap < -180.0 {
        hue_gap + 360.0
    } else {
        hue_gap
    };
    let hue_sum = hue_left + hue_right;
    let mean_hue = if achromatic {
        hue_sum
    } else if hue_gap.abs() <= 180.0 {
        hue_sum / 2.0
    } else if hue_sum < 360.0 {
        hue_sum.midpoint(360.0)
    } else {
        (hue_sum - 360.0) / 2.0
    };
    let mean_chroma = chroma_left.midpoint(chroma_right);
    let light_offset = (light_left.midpoint(light_right) - 50.0).powi(2);
    let cosine = |degrees: f64| degrees.to_radians().cos();
    let hue_weight = 1.0 - 0.17 * cosine(mean_hue - 30.0)
        + 0.24 * cosine(2.0 * mean_hue)
        + 0.32 * cosine(3.0 * mean_hue + 6.0)
        - 0.20 * cosine(4.0 * mean_hue - 63.0);
    let light = (light_right - light_left) / (1.0 + 0.015 * light_offset / (20.0 + light_offset).sqrt());
    let chroma = (chroma_right - chroma_left) / (1.0 + 0.045 * mean_chroma);
    let hue = 2.0 * (chroma_left * chroma_right).sqrt() * (hue_delta / 2.0).to_radians().sin()
        / (1.0 + 0.015 * mean_chroma * hue_weight);
    let rotation = (60.0 * (-((mean_hue - 275.0) / 25.0).powi(2)).exp())
        .to_radians()
        .sin();
    (light.powi(2) + chroma.powi(2) + hue.powi(2) - 2.0 * chroma_ratio(mean_chroma) * rotation * chroma * hue)
        .max(0.0)
        .sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn published_pairs_cover_signed_differences_gray_and_hue_wrap() {
        // sharma/wu/dalal table 1, including both sides of the hue discontinuity.
        let pairs = [
            ([50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485], 2.0425),
            ([50.0, 3.1571, -77.2803], [50.0, 0.0, -82.7485], 2.8615),
            ([50.0, -1.3802, -84.2814], [50.0, 0.0, -82.7485], 1.0),
            ([50.0, 0.0, 0.0], [50.0, -1.0, 2.0], 2.3669),
            ([50.0, 2.49, -0.001], [50.0, -2.49, 0.0009], 7.1792),
            ([50.0, 2.49, -0.001], [50.0, -2.49, 0.0011], 7.2195),
            ([50.0, -0.001, 2.49], [50.0, 0.0009, -2.49], 4.8045),
            ([50.0, -0.001, 2.49], [50.0, 0.0011, -2.49], 4.7461),
        ];
        for (left, right, expected) in pairs {
            assert!((delta_e(left, right) - expected).abs() < 0.0001);
            assert!((delta_e(right, left) - expected).abs() < 0.0001);
        }
    }

    #[test]
    fn rgb_identity_near_match_and_distinct_colors() {
        assert!(distance([255, 0, 0], [255, 0, 0]) < 1e-10);
        assert!(distance([255, 0, 0], [254, 0, 0]) < 2.0);
        assert!(distance([255, 0, 0], [0, 255, 0]) > 2.0);
        assert!(distance([0, 0, 0], [255, 255, 255]) > 99.0);
    }
}
