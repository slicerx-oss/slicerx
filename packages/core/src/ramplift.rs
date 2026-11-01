// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The ramp lift (`z_hop_types` Ramp Lift, a `PrusaSlicer` filament's ramping travel lift): a travel climbs along its
//! own path at the `travel_slope` angle from where its retraction and wipe end, up to the lift height or as far as its
//! length takes it, holds that height and drops straight down at its end.
//!
//! Near the top the climb bends over into the height (the blend) when the printer's machine limits say the Z axis
//! cannot stop climbing at once: the bend is centered where the straight climb would reach the height and its length
//! is set by how fast X may travel and how fast Z may speed up and stop. It applies only to a climb at least as long as
//! the travel needs to brake from its top speed, and only when the climb's Z speed takes few enough jerk steps.
//! Without every limit it needs there is no blend.

use crate::config::PrintConfig;
use crate::fm::Fm as _;

/// The most jerk steps a climb's Z speed may take for the blend to apply.
const MOST_STEPS: f64 = 6.0;

/// The machine limits the blend reads, the first value of each (mm/s and mm/s2).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Limits {
    /// `machine_max_speed_x`.
    pub v: f64,
    /// `machine_max_acceleration_travel`.
    pub a: f64,
    /// `machine_max_acceleration_z`.
    pub a_z: f64,
    /// `machine_max_speed_z`.
    pub f_z: f64,
    /// `machine_max_jerk_z`.
    pub j_z: f64,
}

impl Limits {
    /// The printer's limits, when it sets every one above 0.
    pub(crate) fn of(rc: &PrintConfig) -> Option<Self> {
        let get = |k: &str| crate::motion::raw_f(rc, k).filter(|v| v.is_finite() && *v > 0.0);
        Some(Self {
            v: get("machine_max_speed_x")?,
            a: get("machine_max_acceleration_travel")?,
            a_z: get("machine_max_acceleration_z")?,
            f_z: get("machine_max_speed_z")?,
            j_z: get("machine_max_jerk_z")?,
        })
    }
}

/// The Z speed of a climb at slope `k` (rise over run) at the X feed rate limit, capped at the Z limit (mm/s).
pub(crate) fn z_speed(k: f64, lim: &Limits) -> f64 {
    (std::f64::consts::SQRT_2 * lim.v * k).min(lim.f_z)
}

/// The blend a climb at slope `k` (rise over run) gets under `lim`, whether or not a climb is long enough for it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Blend {
    /// How many jerk steps the climb's Z speed ([`z_speed`]) takes.
    pub n: u32,
    /// The bend's length along the travel (mm).
    pub b: f64,
    /// The shortest climb that bends: the X limit squared over the travel acceleration limit (mm).
    pub reach: f64,
}

impl Blend {
    pub(crate) fn of(k: f64, lim: &Limits) -> Self {
        let w = z_speed(k, lim);
        let steps = (w / lim.j_z).ceil();
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a small count, checked against the cap before use"
        )]
        let n = steps.clamp(0.0, f64::from(u32::MAX)) as u32;
        Self {
            n,
            b: std::f64::consts::SQRT_2 * lim.v * w / lim.a_z,
            reach: lim.v * lim.v / lim.a,
        }
    }

    fn applies(&self, len: f64) -> bool {
        f64::from(self.n) <= MOST_STEPS && self.n > 0 && self.b > 0.0 && len >= self.reach
    }
}

/// The ramp of one climb: its slope, height and the blend's length when it bends.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Ramp {
    k: f64,
    h: f64,
    /// The blend's length and step count, when this climb bends.
    blend: Option<(f64, u32)>,
}

impl Ramp {
    /// The ramp of a climb `len` mm long, up to `h` mm at `deg` degrees from horizontal (more than 0 and less than
    /// 90), bending into the height when `lim` asks for it.
    pub(crate) fn of(h: f64, deg: f64, lim: Option<&Limits>, len: f64) -> Self {
        let k = deg.to_radians().m_tan();
        let blend = lim
            .map(|l| Blend::of(k, l))
            .filter(|b| b.applies(len))
            .map(|b| (b.b, b.n));
        Self { k, h, blend }
    }

    /// Where the straight climb reaches the height.
    fn reach(&self) -> f64 {
        self.h / self.k
    }

    /// How high the ramp is `s` mm along the climb.
    pub(crate) fn at(&self, s: f64) -> f64 {
        let top = self.reach();
        match self.blend {
            Some((b, _)) if s > top - b / 2.0 => {
                let d = (top + b / 2.0 - s).max(0.0);
                (self.h - self.k / (2.0 * b) * d * d).max(0.0)
            }
            _ => (self.k * s).min(self.h).max(0.0),
        }
    }

