// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Infill rotation templates (`sparse_infill_rotate_template`, `solid_infill_rotate_template`): the
//! direction of the infill lines per layer, from a list of angles or Orca's template language
//! (Orca 2.4.2 `calculate_infill_rotation_angle` in Fill/Fill.cpp; our own implementation).
//!
//! A plain list such as `0,90` or `0,60,120` gives layer `i` the angle `i mod n`. Otherwise each token is
//! `[+-]angle[%][*repeats][joint][-]count[unit][!]`: an angle without a sign is absolute, with a sign it
//! turns from the angle reached so far; `%` reads it as a percent of a full turn. The count is layers, or
//! `B` and `T` for the bottom and top shell layers, or a height with `mm`, `cm`, `m`, `'` (feet), `"`
//! (inches), `#` (layer heights) or `%` (of the object's height). The joint shapes the turn over that range:
//! `/` linear, `N n Z z` sines, `$` arcsine, `L l` quarter circles, `U u` squares, `Q q` cubes, `~` and `^`
//! random, `|` half way and `#` the whole turn at once. A `-` before the count runs the joint backward,
//! `*n` repeats the token n times and `!` runs it once.
//!
//! Unlike Orca, the random joints use a hash of the layer number, so every run and every shard of a slice
//! gets the same angles.

use crate::fm::Fm as _;
use crate::layers::LayerPlan;

/// The template's angle for object layer `layer`, degrees; `None` when the template is empty or not
/// readable (the plain direction setting applies then).
pub(crate) fn angle(
    template: &str,
    layer: u32,
    plan: &LayerPlan,
    layer_height: f64,
    shells: (u32, u32),
) -> Option<f64> {
    let template = template.trim();
    if template.is_empty() || plan.count() == 0 {
        return None;
    }
    if !template
        .bytes()
        .any(|b| b"+-%*@'\"cm/NnZz$LlUuQq~^|#".contains(&b))
    {
        let list: Option<Vec<f64>> = template
            .split(',')
            .map(|s| s.trim().parse::<f64>().ok().filter(|v| v.is_finite()))
            .collect();
        let list = list.filter(|l| !l.is_empty())?;
        return list.get(layer as usize % list.len()).copied();
    }
    let tokens: Vec<&[u8]> = template
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|t| !t.is_empty())
        .map(str::as_bytes)
        .collect();
    if tokens.is_empty() {
        return None;
    }
    Some(Eval::new(tokens, plan, layer_height, shells).run(layer.min(plan.count() - 1)))
}

/// The joints, in Orca's order of `/NnZz$LlUuQq~^|#`.
const JOINTS: &[u8] = b"/NnZz$LlUuQq~^|#";

struct Eval<'a> {
    tokens: Vec<&'a [u8]>,
    plan: &'a LayerPlan,
    layer_height: f64,
    shells: (u32, u32),
}

impl<'a> Eval<'a> {
    fn new(tokens: Vec<&'a [u8]>, plan: &'a LayerPlan, layer_height: f64, shells: (u32, u32)) -> Self {
        Self {
            tokens,
            plan,
            layer_height,
            shells,
        }
    }

    fn bottom(&self, i: u32) -> f64 {
        self.plan.top(i) - self.plan.thickness(i)
    }

