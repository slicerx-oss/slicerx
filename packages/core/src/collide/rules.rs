// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The by-object rules heimdall's walk applies, as small pure functions: the gantry beam on the 1 mm lattice, which
//! printer has no beam, how a move inside the clearance radius counts, how far an object's own first layer prints past
//! its footprint, and whether an object gets support at all, so its support's pad counts there only then. The walk
//! ([`super::walk`]), the height grids ([`super::grid`]) and the model ([`super::Model`]) call these, and a test writes
//! their answers on a set of cases to `packages/settings/fixtures/by-object-golden.json`, which the app's by-object
//! check (`packages/settings/js/by-object.ts`) is tested against, so the two cannot drift.

use super::grid::CELL;
use super::{Part, Severity};

/// The lattice cell holding `v` mm.
#[allow(
    clippy::cast_possible_truncation,
    reason = "cell indices of a bed a few hundred mm across"
)]
pub(crate) fn cell(v: f64) -> i32 {
    (v / CELL).floor() as i32
}

/// How many whole cells the gantry beam reaches either way of the nozzle in y: the rod's reach rounded up to the cell.
#[allow(clippy::cast_possible_truncation, reason = "a beam reach of a few tens of mm")]
pub(crate) fn beam_cells(to_rod: f64) -> i32 {
    (to_rod / CELL).ceil().max(0.0) as i32
}

/// Whether a layer whose moves span `area` (y from, y to, mm) can bring the beam over an object whose mesh spans
/// `object` in y: the object's extent in whole cells against the moves' extent grown by the rod's reach. The walk
/// skips the beam's lookups for the layer when this is false.
pub(crate) fn under_beam(object: [f64; 2], area: [f64; 2], to_rod: f64) -> bool {
    let (lo, hi) = (object[0].floor(), object[1].floor() + 1.0);
    lo < area[1] + to_rod && hi > area[0] - to_rod
}

/// Whether the printer is a delta, which has no gantry beam over the bed: `printer_structure` says so, or the profile
/// or the printer model is a `FLSun` one, whose profiles leave the structure out.
pub(crate) fn is_delta(structure: Option<&str>, printer_id: Option<&str>, model: Option<&str>) -> bool {
    structure == Some("delta")
        || [printer_id, model]
            .into_iter()
            .flatten()
            .any(|id| id.to_ascii_lowercase().starts_with("flsun"))
}

/// How a move `d` mm from a finished object counts against the clearance `radius`: none at or past it; inside it, a hit
/// when the head is `estimated` (drawn from photos, so the radius stands in for the head), else a close call that the
/// head's own columns decide.
pub(crate) fn radius_hit(d: f64, radius: f64, estimated: bool) -> Option<(Severity, Part)> {
    (d < radius).then_some(if estimated {
        (Severity::Hit, Part::Clearance)
    } else {
        (Severity::Close, Part::Toolhead)
    })
}

/// Whether sx runs the support pass for an object with these settings: support on, and with manual support only when an
/// enforcer (a volume or painted triangles) asks for some. Every support gate of the session calls this.
pub(crate) fn support_runs(enabled: bool, manual: bool, enforcers: bool) -> bool {
    enabled && (!manual || enforcers)
}

/// Whether an object gets support at all, read from its triangles where there are no layers yet: the rule the app's
/// by-object check (`packages/settings/js/by-object.ts`) and the MCP server count an object's support pad by. The slice
/// decides support from its layers; the tests below write this rule's answers to the golden file and check it is never
/// looser than the slice.
#[cfg(test)]
pub(crate) mod support {
    use super::support_runs;
    use crate::config::PrintConfig;
    use crate::fm::Fm as _;

    /// A point on the 1 micron lattice.
    type Key = (i64, i64, i64);

    /// Degrees added to the steepest underside the support planners find an overhang under, so a slope near the
    /// threshold, a slice landing between two layers or a rounded vertex never makes the app's answer looser than the
    /// slice.
    pub(crate) const OVERHANG_MARGIN_DEG: f64 = 5.0;

    /// The steepest underside, degrees from the bed, that any of sx's support planners can find an overhang under with
    /// `cfg`, plus [`OVERHANG_MARGIN_DEG`]. A threshold angle above 0 holds up what is flatter than it plus a degree.
    /// At 0, normal support holds up what steps out by more than `support_threshold_overlap` of the outer wall per
    /// layer, at the tallest layer, and trees hold up what is flatter than 30 degrees; the steeper of the two counts.
    pub(crate) fn overhang_limit_deg(cfg: &PrintConfig) -> f64 {
        let s = &cfg.support;
        let found = if s.threshold_angle > 0.0 {
            (s.threshold_angle + 1.0).min(89.0)
        } else {
            let h = cfg.layer_height.max(cfg.initial_layer_print_height).max(0.01);
            let step = cfg.outer_wall_width() * (1.0 - s.threshold_overlap / 100.0);
            let normal = if step > 1e-9 {
                (h / step).m_atan().to_degrees()
            } else {
                90.0
            };
            normal.max(30.0)
        };
        (found + OVERHANG_MARGIN_DEG).min(90.0)
    }