    /// Where the climb's written points fall, mm along it, short of `len`: the end of the straight climb, then the
    /// blend's points on its curve (all but its last step of equal length, the last twice as long; a single step
    /// writes the point at the middle of the bend).
    pub(crate) fn knots(&self, len: f64) -> Vec<f64> {
        let top = self.reach();
        let mut out = Vec::new();
        match self.blend {
            None | Some((_, 0 | 1)) => out.push(top),
            Some((b, n)) => {
                let start = top - b / 2.0;
                out.push(start);
                let step = b / f64::from(n);
                for i in 1..n.saturating_sub(1) {
                    out.push(start + step * f64::from(i));
                }
                out.push(top + b / 2.0);
            }
        }
        out.retain(|&s| s > 0.0 && s < len);
        out
    }
}

/// The angle a ramp lift climbs at, degrees: the filament's `travel_slope`, else the printer's, else 3.
pub(crate) fn angle(rc: &PrintConfig) -> f64 {
    crate::motion::raw_f(rc, "travel_slope")
        .filter(|a| a.is_finite())
        .unwrap_or(3.0)
}

/// Whether a ramp at `deg` goes straight up: at 0 degrees or less, or 90 or more.
pub(crate) fn straight(deg: f64) -> bool {
    deg <= 0.0 || deg >= 90.0
}

#[cfg(test)]
mod tests {
    use super::*;

    const MK4: Limits = Limits {
        v: 300.0,
        a: 4000.0,
        a_z: 200.0,
        f_z: 40.0,
        j_z: 2.0,
    };

    fn near(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol
    }

    #[test]
    fn the_blend_of_the_mk4_stock_ramp() {
        let k = 1.0_f64.to_radians().m_tan();
        let b = Blend::of(k, &MK4);
        assert!(near(z_speed(k, &MK4), 7.405, 0.001), "{b:?}");
        assert_eq!(b.n, 4);
        assert!(near(b.b, 15.708, 0.002), "{b:?}");
        assert!(near(b.reach, 22.5, 1e-9), "{b:?}");
        let z = |s: f64| Ramp::of(0.6, 1.0, Some(&MK4), s).at(s);
        assert!(near(z(26.52), 0.463, 0.0005), "{}", z(26.52));
        assert!(near(z(32.93), 0.552, 0.0005), "{}", z(32.93));
        assert!(near(z(42.23), 0.600, 0.0005), "{}", z(42.23));
        // Under 22.5 mm the climb is the line.
        assert!(near(z(14.85), 0.259, 0.0005), "{}", z(14.85));
    }

    #[test]
    fn a_low_z_feed_rate_limit_narrows_the_blend() {
        let k = 1.0_f64.to_radians().m_tan();
        let b = Blend::of(k, &Limits { f_z: 5.0, ..MK4 });
        assert!(near(b.b, 10.607, 0.0005), "{b:?}");
        assert_eq!(b.n, 3);
    }

    #[test]
    fn a_climb_of_8_jerk_steps_does_not_bend() {
        let k = 2.0_f64.to_radians().m_tan();
        let b = Blend::of(k, &MK4);
        assert_eq!(b.n, 8);
        let r = Ramp::of(0.6, 2.0, Some(&MK4), 40.0);
        assert_eq!(r.blend, None);
        assert!(near(r.at(12.27), 0.429, 0.001), "{}", r.at(12.27));
        assert!(near(r.at(40.0), 0.6, 1e-9));
    }

    #[test]
    fn a_climb_shorter_than_the_braking_length_does_not_bend() {
        let mini = Limits {
            v: 400.0,
            a: 4000.0,
            a_z: 400.0,
            f_z: 12.0,
            j_z: 2.0,
        };
        let z = |s: f64| Ramp::of(0.6, 1.0, Some(&mini), s).at(s);
        assert!(near(z(39.26), 0.600, 1e-9), "{}", z(39.26));
        assert!(near(z(40.05), 0.599, 0.0005), "{}", z(40.05));
    }

    #[test]
    fn without_every_limit_there_is_no_blend() {
        let r = Ramp::of(0.6, 1.0, None, 32.93);
        assert!(near(r.at(32.93), 0.575, 0.0005), "{}", r.at(32.93));
        let rc = PrintConfig::default();
        assert_eq!(Limits::of(&rc), None);
    }

    #[test]
    fn the_written_points_of_the_blend() {
        let r = Ramp::of(0.6, 1.0, Some(&MK4), 60.0);
        let k = r.knots(60.0);
        assert_eq!(k.len(), 4, "{k:?}");
        let steps: Vec<f64> = k.windows(2).map(|w| w[1] - w[0]).collect();
        assert!(
            near(steps[0], 3.927, 0.001) && near(steps[1], 3.927, 0.001) && near(steps[2], 7.854, 0.001),
            "{steps:?}"
        );
        // A climb that ends inside the blend stops at the points it reaches.
        assert_eq!(r.knots(30.0).len(), 1);
        // No blend: one point where the line reaches the height.
        let line = Ramp::of(0.6, 5.0, Some(&MK4), 60.0);
        assert_eq!(line.knots(60.0).len(), 1);
        assert!(line.knots(3.0).is_empty());
    }
}