    #[allow(clippy::too_many_lines, reason = "one pass of the template state machine")]
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss,
        reason = "layer counts"
    )]
    fn run(&self, layer: u32) -> f64 {
        let n = self.plan.count();
        let height = self.plan.top(n - 1) - self.bottom(0);
        let len = self.tokens.len();
        let mut stop = vec![false; len];
        let (mut t, mut repeats) = (0usize, 0i64);
        let (mut add, mut start) = (0.0f64, 0.0f64);
        let mut limit_z = self.bottom(0);
        let mut start_z = limit_z;
        let (mut joint, mut negative) = (None::<usize>, false);
        let mut noop = false;
        let mut angle = 0.0;
        for i in 0..=layer {
            let fill_z = self.bottom(i);
            if limit_z < self.plan.slice_z.get(i as usize).copied().unwrap_or(f64::MAX) {
                if repeats > 0 {
                    limit_z += limit_z - start_z;
                    start_z = fill_z;
                    repeats -= 1;
                } else {
                    start_z = fill_z;
                    limit_z = self.plan.top(i);
                    joint = None;
                    loop {
                        if !stop.get(t).copied().unwrap_or(true) {
                            let tk = self.tokens.get(t).copied().unwrap_or_default();
                            noop = false;
                            negative = false;
                            start += add;
                            repeats = 1;
                            if tk.contains(&b'!')
                                && let Some(s) = stop.get_mut(t)
                            {
                                *s = true;
                            }
                            let absolute = tk.first().is_some_and(u8::is_ascii_digit);
                            let (a, used) = strtod(tk);
                            add = a;
                            let mut cs = tk.get(used..).unwrap_or_default();
                            if cs.first() == Some(&b'%') {
                                add *= 3.6;
                                cs = cs.get(1..).unwrap_or_default();
                            }
                            if let Some(star) = tk.iter().position(|&b| b == b'*') {
                                let rest = tk.get(star + 1..).unwrap_or_default();
                                let (r, used) = strtol0(rest);
                                repeats = r;
                                cs = rest.get(used..).unwrap_or_default();
                            }
                            if repeats != 0 {
                                let steps = match cs.first() {
                                    Some(b'B') => f64::from(self.shells.0),
                                    Some(b'T') => f64::from(self.shells.1),
                                    first => {
                                        joint = first.and_then(|c| JOINTS.iter().position(|j| j == c));
                                        if joint.is_some() {
                                            cs = cs.get(1..).unwrap_or_default();
                                        }
                                        negative = cs.first() == Some(&b'-');
                                        let (v, used) = strtod(cs);
                                        let steps = v.abs();
                                        cs = cs.get(used..).unwrap_or_default();
                                        if steps != 0.0 && cs.first().is_some_and(|&c| c != b'!') {
                                            limit_z = match (cs.first(), cs.get(1)) {
                                                (Some(b'%'), _) => steps * height / 100.0,
                                                (Some(b'#'), _) => steps * self.layer_height,
                                                (Some(b'\''), _) => steps * 12.0 * 25.4,
                                                (Some(b'"'), _) => steps * 25.4,
                                                (Some(b'c'), _) => steps * 10.0,
                                                (Some(b'm'), Some(b'm')) => steps,
                                                (Some(b'm'), _) => steps * 1000.0,
                                                _ => limit_z,
                                            };
                                            limit_z += fill_z;
                                            0.0
                                        } else {
                                            steps
                                        }
                                    }
                                };
                                if steps != 0.0 {
                                    if joint.is_none() && !absolute {
                                        add *= steps.trunc();
                                    }
                                    let idx = i64::from(i) + (steps - 1.0).max(0.0) as i64;
                                    let over = (idx - i64::from(n)).max(0);
                                    let idx = idx.min(i64::from(n) - 1) as u32;
                                    limit_z = self.plan.top(idx) + over as f64 * self.layer_height;
                                }
                                repeats = (repeats - 1).max(0);
                            } else {
                                noop = true;
                            }
                            if absolute {
                                start = add;
                                add = 0.0;
                            }
                        }
                        t = (t + 1) % len;
                        if stop.iter().all(|&s| s) {
                            break;
                        }
                        if !((t != 0 && noop) || stop.get(t).copied().unwrap_or(false)) {
                            break;
                        }
                    }
                }
            }
            let top_z = self.plan.top(i);
            let span = limit_z - start_z;
            let mut v = if span.abs() < 1e-12 {
                1.0
            } else if negative {
                (limit_z - top_z) / span
            } else {
                (top_z - start_z) / span
            };
            let tau = 2.0 * std::f64::consts::PI;
            v = match joint {
                Some(1) => v - (v * tau).m_sin() / tau,
                Some(2) => v - (v * tau).m_sin() / (2.0 * tau),
                Some(3) => v + (v * tau).m_sin() / tau,
                Some(4) => v + (v * tau).m_sin() / (2.0 * tau),
                Some(5) => (v * 2.0 - 1.0).clamp(-1.0, 1.0).m_asin() / std::f64::consts::PI + 0.5,
                Some(6) => (v * std::f64::consts::FRAC_PI_2).m_sin(),
                Some(7) => 1.0 - (v * std::f64::consts::FRAC_PI_2).m_cos(),
                Some(8) => 1.0 - (1.0 - v) * (1.0 - v),
                Some(9) => (1.0 - v) * (1.0 - v),
                Some(10) => 1.0 - (1.0 - v).m_powi(3),
                Some(11) => (1.0 - v).m_powi(3),
                Some(12) => unit_hash(i),
                Some(13) => v + unit_hash(i) - 0.5,
                Some(14) => 0.5,
                Some(15) => {
                    if negative {
                        0.0
                    } else {
                        1.0
                    }
                }
                _ => v,
            };
            angle = start + add * v;
        }
        angle
    }
}