    /// A point on a 1 micron lattice, to find the triangles that share a corner or an edge.
    #[allow(
        clippy::cast_possible_truncation,
        reason = "mm coordinates of a bed a few metres across at most"
    )]
    fn lattice(p: [f64; 3]) -> Key {
        (
            (p[0] * 1000.0).round() as i64,
            (p[1] * 1000.0).round() as i64,
            (p[2] * 1000.0).round() as i64,
        )
    }

    /// Whether an object, as it stands on the bed (`positions` in bed mm, `triangles` wound with their normals out,
    /// every part of the object together), has an underside any support planner of sx could hold up with `cfg`. It
    /// never says no where the slice finds an overhang; it may say yes where the slice finds none (a small overhang
    /// dropped, one over the part itself with `support_on_build_plate_only`, a bridge with `bridge_no_support`, a
    /// blocker). Yes when:
    /// - a face looks down at less than [`overhang_limit_deg`] from the bed, off the bed itself;
    /// - a face looks down within the first `enforce_support_layers` layers, at any slope;
    /// - two faces looking down meet in a ridge that points down at less than the limit (the corner of two steep faces
    ///   can be flatter than either);
    /// - a corner off the bed has nothing lower round it and a face looking down from it (a part hanging from a point).
    pub(crate) fn has_overhang(positions: &[[f64; 3]], triangles: &[[u32; 3]], cfg: &PrintConfig) -> bool {
        use std::collections::HashMap;
        const EPS: f64 = 1e-3;
        let Some(base) = positions.iter().map(|p| p[2]).min_by(f64::total_cmp) else {
            return false;
        };
        let limit = overhang_limit_deg(cfg).to_radians();
        let flat = limit.m_cos();
        let enforce_top = if cfg.support.enforce_layers > 0 {
            base + cfg.initial_layer_print_height + f64::from(cfg.support.enforce_layers) * cfg.layer_height
        } else {
            f64::NEG_INFINITY
        };
        let at = |i: u32| positions.get(i as usize).copied();
        let sub = |a: [f64; 3], b: [f64; 3]| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
        let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        // Lowest corners of downward faces, and the edges of downward faces with each face's far corner.
        let mut lows: HashMap<Key, (f64, bool)> = HashMap::new();
        let mut edges: HashMap<(Key, Key), Vec<[f64; 3]>> = HashMap::new();
        for t in triangles {
            let (Some(a), Some(b), Some(c)) = (at(t[0]), at(t[1]), at(t[2])) else {
                continue;
            };
            let (u, v) = (sub(b, a), sub(c, a));
            let n = [
                u[1] * v[2] - u[2] * v[1],
                u[2] * v[0] - u[0] * v[2],
                u[0] * v[1] - u[1] * v[0],
            ];
            let len = dot(n, n).sqrt();
            if len < 1e-12 || n[2] / len > -1e-9 {
                continue;
            }
            let top = a[2].max(b[2]).max(c[2]);
            if top <= base + EPS {
                continue;
            }
            if -n[2] / len > flat || a[2].min(b[2]).min(c[2]) < enforce_top {
                return true;
            }
            let low = [a, b, c]
                .into_iter()
                .min_by(|p, q| p[2].total_cmp(&q[2]))
                .unwrap_or(a);
            if low[2] > base + EPS {
                lows.entry(lattice(low)).or_insert((low[2], false));
            }
            for (p, q, far) in [(a, b, c), (b, c, a), (c, a, b)] {
                let (kp, kq) = (lattice(p), lattice(q));
                let key = if kp <= kq { (kp, kq) } else { (kq, kp) };
                edges.entry(key).or_default().push(far);
            }
        }
        // A keel: an edge both its downward faces rise away from, so it is the lowest line across them.
        for ((kp, kq), far) in &edges {
            let [r0, r1] = far.as_slice() else {
                continue;
            };
            #[allow(clippy::cast_precision_loss, reason = "lattice points back to mm")]
            let (p, q) = (
                [kp.0 as f64 / 1000.0, kp.1 as f64 / 1000.0, kp.2 as f64 / 1000.0],
                [kq.0 as f64 / 1000.0, kq.1 as f64 / 1000.0, kq.2 as f64 / 1000.0],
            );
            let d = sub(q, p);
            let dd = dot(d, d);
            if dd < 1e-12 || p[2].max(q[2]) <= base + EPS {
                continue;
            }
            // Whether the face rises across the edge toward its far corner.
            let rises = |r: [f64; 3]| {
                let w = sub(r, p);
                w[2] - d[2] * dot(w, d) / dd > 1e-6
            };
            if rises(*r0) && rises(*r1) && d[2].abs().m_atan2(d[0].m_hypot(d[1])) < limit {
                return true;
            }
        }
        if lows.is_empty() {
            return false;
        }
        for t in triangles {
            let (Some(a), Some(b), Some(c)) = (at(t[0]), at(t[1]), at(t[2])) else {
                continue;
            };
            let lowest = a[2].min(b[2]).min(c[2]);
            for p in [a, b, c] {
                if p[2] > lowest + 1e-6
                    && let Some(seen) = lows.get_mut(&lattice(p))
                {
                    seen.1 = true;
                }
            }
        }
        lows.values().any(|&(_, lower)| !lower)
    }

    /// Whether sx can print support under an object: the pass runs for it ([`support_runs`]) and something asks for
    /// support, an enforcer or, with automatic support, an overhang ([`has_overhang`]).
    pub(crate) fn gets_support(cfg: &PrintConfig, enforcers: bool, overhang: bool) -> bool {
        support_runs(cfg.enable_support, cfg.support.manual, enforcers)
            && (enforcers || (!cfg.support.manual && overhang))
    }

    /// How far an object's own first layer prints past its footprint printing by object, mm: [`crate::tower::room_with`]
    /// with the skirt counted round the object. By object each object prints a skirt of its own on its first layers,
    /// whatever `skirt_type` says, so a combined skirt reaches as far as a skirt of its own.
    pub(crate) fn object_room(cfg: &PrintConfig, brim: f64) -> f64 {
        let mut own = cfg.clone();
        own.raw.insert(
            "skirt_type".to_owned(),
            serde_json::Value::String("perobject".to_owned()),
        );
        crate::tower::room_with(&own, brim)
    }

    /// [`object_room`] for an object whose footprint is `hull` (mm): by object the skirt round it has the loops the
    /// slice prints there, so `min_skirt_length` counts, which adds loops round a small object until they hold that
    /// much filament (one extruder).
    pub(crate) fn object_room_around(cfg: &PrintConfig, brim: f64, hull: &[[f64; 2]]) -> f64 {
        if cfg.skirt_loops == 0 {
            return object_room(cfg, brim);
        }
        let ring = hull
            .iter()
            .map(|p| {
                i_overlay::i_float::int::point::IntPoint::new(crate::geom::mm(p[0]), crate::geom::mm(p[1]))
            })
            .collect();
        let loops = crate::session::loops_around(ring, cfg, false, (1, 0)).len();
        let mut own = cfg.clone();
        own.skirt_loops = u32::try_from(loops).unwrap_or(u32::MAX).max(cfg.skirt_loops);
        object_room(&own, brim)
    }

    /// How far an object's own first layer prints past its footprint by object, mm ([`object_room`]), with its
    /// support's pad counted only when it gets support ([`gets_support`]).
    pub(crate) fn part_reach(cfg: &PrintConfig, brim: f64, supported: bool) -> f64 {
        if supported || !cfg.enable_support {
            return object_room(cfg, brim);
        }
        let mut bare = cfg.clone();
        bare.enable_support = false;
        object_room(&bare, brim)
    }
}

