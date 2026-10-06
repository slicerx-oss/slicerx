// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! threads: ISO metric coarse threads, M3 to M30, cut into a picked hole (internal) or a boss or rod (external)
//!
//! The thread is the basic ISO profile (60 degree flanks, a flat of an eighth of the pitch at the crest and a quarter
//! at the root) along a right-hand helix, built as a radial height field: rings across the axis a sixteenth of the
//! pitch apart, each vertex at the profile's radius for where it sits on the helix. An external thread cuts its
//! grooves (the cylinder's shell less the thread) out of the boss; an internal one first sizes the hole to the
//! thread's minor diameter (`hole::apply`, which fills a larger hole first) and then cuts the thread out of the wall.
//! The clearance makes an external thread smaller and an internal one larger, radially.

use crate::boolean::{self, BoolOp, BooleanOptions, BooleanReport};
use crate::build;
use crate::edge::{Rim, rims_on};
use crate::error::{Error, Result};
use crate::faces::Surface;
use crate::fm::Fm;
use crate::hole::{self, Hole, HoleSpec};
use crate::mesh::TriMesh;
use crate::vec3::{self, Frame, V3};
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

/// ISO 261 coarse threads: name, major diameter and pitch, mm.
pub const ISO_COARSE: [(&str, f64, f64); 11] = [
    ("M3", 3.0, 0.5),
    ("M4", 4.0, 0.7),
    ("M5", 5.0, 0.8),
    ("M6", 6.0, 1.0),
    ("M8", 8.0, 1.25),
    ("M10", 10.0, 1.5),
    ("M12", 12.0, 1.75),
    ("M16", 16.0, 2.0),
    ("M20", 20.0, 2.5),
    ("M24", 24.0, 3.0),
    ("M30", 30.0, 3.5),
];

/// The basic profile's depth over the pitch: five eighths of the fundamental triangle's height.
const DEPTH_OVER_PITCH: f64 = 0.541_265_877_365_273_1;
/// Rings across the axis per pitch: corners of the profile are off by at most a sixteenth of the pitch.
const ROWS_PER_PITCH: f64 = 16.0;
/// Chord error around the axis, mm.
const CHORD_MM: f64 = 0.01;
/// The thread reaches this far past an open end, so the boolean never meets the end face flush, mm.
const OVERLAP_MM: f64 = 0.05;

/// A round surface a thread can go on: where it starts, which way is out, its size and how far it runs.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTarget {
    /// The center of the end the thread starts at.
    pub start: V3,
    /// Unit, out of the cylinder through that end.
    pub axis: V3,
    pub diameter_mm: f64,
    /// How far the cylinder runs from the start.
    pub length_mm: f64,
    /// A hole (the thread is cut into its wall), not a boss or rod.
    pub internal: bool,
    /// Open at the far end too (a through hole, a rod's free end). Otherwise the thread stops half a pitch short.
    pub open_end: bool,
}

/// The thread to cut.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSpec {
    /// An ISO size name, for example "M8".
    pub size: String,
    /// From the start; the whole cylinder when absent.
    #[serde(default)]
    pub length_mm: Option<f64>,
    /// Radial, mm: an external thread this much smaller, an internal one this much larger.
    #[serde(default)]
    pub clearance_mm: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadReport {
    pub size: &'static str,
    pub pitch_mm: f64,
    /// As cut, with the clearance.
    pub major_mm: f64,
    pub minor_mm: f64,
    pub length_mm: f64,
    /// The flanks print cleanly at this layer height or below: a quarter of the pitch.
    pub max_layer_mm: f64,
    pub volume_change_mm3: f64,
    pub watertight: bool,
    pub shells: usize,
    pub boolean: BooleanReport,
}

/// The ISO size by name (any case): its name, major diameter and pitch.
pub fn size(name: &str) -> Result<(&'static str, f64, f64)> {
    let name = name.trim();
    ISO_COARSE
        .iter()
        .find(|(n, ..)| n.eq_ignore_ascii_case(name))
        .copied()
        .ok_or_else(|| {
            Error::invalid(
                "size",
                format!("{name} is not a size here; pick one from M3 to M30"),
            )
        })
}

