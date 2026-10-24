// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The by-object rules heimdall's walk applies, as small pure functions: the gantry beam on the 1 mm lattice, which
//! printer has no beam, how a move inside the clearance radius counts, and how far an object's own first layer prints
//! past its footprint. The walk ([`super::walk`]), the height grids ([`super::grid`]) and the model ([`super::Model`])
//! call these, and a test writes their answers on a set of cases to `packages/settings/fixtures/by-object-golden.json`,
//! which the app's by-object check (`packages/settings/js/by-object.ts`) is tested against, so the two cannot drift.

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

#[cfg(test)]
mod tests {
    use super::super::grid::{Grid, Profile};
    use super::*;
    use crate::config::PrintConfig;
    use serde_json::{Value, json};

    /// Whether the gantry beam, with the nozzle anywhere in `later` (the y span of the moves of an object printed after,
    /// mm), passes over a finished object spanning `earlier` in y: the rows of cells the object stands on, grown by
    /// [`beam_cells`] either way, where [`under_beam`] lets the walk look. The app's check holds a plate to this.
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
        // Below the earlier object: the later one's top in the first row the beam reaches, on its edge, and short of it.
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
        let reach: Vec<Value> = reach_cases()
            .into_iter()
            .map(|(name, config, brim)| {
                let cfg = PrintConfig::from_value(&config).unwrap_or_default();
                json!({ "name": name, "config": config, "brimMm": brim, "reachMm": round(crate::tower::room_with(&cfg, brim)) })
            })
            .collect();
        json!({
            "comment": "Written by packages/core/src/collide/rules.rs (SX_BLESS=1 cargo test -p sx-core collide::rules); read by packages/settings/js/by-object.golden.test.ts. The engine's by-object rules on a set of cases: the gantry beam on the 1 mm lattice, deltas, the clearance radius, and how far an object's own first layer prints past it.",
            "cellMm": CELL,
            "gantry": gantry,
            "delta": delta,
            "radius": radius,
            "reach": reach,
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