#[cfg(test)]
mod tests {
    use super::super::grid::{Grid, Profile};
    use super::support::{
        gets_support, has_overhang, object_room, object_room_around, overhang_limit_deg, part_reach,
    };
    use super::*;
    use crate::config::PrintConfig;
    use crate::fm::Fm as _;
    use serde_json::{Value, json};

    /// Whether the gantry beam, with the nozzle anywhere in `later` (the y span of the moves of an object printed
    /// after, mm), passes over a finished object spanning `earlier` in y: the rows of cells the object stands on, grown
    /// by [`beam_cells`] either way, where [`under_beam`] lets the walk look. The app's check holds a plate to this.
    fn gantry_meets(earlier: [f64; 2], later: [f64; 2], to_rod: f64) -> bool {
        let k = beam_cells(to_rod);
        under_beam(earlier, later, to_rod)
            && cell(later[1]) >= cell(earlier[0]) - k
            && cell(later[0]) <= cell(earlier[1]) + k
    }

    /// The golden file both sides read.
    fn golden_path() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../settings/fixtures/by-object-golden.json")
    }

    /// A box standing on cells `x 0..10` and the rows its mesh spans in y, `height` tall, as the height grid holds it.
    fn standing(y: [f64; 2], height: f32) -> Grid {
        let (y0, y1) = (cell(y[0]), cell(y[1]));
        let h = usize::try_from(y1 - y0 + 1).unwrap_or(0);
        Grid {
            x0: 0,
            y0,
            w: 10,
            h,
            z: vec![height; 10 * h],
        }
    }

    /// What the walk finds for the gantry: its skip test, then the beam's height at every cell the moves cross.
    fn beam_finds(earlier: [f64; 2], later: [f64; 2], to_rod: f64) -> bool {
        let beam: Profile = standing(earlier, 50.0).beam(to_rod);
        under_beam(earlier, later, to_rod)
            && (cell(later[0])..=cell(later[1])).any(|c| beam.at(f64::from(c) + 0.5) > 0.0)
    }

    fn gantry_cases() -> Vec<(&'static str, [f64; 2], [f64; 2], f64)> {
        // Earlier objects ending on a cell edge (120.0), 0.3 and 0.8 mm into a cell (120.3, 120.8); rod reaches of a
        // whole number of cells (33, the P1S) and not (56.5, the A1). Later objects just in and just past the reach.
        let mut out = Vec::new();
        for (name, hi) in [("edge", 120.0_f64), ("in 0.3", 120.3), ("in 0.8", 120.8)] {
            for r in [33.0, 56.5] {
                let k = f64::from(beam_cells(r));
                let last = hi.floor() + k;
                for (side, lo) in [
                    ("last row 0.3 in", last + 0.3),
                    ("last row 0.8 in", last + 0.8),
                    ("next row 0.3 in", last + 1.3),
                    ("next row 0.8 in", last + 1.8),
                    ("reach exactly", hi + r),
                    ("reach less 0.3", hi + r - 0.3),
                ] {
                    out.push((
                        leak(format!("{name}, rod {r}, {side}")),
                        [100.0, hi],
                        [lo, lo + 20.0],
                        r,
                    ));
                }
            }
        }
        // Below the earlier object: the later one's top in the first row the beam reaches, on its edge, and short of
        // it.
        for r in [33.0, 56.5] {
            let first = 100.0 - f64::from(beam_cells(r));
            for (side, hi) in [
                ("below, first row 0.3 in", first + 0.3),
                ("below, first row 0.8 in", first + 0.8),
                ("below, first row edge", first),
                ("below, row before 0.8 in", first - 0.2),
            ] {
                out.push((
                    leak(format!("{side}, rod {r}")),
                    [100.0, 120.0],
                    [hi - 20.0, hi],
                    r,
                ));
            }
        }
        // Overlapping spans meet; a beam that reaches nothing meets only the rows the object stands on.
        out.push(("overlapping", [100.0, 120.0], [110.0, 130.0], 33.0));
        out.push(("no reach, next row", [100.0, 120.5], [121.0, 140.0], 0.0));
        out.push(("no reach, same row", [100.0, 120.5], [120.9, 140.0], 0.0));
        out
    }

    fn leak(s: String) -> &'static str {
        Box::leak(s.into_boxed_str())
    }

    /// Skirts with `min_skirt_length` round a square footprint `side` mm across, the A1's 0.4 nozzle and PLA.
    fn skirt_length_cases() -> Vec<(&'static str, Value, f64, f64)> {
        let with = |extra: Value| {
            let mut v = json!({ "line_width": 0.42, "initial_layer_print_height": 0.2, "layer_height": 0.2, "nozzle_diameter": [0.4], "filament_diameter": [1.75], "brim_type": "no_brim", "skirt_loops": 1, "skirt_distance": 2, "skirt_height": 1 });
            if let (Some(m), Some(e)) = (v.as_object_mut(), extra.as_object()) {
                for (k, x) in e {
                    m.insert(k.clone(), x.clone());
                }
            }
            v
        };
        vec![
            ("no minimum length, a 3 mm part", with(json!({})), 0.0, 3.0),
            (
                "a 4 mm minimum, a 3 mm part",
                with(json!({ "min_skirt_length": 4 })),
                0.0,
                3.0,
            ),
            (
                "a 4 mm minimum, a 12 mm part",
                with(json!({ "min_skirt_length": 4 })),
                0.0,
                12.0,
            ),
            (
                "a 20 mm minimum, a 3 mm part",
                with(json!({ "min_skirt_length": 20 })),
                0.0,
                3.0,
            ),
            (
                "a 20 mm minimum, a 12 mm part",
                with(json!({ "min_skirt_length": 20 })),
                0.0,
                12.0,
            ),
            (
                "a 20 mm minimum, a 60 mm part",
                with(json!({ "min_skirt_length": 20 })),
                0.0,
                60.0,
            ),
            (
                "a 20 mm minimum round a 5 mm brim, a 12 mm part",
                with(json!({ "min_skirt_length": 20, "brim_type": "outer_only", "brim_width": 5 })),
                5.0,
                12.0,
            ),
            (
                "a 20 mm minimum past 2 loops, a 12 mm part",
                with(json!({ "min_skirt_length": 20, "skirt_loops": 2 })),
                0.0,
                12.0,
            ),
        ]
    }

    fn reach_cases() -> Vec<(&'static str, Value, f64)> {
        let base = json!({ "line_width": 0.42, "initial_layer_print_height": 0.2, "layer_height": 0.2, "nozzle_diameter": [0.4] });
        let with = |extra: Value| {
            let mut v = base.clone();
            if let (Some(m), Some(e)) = (v.as_object_mut(), extra.as_object()) {
                for (k, x) in e {
                    m.insert(k.clone(), x.clone());
                }
            }
            v
        };
        vec![
            (
                "nothing round it",
                with(json!({ "brim_type": "no_brim", "skirt_loops": 0 })),
                0.0,
            ),
            (
                "a 5 mm brim",
                with(json!({ "brim_type": "outer_only", "brim_width": 5, "skirt_loops": 0 })),
                5.0,
            ),
            (
                "an automatic brim of 6.2 mm",
                with(json!({ "brim_type": "auto_brim", "brim_width": 0, "skirt_loops": 0 })),
                6.2,
            ),
            (
                "a combined skirt",
                with(
                    json!({ "brim_type": "no_brim", "skirt_loops": 2, "skirt_distance": 3, "skirt_height": 1 }),
                ),
                0.0,
            ),
            (
                "its own skirt",
                with(
                    json!({ "brim_type": "no_brim", "skirt_type": "perobject", "skirt_loops": 2, "skirt_distance": 3, "skirt_height": 1 }),
                ),
                0.0,
            ),
            (
                "its own skirt round a brim",
                with(
                    json!({ "brim_type": "outer_only", "brim_width": 5, "skirt_type": "perobject", "skirt_loops": 3, "skirt_distance": 2, "skirt_height": 2 }),
                ),
                5.0,
            ),
            (
                "its own skirt, no height",
                with(
                    json!({ "brim_type": "no_brim", "skirt_type": "perobject", "skirt_loops": 2, "skirt_distance": 3, "skirt_height": 0 }),
                ),
                0.0,
            ),
            (
                "normal support",
                with(
                    json!({ "brim_type": "no_brim", "skirt_loops": 0, "enable_support": true, "support_type": "normal(auto)", "support_style": "default" }),
                ),
                0.0,
            ),
            (
                "normal support at 30 degrees",
                with(
                    json!({ "brim_type": "no_brim", "skirt_loops": 0, "enable_support": true, "support_type": "normal(auto)", "support_style": "grid", "support_angle": 30 }),
                ),
                0.0,
            ),
            (
                "snug support",
                with(
                    json!({ "brim_type": "no_brim", "skirt_loops": 0, "enable_support": true, "support_type": "normal(auto)", "support_style": "snug", "support_expansion": 1 }),
                ),
                0.0,
            ),
            (
                "tree support",
                with(
                    json!({ "brim_type": "no_brim", "skirt_loops": 0, "enable_support": true, "support_type": "tree(auto)" }),
                ),
                0.0,
            ),
            (
                "its own skirt, line width unset",
                json!({ "initial_layer_print_height": 0.2, "layer_height": 0.2, "nozzle_diameter": [0.4], "brim_type": "no_brim", "skirt_type": "perobject", "skirt_loops": 1, "skirt_distance": 2, "skirt_height": 1 }),
                0.0,
            ),
            (
                "snug support, line width unset",
                json!({ "initial_layer_print_height": 0.2, "layer_height": 0.2, "nozzle_diameter": [0.4], "brim_type": "no_brim", "skirt_loops": 0, "enable_support": true, "support_style": "snug" }),
                0.0,
            ),
            (
                "tree support past a wide brim",
                with(
                    json!({ "brim_type": "outer_only", "brim_width": 15, "skirt_loops": 0, "enable_support": true, "support_type": "tree(auto)" }),
                ),
                15.0,
            ),
        ]
    }

    /// A mesh: corners in mm and triangles wound out.
    type Shell = (Vec<[f64; 3]>, Vec<[u32; 3]>);

    /// A convex shell from its corners and its faces (corner indices, in order round the face), fanned into triangles
    /// wound out from the shell's middle.
    fn convex(corners: &[[f64; 3]], faces: &[&[usize]]) -> Shell {
        #[allow(clippy::cast_precision_loss, reason = "a handful of corners")]
        let n = corners.len() as f64;
        let mid = corners.iter().fold([0.0; 3], |m, p| {
            [m[0] + p[0] / n, m[1] + p[1] / n, m[2] + p[2] / n]
        });
        let mut tris = Vec::new();
        for f in faces {
            let at = |i: usize| corners[f[i]];
            for k in 1..f.len() - 1 {
                let (a, b, c) = (at(0), at(k), at(k + 1));
                let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
                let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
                let nrm = [
                    u[1] * v[2] - u[2] * v[1],
                    u[2] * v[0] - u[0] * v[2],
                    u[0] * v[1] - u[1] * v[0],
                ];
                let out = nrm[0] * (a[0] - mid[0]) + nrm[1] * (a[1] - mid[1]) + nrm[2] * (a[2] - mid[2]);
                #[allow(clippy::cast_possible_truncation, reason = "a handful of corners")]
                let t = [f[0] as u32, f[k] as u32, f[k + 1] as u32];
                tris.push(if out >= 0.0 { t } else { [t[0], t[2], t[1]] });
            }
        }
        (corners.to_vec(), tris)
    }

    fn cuboid(lo: [f64; 3], hi: [f64; 3]) -> Shell {
        let c: Vec<[f64; 3]> = (0..8)
            .map(|i| {
                [
                    if i & 1 == 0 { lo[0] } else { hi[0] },
                    if i & 2 == 0 { lo[1] } else { hi[1] },
                    if i & 4 == 0 { lo[2] } else { hi[2] },
                ]
            })
            .collect();
        convex(
            &c,
            &[
                &[0, 1, 3, 2],
                &[4, 5, 7, 6],
                &[0, 1, 5, 4],
                &[2, 3, 7, 6],
                &[0, 2, 6, 4],
                &[1, 3, 7, 5],
            ],
        )
    }

    /// A prism: the convex outline `xz` (x, z), from y 0 to `depth`.
    fn prism(xz: &[[f64; 2]], depth: f64) -> Shell {
        let n = xz.len();
        let c: Vec<[f64; 3]> = [0.0, depth]
            .into_iter()
            .flat_map(|y| xz.iter().map(move |p| [p[0], y, p[1]]))
            .collect();
        let near: Vec<usize> = (0..n).collect();
        let far: Vec<usize> = (n..2 * n).collect();
        let sides: Vec<Vec<usize>> = (0..n)
            .map(|i| vec![i, (i + 1) % n, n + (i + 1) % n, n + i])
            .collect();
        let mut faces: Vec<&[usize]> = vec![&near, &far];
        faces.extend(sides.iter().map(Vec::as_slice));
        convex(&c, &faces)
    }

    /// Two square pyramids base to base: tip at `z0`, the square (half width `r`) at `zm`, tip at `z1`.
    fn diamond(x: f64, y: f64, r: f64, z0: f64, zm: f64, z1: f64) -> Shell {
        let c = [
            [x - r, y - r, zm],
            [x + r, y - r, zm],
            [x + r, y + r, zm],
            [x - r, y + r, zm],
            [x, y, z0],
            [x, y, z1],
        ];
        convex(
            &c,
            &[
                &[0, 1, 4],
                &[1, 2, 4],
                &[2, 3, 4],
                &[3, 0, 4],
                &[0, 1, 5],
                &[1, 2, 5],
                &[2, 3, 5],
                &[3, 0, 5],
            ],
        )
    }

    fn joined(shells: &[Shell]) -> Shell {
        let mut out = (Vec::new(), Vec::new());
        for (p, t) in shells {
            #[allow(clippy::cast_possible_truncation, reason = "a handful of corners")]
            let o = out.0.len() as u32;
            out.0.extend_from_slice(p);
            out.1.extend(t.iter().map(|t| [t[0] + o, t[1] + o, t[2] + o]));
        }
        out
    }

    /// `p` placed by the column-major 4x4 `m`.
    fn placed(p: [f64; 3], m: &[f64; 16]) -> [f64; 3] {
        [
            m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
            m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
            m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
        ]
    }

    /// A support case: its name, mesh, transform, the plate's config, the object's own overrides, and whether an
    /// enforcer is on it.
    type SupportCase = (&'static str, Shell, Option<[f64; 16]>, Value, Value, bool);

    fn support_cases() -> Vec<SupportCase> {
        let base = json!({ "line_width": 0.42, "initial_layer_print_height": 0.2, "layer_height": 0.2, "nozzle_diameter": [0.4], "brim_type": "no_brim", "skirt_loops": 0, "support_threshold_angle": 25 });
        let with = |extra: Value| {
            let mut v = base.clone();
            if let (Some(m), Some(e)) = (v.as_object_mut(), extra.as_object()) {
                for (k, x) in e {
                    m.insert(k.clone(), x.clone());
                }
            }
            v
        };
        let tree = with(json!({ "enable_support": true, "support_type": "tree(auto)" }));
        let normal = with(
            json!({ "enable_support": true, "support_type": "normal(auto)", "support_style": "default" }),
        );
        let off = with(json!({ "enable_support": false, "support_type": "tree(auto)" }));
        let none = json!({});
        let cube = || cuboid([0.0, 0.0, 0.0], [20.0, 20.0, 20.0]);
        // A 10 mm post under a 20 mm slab: 5 mm of flat underside all round.
        let table = || {
            joined(&[
                cuboid([5.0, 5.0, 0.0], [15.0, 15.0, 10.0]),
                cuboid([0.0, 0.0, 10.0], [20.0, 20.0, 13.0]),
            ])
        };
        // An overhang whose underside rises from x 10 at the given slope, 12 mm tall.
        let ramp = |deg: f64| {
            let run = 12.0 / deg.to_radians().m_tan();
            prism(&[[0.0, 0.0], [10.0, 0.0], [10.0 + run, 12.0], [0.0, 12.0]], 10.0)
        };
        let over = [
            1.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 20.0, 13.0, 1.0,
        ];
        let flip = [
            1.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 10.0, 12.0, 1.0,
        ];
        vec![
            (
                "support off, a table",
                table(),
                None,
                off.clone(),
                none.clone(),
                false,
            ),
            (
                "support on, a cube",
                cube(),
                None,
                tree.clone(),
                none.clone(),
                false,
            ),
            (
                "tree support, a table",
                table(),
                None,
                tree.clone(),
                none.clone(),
                false,
            ),
            (
                "normal support, a table",
                table(),
                None,
                normal.clone(),
                none.clone(),
                false,
            ),
            (
                "snug support, a table",
                table(),
                None,
                with(
                    json!({ "enable_support": true, "support_type": "normal(auto)", "support_style": "snug" }),
                ),
                none.clone(),
                false,
            ),
            // Two shells touching: the post's end looks down onto the slab. The slice joins them and holds nothing up;
            // the rule cannot tell an inner face from an underside, so it counts support.
            (
                "a table turned over, two shells touching",
                table(),
                Some(over),
                tree.clone(),
                none.clone(),
                false,
            ),
            (
                "a 20 degree underside turned over",
                ramp(20.0),
                Some(flip),
                tree.clone(),
                none.clone(),
                false,
            ),
            (
                "a 20 degree underside",
                ramp(20.0),
                None,
                tree.clone(),
                none.clone(),
                false,
            ),
            (
                "a 45 degree underside",
                ramp(45.0),
                None,
                normal.clone(),
                none.clone(),
                false,
            ),
            (
                "a 40 degree underside, threshold 30",
                ramp(40.0),
                None,
                with(
                    json!({ "enable_support": true, "support_type": "normal(auto)", "support_threshold_angle": 30 }),
                ),
                none.clone(),
                false,
            ),
            (
                "a 40 degree underside, threshold 0",
                ramp(40.0),
                None,
                with(
                    json!({ "enable_support": true, "support_type": "normal(auto)", "support_threshold_angle": 0 }),
                ),
                none.clone(),
                false,
            ),
            (
                "a 45 degree underside, 3 enforced layers",
                ramp(45.0),
                None,
                with(
                    json!({ "enable_support": true, "support_type": "normal(auto)", "enforce_support_layers": 3 }),
                ),
                none.clone(),
                false,
            ),
            (
                "manual support, a table, no enforcer",
                table(),
                None,
                with(json!({ "enable_support": true, "support_type": "normal(manual)" })),
                none.clone(),
                false,
            ),
            (
                "manual support, a cube, an enforcer",
                cube(),
                None,
                with(json!({ "enable_support": true, "support_type": "tree(manual)" })),
                none.clone(),
                true,
            ),
            (
                "automatic support, a cube, an enforcer",
                cube(),
                None,
                tree.clone(),
                none.clone(),
                true,
            ),
            (
                "support off, a cube, an enforcer",
                cube(),
                None,
                off.clone(),
                none.clone(),
                true,
            ),
            (
                "a part hanging from a point",
                joined(&[
                    cuboid([0.0, 0.0, 0.0], [10.0, 10.0, 20.0]),
                    diamond(16.0, 5.0, 1.82, 10.0, 15.0, 20.0),
                ]),
                None,
                normal.clone(),
                none.clone(),
                false,
            ),
            (
                "plate off, the object on",
                table(),
                None,
                off,
                json!({ "enable_support": true }),
                false,
            ),
            (
                "plate on, the object off",
                table(),
                None,
                tree,
                json!({ "enable_support": false }),
                false,
            ),
        ]
    }

    /// The object's config: the plate's with its own overrides over it.
    fn merged(plate: &Value, own: &Value) -> Value {
        let mut v = plate.clone();
        if let (Some(m), Some(e)) = (v.as_object_mut(), own.as_object()) {
            for (k, x) in e {
                m.insert(k.clone(), x.clone());
            }
        }
        v
    }

    fn placed_mesh(c: &SupportCase) -> Vec<[f64; 3]> {
        c.1.0
            .iter()
            .map(|&p| c.2.as_ref().map_or(p, |m| placed(p, m)))
            .collect()
    }

    fn support_golden() -> Vec<Value> {
        support_cases()
            .iter()
            .map(|c| {
                let cfg = PrintConfig::from_value(&merged(&c.3, &c.4)).unwrap_or_default();
                let overhang = has_overhang(&placed_mesh(c), &c.1.1, &cfg);
                let gets = gets_support(&cfg, c.5, overhang);
                let positions: Vec<f64> = c.1.0.iter().flatten().map(|v| round(*v)).collect();
                let indices: Vec<u32> = c.1.1.iter().flatten().copied().collect();
                json!({
                    "name": c.0,
                    "mesh": { "positions": positions, "indices": indices },
                    "transform": c.2,
                    "config": c.3,
                    "object": c.4,
                    "enforcers": c.5,
                    "limitDeg": round(overhang_limit_deg(&cfg)),
                    "overhang": overhang,
                    "getsSupport": gets,
                    "reachMm": round(part_reach(&cfg, 0.0, gets)),
                })
            })
            .collect()
    }

    /// Slices every support case without an enforcer and checks the rule is never looser than the slice: where the
    /// first layer prints support, the rule says the object gets it; where the rule says it does not, nothing prints
    /// support at all. The cases the slice does support on its first layer are counted, so the check has teeth.
    #[test]
    fn the_support_rule_is_never_looser_than_the_slice() {
        let mut first_layer = 0;
        for c in support_cases().iter().filter(|c| !c.5) {
            let cfg = PrintConfig::from_value(&merged(&c.3, &c.4)).unwrap_or_default();
            let gets = gets_support(&cfg, false, has_overhang(&placed_mesh(c), &c.1.1, &cfg));
            let part = crate::mesh::MeshPart {
                name: "part".into(),
                slot: 1,
                color: None,
                #[allow(clippy::cast_possible_truncation, reason = "small test shapes in mm")]
                positions: placed_mesh(c).iter().map(|p| p.map(|v| v as f32)).collect(),
                triangles: c.1.1.clone(),
                paint: Vec::new(),
                support_paint: Vec::new(),
                seam_paint: Vec::new(),
                fuzzy_paint: Vec::new(),
                paint_texts: Vec::new(),
            };
            let mesh = std::sync::Arc::new(crate::mesh::Mesh {
                name: "case".into(),
                parts: vec![part],
                ..crate::mesh::Mesh::default()
            });
            let shift = [
                1.0f32, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 100.0, 100.0, 0.0, 1.0,
            ];
            let req: crate::api::SliceRequest = serde_json::from_value(json!({
                "plate": { "objects": [{ "mesh": "m", "transform": shift, "settings": c.4 }] },
                "config": c.3,
            }))
            .unwrap_or_else(|e| panic!("{}: {e}", c.0));
            let run = crate::api::run_request(&req, &|_: &str| Ok(mesh.clone()))
                .unwrap_or_else(|e| panic!("{}: {e}", c.0));
            let text = String::from_utf8_lossy(&run.gcode);
            let layers: Vec<&str> = text.split(";LAYER_CHANGE").collect();
            let on_first = layers.get(1).is_some_and(|l| l.contains(";TYPE:Support"));
            let anywhere = text.contains(";TYPE:Support");
            assert!(
                !on_first || gets,
                "{}: the slice prints support on the first layer, the rule says none",
                c.0
            );
            assert!(
                gets || !anywhere,
                "{}: the slice prints support, the rule says none",
                c.0
            );
            first_layer += usize::from(on_first);
        }
        assert!(
            first_layer >= 4,
            "only {first_layer} cases print support on the first layer"
        );
    }

    fn round(v: f64) -> f64 {
        (v * 1e6).round() / 1e6
    }

    fn golden() -> Value {
        let gantry: Vec<Value> = gantry_cases()
            .into_iter()
            .map(|(name, earlier, later, r)| {
                let meets = gantry_meets(earlier, later, r);
                assert_eq!(meets, beam_finds(earlier, later, r), "{name}: the rule and the beam disagree");
                json!({ "name": name, "earlier": earlier, "later": later, "toRod": r, "beamCells": beam_cells(r), "meets": meets })
            })
            .collect();
        let delta: Vec<Value> = [
            (Some("delta"), None, None),
            (Some("corexy"), None, None),
            (None, Some("flsun-v400"), None),
            (None, None, Some("FLSun V400")),
            (Some("i3"), Some("bambu-a1"), Some("Bambu Lab A1")),
            (None, None, None),
        ]
        .into_iter()
        .map(|(s, id, m)| json!({ "printerStructure": s, "printerId": id, "printerModel": m, "delta": is_delta(s, id, m) }))
        .collect();
        // A finished 20 mm box at x 0..20; the later object's outermost move `gap - reach` from it, on the walk's own
        // distance to a hull.
        let hull = [[0.0, 0.0], [20.0, 0.0], [20.0, 20.0], [0.0, 20.0]];
        let mut radius = Vec::new();
        for (gap, reach, r) in [
            (80.0, 0.0, 73.0),
            (73.0, 0.0, 73.0),
            (72.7, 0.0, 73.0),
            (78.0, 5.0, 73.0),
            (77.9, 5.0, 73.0),
            (40.0, 0.0, 68.0),
            (75.0, 7.2, 68.0),
        ] {
            for estimated in [true, false] {
                let d = super::super::walk::hull_distance(&hull, [20.0 + gap - reach, 10.0]);
                let hit = radius_hit(d, r, estimated)
                    .map(|(s, _)| if s == Severity::Hit { "block" } else { "soft" });
                radius.push(json!({ "gapMm": gap, "reachMm": reach, "radiusMm": r, "estimated": estimated, "distanceMm": round(d), "result": hit }));
            }
        }
        let mut reach: Vec<Value> = reach_cases()
            .into_iter()
            .map(|(name, config, brim)| {
                let cfg = PrintConfig::from_value(&config).unwrap_or_default();
                json!({ "name": name, "config": config, "brimMm": brim, "reachMm": round(object_room(&cfg, brim)) })
            })
            .collect();
        // With a footprint, a square `sideMm` across: the loops min_skirt_length adds round a small object count.
        reach.extend(skirt_length_cases().into_iter().map(|(name, config, brim, side)| {
            let cfg = PrintConfig::from_value(&config).unwrap_or_default();
            let hull = [[0.0, 0.0], [side, 0.0], [side, side], [0.0, side]];
            json!({ "name": name, "config": config, "brimMm": brim, "sideMm": side, "reachMm": round(object_room_around(&cfg, brim, &hull)) })
        }));
        json!({
            "comment": "Written by packages/core/src/collide/rules.rs (SX_BLESS=1 cargo test -p sx-core collide::rules); read by packages/settings/js/by-object.golden.test.ts. The engine's by-object rules on a set of cases: the gantry beam on the 1 mm lattice, deltas, the clearance radius, and how far an object's own first layer prints past it; and whether an object gets support, so its support's pad counts in that reach.",
            "cellMm": CELL,
            "gantry": gantry,
            "delta": delta,
            "radius": radius,
            "reach": reach,
            "support": support_golden(),
        })
    }

    #[test]
    fn the_golden_file_holds_the_rules_answers() {
        let text = serde_json::to_string_pretty(&golden()).unwrap_or_default() + "\n";
        let path = golden_path();
        if std::env::var_os("SX_BLESS").is_some() {
            std::fs::write(&path, &text).unwrap_or_else(|e| panic!("writing {}: {e}", path.display()));
        }
        let saved = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(
            saved == text,
            "{} is out of date: run SX_BLESS=1 cargo test -p sx-core collide::rules",
            path.display()
        );
    }

    #[test]
    fn the_beam_rule_is_the_height_grid_beam() {
        // Every cell offset across the reach, both ways, on a few reaches.
        for r in [0.0, 0.4, 1.0, 33.0, 56.5] {
            for i in 0..400 {
                let lo = 60.0 + f64::from(i) * 0.25;
                for earlier in [[100.0, 120.0], [100.3, 120.7]] {
                    let later = [lo, lo + 5.0];
                    assert_eq!(
                        gantry_meets(earlier, later, r),
                        beam_finds(earlier, later, r),
                        "rod {r}, later {later:?}, earlier {earlier:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn inside_the_radius_an_estimated_head_hits_and_a_measured_one_is_close() {
        assert_eq!(
            radius_hit(72.9, 73.0, true),
            Some((Severity::Hit, Part::Clearance))
        );
        assert_eq!(
            radius_hit(72.9, 73.0, false),
            Some((Severity::Close, Part::Toolhead))
        );
        assert_eq!(radius_hit(73.0, 73.0, true), None);
    }

    #[test]
    fn a_flsun_or_a_delta_structure_has_no_beam() {
        assert!(is_delta(Some("delta"), None, None));
        assert!(is_delta(None, Some("flsun-v400"), None));
        assert!(!is_delta(
            Some("corexy"),
            Some("bambu-p1s"),
            Some("Bambu Lab P1S")
        ));
    }
}