/// The size that suits the target: an external thread by its major diameter, an internal one by its minor
/// diameter, which is what the hole was drilled to.
pub fn suggest(target: &ThreadTarget) -> &'static str {
    let fit = |&(_, d, p): &(&str, f64, f64)| {
        let want = if target.internal {
            d - 2.0 * DEPTH_OVER_PITCH * p
        } else {
            d
        };
        (want - target.diameter_mm).abs()
    };
    ISO_COARSE
        .iter()
        .min_by(|a, b| fit(a).total_cmp(&fit(b)))
        .map_or("M3", |s| s.0)
}

/// The round surface triangle `t` is on: a hole's wall, or a boss's or rod's side, starting at the end nearest `at`.
pub fn find(mesh: &TriMesh, t: u32, at: V3) -> Result<ThreadTarget> {
    if let Ok(h) = hole::find(mesh, t, at) {
        return Ok(ThreadTarget {
            start: h.entry,
            axis: h.axis,
            diameter_mm: h.diameter_mm,
            length_mm: h.depth_mm,
            internal: true,
            open_end: h.through,
        });
    }
    let not_round = || {
        Error::invalid(
            "thread",
            "pick the wall of a round hole, or the side of a boss or rod with a flat end",
        )
    };
    let (cyl, rims) = rims_on(mesh, t as usize).ok_or_else(not_round)?;
    let Surface::Cylinder { radius, .. } = cyl else {
        return Err(not_round());
    };
    // A boss or rod ends at a convex rim with the flat face inside the circle, and stands on a concave one with
    // the flat face around it.
    let ends: Vec<&Rim> = rims.iter().filter(|r| r.convex && r.out < 0.0).collect();
    let roots: Vec<&Rim> = rims.iter().filter(|r| !r.convex && r.out > 0.0).collect();
    let near = |r: &&Rim| vec3::len(vec3::sub(r.center, at));
    let start = *ends
        .iter()
        .min_by(|a, b| near(a).total_cmp(&near(b)))
        .ok_or_else(not_round)?;
    let (far, open_end) = if let Some(f) = ends.iter().find(|r| !std::ptr::eq(**r, start)) {
        (*f, true)
    } else if let Some(f) = roots.first() {
        (*f, false)
    } else {
        return Err(not_round());
    };
    let length = vec3::dot(vec3::sub(start.center, far.center), start.normal);
    if length <= 1e-6 {
        return Err(not_round());
    }
    Ok(ThreadTarget {
        start: start.center,
        axis: start.normal,
        diameter_mm: 2.0 * radius,
        length_mm: length,
        internal: false,
        open_end,
    })
}

/// The radius of the thread at `u` along the helix (a right-hand helix through 0 at angle 0).
fn profile(u: f64, pitch: f64, r_maj: f64, r_min: f64) -> f64 {
    // In sixteenths of the pitch: crest 0 to 2, flank down to 7, root to 11, flank up to 16.
    let s = u.rem_euclid(pitch) / pitch * 16.0;
    let k = if s < 2.0 {
        1.0
    } else if s < 7.0 {
        1.0 - (s - 2.0) / 5.0
    } else if s < 11.0 {
        0.0
    } else {
        (s - 11.0) / 5.0
    };
    r_min + (r_maj - r_min) * k
}

/// The thread as a solid, from `z0` to `z1` along `frame.w`.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    reason = "ring and vertex counts are small and positive"
)]
fn rod(frame: &Frame, pitch: f64, r_maj: f64, r_min: f64, z0: f64, z1: f64) -> TriMesh {
    let cols = build::circle_segments(r_maj, CHORD_MM).max(32);
    let rows = ((z1 - z0) / (pitch / ROWS_PER_PITCH)).ceil().max(1.0) as usize;
    let mut m = TriMesh::default();
    for i in 0..=rows {
        let z = z0 + (z1 - z0) * i as f64 / rows as f64;
        for j in 0..cols {
            let a = 2.0 * PI * j as f64 / cols as f64;
            let r = profile(z - pitch * a / (2.0 * PI), pitch, r_maj, r_min);
            let (sin, cos) = a.m_sin_cos();
            m.push_vertex(frame.at([r * cos, r * sin], z));
        }
    }
    let bottom = m.push_vertex(frame.at([0.0, 0.0], z0));
    let top = m.push_vertex(frame.at([0.0, 0.0], z1));
    let at = |i: usize, j: usize| (i * cols + j % cols) as u32;
    for j in 0..cols {
        for i in 0..rows {
            let (a, b, c, d) = (at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i + 1, j));
            m.triangles.push([a, b, c]);
            m.triangles.push([a, c, d]);
        }
        m.triangles.push([bottom, at(0, j + 1), at(0, j)]);
        m.triangles.push([top, at(rows, j), at(rows, j + 1)]);
    }
    m
}