/// A number in `[0, 1]` from the layer number, the same on every run.
fn unit_hash(i: u32) -> f64 {
    let mut x = u64::from(i).wrapping_add(0x9E37_79B9_7F4A_7C15);
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^= x >> 31;
    #[allow(clippy::cast_precision_loss, reason = "53 bits of the hash")]
    {
        (x >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// The leading decimal number of `s` as C's `strtod` reads it, and the bytes it used (0 when none).
fn strtod(s: &[u8]) -> (f64, usize) {
    let mut i = 0;
    while s.get(i).is_some_and(u8::is_ascii_whitespace) {
        i += 1;
    }
    let begin = i;
    if matches!(s.get(i), Some(b'+' | b'-')) {
        i += 1;
    }
    let digits_from = i;
    while s.get(i).is_some_and(u8::is_ascii_digit) {
        i += 1;
    }
    let mut digits = i - digits_from;
    if s.get(i) == Some(&b'.') {
        let frac = i + 1;
        let mut j = frac;
        while s.get(j).is_some_and(u8::is_ascii_digit) {
            j += 1;
        }
        digits += j - frac;
        if digits > 0 {
            i = j;
        }
    }
    if digits == 0 {
        return (0.0, 0);
    }
    if matches!(s.get(i), Some(b'e' | b'E')) {
        let mut j = i + 1;
        if matches!(s.get(j), Some(b'+' | b'-')) {
            j += 1;
        }
        let from = j;
        while s.get(j).is_some_and(u8::is_ascii_digit) {
            j += 1;
        }
        if j > from {
            i = j;
        }
    }
    let text = std::str::from_utf8(s.get(begin..i).unwrap_or_default()).unwrap_or("0");
    (text.parse::<f64>().unwrap_or(0.0), i)
}

/// The leading integer of `s` as C's `strtol` with base 0 reads it (hex after `0x`, octal after `0`),
/// and the bytes it used (0 when none).
fn strtol0(s: &[u8]) -> (i64, usize) {
    let mut i = 0;
    while s.get(i).is_some_and(u8::is_ascii_whitespace) {
        i += 1;
    }
    let neg = s.get(i) == Some(&b'-');
    if matches!(s.get(i), Some(b'+' | b'-')) {
        i += 1;
    }
    let (radix, from) = match (s.get(i), s.get(i + 1)) {
        (Some(b'0'), Some(b'x' | b'X')) if s.get(i + 2).is_some_and(u8::is_ascii_hexdigit) => (16, i + 2),
        (Some(b'0'), _) => (8, i),
        _ => (10, i),
    };
    let mut j = from;
    let mut v: i64 = 0;
    while let Some(d) = s.get(j).and_then(|&c| char::from(c).to_digit(radix)) {
        v = v.saturating_mul(i64::from(radix)).saturating_add(i64::from(d));
        j += 1;
    }
    if j == from {
        return (0, 0);
    }
    (if neg { -v } else { v }, j)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(n: u32) -> LayerPlan {
        LayerPlan::new(0.2 * f64::from(n) - 0.05, 0.2, 0.2)
    }

    fn angles(t: &str, n: u32) -> Vec<f64> {
        let p = plan(n);
        (0..n)
            .map(|l| angle(t, l, &p, 0.2, (3, 5)).unwrap_or(f64::NAN))
            .collect()
    }

    #[test]
    fn a_plain_list_repeats() {
        assert_eq!(angles("0,90", 4), vec![0.0, 90.0, 0.0, 90.0]);
        assert_eq!(angles("0, 60, 120", 4), vec![0.0, 60.0, 120.0, 0.0]);
        assert!(angle("", 0, &plan(3), 0.2, (3, 5)).is_none());
        assert!(angle("a,b", 0, &plan(3), 0.2, (3, 5)).is_none());
    }

    #[test]
    fn relative_steps_turn_every_layer_or_every_few() {
        assert_eq!(angles("+5", 3), vec![5.0, 10.0, 15.0]);
        assert_eq!(
            angles("+5#5", 11),
            vec![5.0, 5.0, 5.0, 5.0, 5.0, 10.0, 10.0, 10.0, 10.0, 10.0, 15.0]
        );
    }

    #[test]
    fn a_linear_joint_spreads_the_turn_over_its_layers() {
        let a = angles("+90/4", 8);
        assert!((a[0] - 22.5).abs() < 1e-9 && (a[3] - 90.0).abs() < 1e-9, "{a:?}");
        assert!((a[7] - 180.0).abs() < 1e-9, "{a:?}");
    }

    #[test]
    fn numbers_read_like_c() {
        assert_eq!(strtod(b"+5#5"), (5.0, 2));
        assert_eq!(strtod(b"12.5mm"), (12.5, 4));
        assert_eq!(strtod(b"5e"), (5.0, 1));
        assert_eq!(strtod(b"#5"), (0.0, 0));
        assert_eq!(strtol0(b"3N10"), (3, 1));
        assert_eq!(strtol0(b"0x1f"), (31, 4));
        assert_eq!(strtol0(b""), (0, 0));
    }
}