/// A thread as cut: its radii with the clearance, and where it runs along `frame.w` (from the start, into the
/// cylinder) up to `z1`.
struct Cut {
    name: &'static str,
    pitch: f64,
    r_maj: f64,
    r_min: f64,
    frame: Frame,
    z1: f64,
}

/// A hole sized to the thread's minor diameter (filled first when wider), then the thread cut out of its wall.
fn cut_internal(
    mesh: &TriMesh,
    target: &ThreadTarget,
    axis: V3,
    cut: &Cut,
    opts: BooleanOptions,
) -> Result<(TriMesh, BooleanReport)> {
    let depth = cut.r_maj - cut.r_min;
    if target.diameter_mm / 2.0 > cut.r_maj - depth / 4.0 {
        return Err(Error::invalid(
            "size",
            format!(
                "the hole is too wide for an {} thread; pick a larger size",
                cut.name
            ),
        ));
    }
    let hole = Hole {
        entry: target.start,
        axis,
        diameter_mm: target.diameter_mm,
        depth_mm: target.length_mm,
        through: target.open_end,
    };
    let bore = HoleSpec {
        diameter_mm: 2.0 * cut.r_min,
        depth_mm: None,
        counterbore: None,
        countersink: None,
    };
    let (bored, _) = hole::apply(mesh, &hole, &bore, &opts)?;
    let tool = rod(&cut.frame, cut.pitch, cut.r_maj, cut.r_min, -OVERLAP_MM, cut.z1);
    boolean::boolean(&[bored], &[tool], BoolOp::Difference, &opts)
}

/// The grooves (the cylinder's shell less the thread) cut out of a rod or boss.
fn cut_external(
    mesh: &TriMesh,
    target: &ThreadTarget,
    cut: &Cut,
    opts: BooleanOptions,
) -> Result<(TriMesh, BooleanReport)> {
    let r = target.diameter_mm / 2.0;
    if cut.r_maj > r + 0.1 {
        return Err(Error::invalid(
            "size",
            format!(
                "an {} thread is wider than this {:.1} mm cylinder; pick a smaller size",
                cut.name, target.diameter_mm
            ),
        ));
    }
    let pad = (r * 0.02).max(0.05);
    let shell = build::cylinder(
        &cut.frame,
        r + pad,
        -OVERLAP_MM,
        cut.z1,
        build::circle_segments(r + pad, CHORD_MM),
    );
    let tool = rod(
        &cut.frame,
        cut.pitch,
        cut.r_maj,
        cut.r_min,
        -2.0 * OVERLAP_MM,
        cut.z1 + OVERLAP_MM,
    );
    let groove = boolean::boolean(&[shell], &[tool], BoolOp::Difference, &opts)?.0;
    boolean::boolean(std::slice::from_ref(mesh), &[groove], BoolOp::Difference, &opts)
}

/// The thread cut into the target, found again on `mesh` first.
pub fn apply(
    mesh: &TriMesh,
    target: &ThreadTarget,
    spec: &ThreadSpec,
    opts: &BooleanOptions,
) -> Result<(TriMesh, ThreadReport)> {
    mesh.validate("thread")?;
    let (name, major, pitch) = size(&spec.size)?;
    let c = spec.clearance_mm;
    if !(c.is_finite() && (0.0..=pitch / 4.0).contains(&c)) {
        return Err(Error::invalid(
            "clearanceMm",
            format!(
                "must be from 0 to a quarter of the pitch ({} mm for {name})",
                pitch / 4.0
            ),
        ));
    }
    let axis =
        vec3::normalize(target.axis).ok_or_else(|| Error::invalid("thread.axis", "must not be zero"))?;
    let len = match spec.length_mm {
        Some(l) if l.is_finite() && l > 0.0 => l.min(target.length_mm),
        Some(_) => return Err(Error::invalid("lengthMm", "must be above 0")),
        None if target.open_end => target.length_mm,
        None => target.length_mm - pitch / 2.0,
    };
    if len < pitch {
        return Err(Error::invalid(
            "lengthMm",
            format!("the thread needs at least one pitch of length ({pitch} mm for {name})"),
        ));
    }
    // Into the cylinder from its start; past the far end too when the thread runs out through it.
    let frame = Frame::from_normal(target.start, vec3::scale(axis, -1.0), None)
        .ok_or_else(|| Error::invalid("thread.axis", "must not be zero"))?;
    let z1 = if target.open_end && len >= target.length_mm - 1e-9 {
        target.length_mm + OVERLAP_MM
    } else {
        len
    };
    let depth = DEPTH_OVER_PITCH * pitch;
    let v0 = boolean::Solid::new(mesh)?.volume();
    let half = major / 2.0 + if target.internal { c } else { -c };
    let cut = Cut {
        name,
        pitch,
        r_maj: half,
        r_min: half - depth,
        frame,
        z1,
    };
    let (out, r) = if target.internal {
        cut_internal(mesh, target, axis, &cut, *opts)?
    } else {
        cut_external(mesh, target, &cut, *opts)?
    };
    let (r_maj, r_min) = (cut.r_maj, cut.r_min);
    if r.empty || out.triangles.is_empty() {
        return Err(Error::geometry("thread", "the thread removes the whole body"));
    }
    if !r.watertight {
        return Err(Error::geometry(
            "thread",
            "the result is not watertight; try another size",
        ));
    }
    Ok((
        out,
        ThreadReport {
            size: name,
            pitch_mm: pitch,
            major_mm: 2.0 * r_maj,
            minor_mm: 2.0 * r_min,
            length_mm: len,
            max_layer_mm: pitch / 4.0,
            volume_change_mm3: r.volume_mm3 - v0,
            watertight: r.watertight,
            shells: r.shells,
            boolean: r,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boolean::{self, BoolOp};
    use crate::build;
    use crate::fm::Fm;
    use crate::vec3;
    use std::f64::consts::PI;

    const DEPTH: f64 = 0.541_265_877_365_273_1;

    fn post(c: [f64; 2], r: f64, h0: f64, h1: f64) -> TriMesh {
        let f = Frame {
            origin: [c[0], c[1], 0.0],
            ..Frame::WORLD
        };
        build::cylinder(&f, r, h0, h1, 64)
    }

    /// A side triangle of the round surface around (cx, cy), and a point on it near height `z`.
    fn side(m: &TriMesh, c: [f64; 2], z: f64) -> (u32, V3) {
        let mut best = None;
        for (t, &tri) in m.triangles.iter().enumerate() {
            let k = m.corners(tri);
            let n = vec3::normalize(m.normal(tri)).unwrap_or([0.0; 3]);
            let mid = vec3::scale(vec3::add(vec3::add(k[0], k[1]), k[2]), 1.0 / 3.0);
            if n[2].abs() < 0.01 && (mid[0] - c[0]).m_hypot(mid[1] - c[1]) < 6.0 {
                let d = (mid[2] - z).abs();
                if best.is_none_or(|(_, _, b)| d < b) {
                    best = Some((u32::try_from(t).unwrap(), mid, d));
                }
            }
        }
        let (t, mid, _) = best.expect("no side");
        (t, mid)
    }

    /// The mean of r squared over one pitch, for the expected volume.
    fn mean_r2(r_maj: f64, r_min: f64) -> f64 {
        let n = 16_000;
        (0..n)
            .map(|i| {
                let r = profile(f64::from(i) / f64::from(n), 1.0, r_maj, r_min);
                r * r
            })
            .sum::<f64>()
            / f64::from(n)
    }

    fn volume(m: &TriMesh) -> f64 {
        boolean::Solid::new(m).unwrap().volume()
    }

    #[test]
    fn sizes_are_iso_coarse() {
        assert_eq!(size("M8").unwrap(), ("M8", 8.0, 1.25));
        assert_eq!(size(" m3 ").unwrap(), ("M3", 3.0, 0.5));
        assert!((size("M30").unwrap().2 - 3.5).abs() < 1e-12);
        let e = size("M7").unwrap_err().to_string();
        assert!(e.contains("M3 to M30"), "{e}");
    }

    #[test]
    fn the_profile_has_its_crest_root_and_flanks_and_turns_right_handed() {
        let (p, a, b) = (2.0, 5.0, 5.0 - DEPTH * 2.0);
        assert!((profile(0.1, p, a, b) - a).abs() < 1e-12, "crest");
        assert!((profile(1.1, p, a, b) - b).abs() < 1e-12, "root");
        assert!(
            (profile(0.25 + 5.0 * p / 32.0, p, a, b) - f64::midpoint(a, b)).abs() < 1e-9,
            "flank"
        );
        assert!((profile(0.1 + 7.0 * p, p, a, b) - a).abs() < 1e-12, "periodic");
        // A right-hand helix rises as it turns counterclockwise about w: every vertex on the crest sits where
        // z less a pitch per turn lands on the crest's flat.
        let r = rod(&Frame::WORLD, p, a, b, 0.0, 10.0);
        let crest: Vec<&V3> = r
            .positions
            .iter()
            .filter(|q| (q[0].m_hypot(q[1]) - a).abs() < 1e-9)
            .collect();
        assert!(crest.len() > 100);
        for q in crest {
            let turn = q[1].m_atan2(q[0]).rem_euclid(2.0 * PI) / (2.0 * PI);
            assert!((q[2] - p * turn).rem_euclid(p) <= p / 8.0 + 1e-9, "{q:?}");
        }
    }

    #[test]
    fn the_thread_solid_is_closed_with_the_volume_of_its_profile() {
        let (a, b) = (3.9, 3.9 - DEPTH * 1.25);
        let r = rod(&Frame::WORLD, 1.25, a, b, -0.5, 20.0);
        r.validate("rod").unwrap();
        let want = PI * mean_r2(a, b) * 20.5;
        let got = volume(&r);
        assert!((got - want).abs() / want < 0.01, "{got} vs {want}");
    }

    #[test]
    fn a_rod_is_threaded_along_its_length() {
        let m = post([0.0, 0.0], 4.0, 0.0, 20.0);
        let (t, at) = side(&m, [0.0, 0.0], 19.0);
        let target = find(&m, t, at).unwrap();
        assert!(!target.internal && target.open_end);
        assert!((target.diameter_mm - 8.0).abs() < 1e-6 && (target.length_mm - 20.0).abs() < 1e-6);
        assert!(vec3::dot(target.axis, [0.0, 0.0, 1.0]) > 0.9999 && (target.start[2] - 20.0).abs() < 1e-6);
        assert_eq!(suggest(&target), "M8");
        let spec = ThreadSpec {
            size: "M8".into(),
            length_mm: None,
            clearance_mm: 0.1,
        };
        let (out, rep) = apply(&m, &target, &spec, &BooleanOptions::default()).unwrap();
        assert!(rep.watertight && rep.shells == 1);
        assert!((rep.major_mm - 7.8).abs() < 1e-9 && (rep.pitch_mm - 1.25).abs() < 1e-9);
        assert!((rep.max_layer_mm - 0.3125).abs() < 1e-9);
        let (a, b) = (3.9, 3.9 - DEPTH * 1.25);
        let want = PI * mean_r2(a, b) * 20.0;
        assert!(
            (volume(&out) - want).abs() / want < 0.015,
            "{} vs {want}",
            volume(&out)
        );
        assert!(out.positions.iter().all(|q| q[0].m_hypot(q[1]) < a + 1e-6));
    }

    #[test]
    fn a_boss_is_threaded_and_the_plate_under_it_is_kept() {
        let plate = build::box_mesh([0.0; 3], [30.0, 20.0, 5.0]);
        let m = boolean::boolean(
            &[plate],
            &[post([15.0, 10.0], 4.0, 4.0, 15.0)],
            BoolOp::Union,
            &BooleanOptions::default(),
        )
        .unwrap()
        .0;
        let (t, at) = side(&m, [15.0, 10.0], 10.0);
        let target = find(&m, t, at).unwrap();
        assert!(!target.internal && !target.open_end);
        assert!((target.length_mm - 10.0).abs() < 1e-6 && (target.start[2] - 15.0).abs() < 1e-6);
        let spec = ThreadSpec {
            size: "M8".into(),
            length_mm: None,
            clearance_mm: 0.0,
        };
        let (out, rep) = apply(&m, &target, &spec, &BooleanOptions::default()).unwrap();
        assert!(rep.watertight && rep.shells == 1 && rep.volume_change_mm3 < 0.0);
        assert!((rep.length_mm - (10.0 - 0.625)).abs() < 1e-9);
        // The plate and the half pitch of plain boss above it are untouched.
        let v_plate = 30.0 * 20.0 * 5.0;
        let v_rest = volume(&post([15.0, 10.0], 4.0, 5.0, 5.625));
        let low = boolean::boolean(
            &[out],
            &[build::box_mesh([-1.0, -1.0, -1.0], [31.0, 21.0, 5.6])],
            BoolOp::Intersection,
            &BooleanOptions::default(),
        )
        .unwrap()
        .0;
        assert!(
            (volume(&low) - v_plate - v_rest * (0.6 / 0.625)).abs() < 0.5,
            "{}",
            volume(&low)
        );
    }

    #[test]
    fn a_tapped_hole_is_cut_to_the_thread() {
        let plate = build::box_mesh([0.0; 3], [30.0, 20.0, 10.0]);
        let m = boolean::boolean(
            &[plate],
            &[post([15.0, 10.0], 3.4, -1.0, 11.0)],
            BoolOp::Difference,
            &BooleanOptions::default(),
        )
        .unwrap()
        .0;
        let (t, at) = side(&m, [15.0, 10.0], 9.0);
        let target = find(&m, t, at).unwrap();
        assert!(target.internal && target.open_end);
        assert!((target.diameter_mm - 6.8).abs() < 1e-6 && (target.length_mm - 10.0).abs() < 1e-6);
        assert_eq!(suggest(&target), "M8");
        let spec = ThreadSpec {
            size: "M8".into(),
            length_mm: None,
            clearance_mm: 0.15,
        };
        let v0 = volume(&m);
        let (out, rep) = apply(&m, &target, &spec, &BooleanOptions::default()).unwrap();
        assert!(rep.watertight && rep.shells == 1);
        let (a, b) = (4.15, 4.15 - DEPTH * 1.25);
        let want = 30.0 * 20.0 * 10.0 - PI * mean_r2(a, b) * 10.0;
        assert!(
            (volume(&out) - want).abs() / want < 0.005,
            "{} vs {want}",
            volume(&out)
        );
        assert!((volume(&out) - v0 - rep.volume_change_mm3).abs() < 1e-3);
        assert!((rep.minor_mm - 2.0 * b).abs() < 1e-9);
    }

    #[test]
    fn sizes_that_do_not_fit_are_refused_in_words() {
        let m = post([0.0, 0.0], 4.0, 0.0, 20.0);
        let (t, at) = side(&m, [0.0, 0.0], 19.0);
        let target = find(&m, t, at).unwrap();
        let spec = |size: &str, length_mm: Option<f64>| ThreadSpec {
            size: size.into(),
            length_mm,
            clearance_mm: 0.0,
        };
        let o = BooleanOptions::default();
        let e = apply(&m, &target, &spec("M10", None), &o)
            .unwrap_err()
            .to_string();
        assert!(e.contains("smaller size"), "{e}");
        let e = apply(&m, &target, &spec("M8", Some(1.0)), &o)
            .unwrap_err()
            .to_string();
        assert!(e.contains("pitch"), "{e}");
        let plate = build::box_mesh([0.0; 3], [30.0, 20.0, 10.0]);
        let h = boolean::boolean(
            &[plate],
            &[post([15.0, 10.0], 3.4, -1.0, 11.0)],
            BoolOp::Difference,
            &o,
        )
        .unwrap()
        .0;
        let (t, at) = side(&h, [15.0, 10.0], 9.0);
        let hole = find(&h, t, at).unwrap();
        let e = apply(&h, &hole, &spec("M5", None), &o).unwrap_err().to_string();
        assert!(e.contains("larger size"), "{e}");
        let bad = ThreadSpec {
            clearance_mm: 1.0,
            ..spec("M8", None)
        };
        assert!(
            apply(&m, &target, &bad, &o)
                .unwrap_err()
                .to_string()
                .contains("clearance")
        );
        let flat = build::box_mesh([0.0; 3], [10.0; 3]);
        assert!(find(&flat, 0, [5.0, 5.0, 0.0]).is_err());
    }
}
