// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! aegis walls with the features that touch walls: seams, scarf seams, fuzzy skin, ironing, two filaments,
//! sleipnir's variable layers and shards. Each run must keep every wall the plain aegis run prints, and five
//! shards must write the same G-code as one.

#![allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::needless_pass_by_value
)]
// Checks measure the output with the standard math functions; the engine's own rounding rule (clippy.toml) is for G-code.
#![allow(clippy::disallowed_methods)]

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, SliceRequest};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn mesh(path: &str, name: &str) -> Arc<Mesh> {
    Arc::new(Mesh::load(&std::fs::read(format!("{}/{path}", root())).unwrap(), name).unwrap())
}

/// The wedge (one wall to several along its length) and the two filament X.
fn wedge() -> Arc<Mesh> {
    mesh("packages/core/cli/tests/fixtures/wedge.stl", "wedge.stl")
}

fn run(m: &Arc<Mesh>, config: Value, options: Value) -> String {
    let mut c = json!({"wall_generator": "aegis", "wall_loops": 3, "slow_down_for_layer_cooling": false});
    if let (Some(dst), Some(src)) = (c.as_object_mut(), config.as_object()) {
        dst.extend(src.clone());
    }
    let req: SliceRequest = serde_json::from_value(
        json!({"plate": {"objects": [{"mesh": "m"}]}, "config": c, "options": options}),
    )
    .unwrap();
    let m = m.clone();
    let run = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// Wall extrusion length per layer height (mm, keyed by Z in microns): outer and inner walls together.
fn walls(g: &str) -> BTreeMap<i64, f64> {
    let mut out = BTreeMap::new();
    let (mut z, mut wall, mut x, mut y) = (0i64, false, 0.0f64, 0.0f64);
    for line in g.lines() {
        if let Some(v) = line.strip_prefix(";Z:") {
            z = (v.trim().parse::<f64>().unwrap_or(0.0) * 1000.0).round() as i64;
        } else if let Some(t) = line.strip_prefix(";TYPE:") {
            wall = matches!(t.trim(), "Outer wall" | "Inner wall" | "Overhang wall");
        }
        let code = line.split(';').next().unwrap_or("");
        if !(code.starts_with("G0 ")
            || code.starts_with("G1 ")
            || code.starts_with("G2 ")
            || code.starts_with("G3 "))
        {
            continue;
        }
        let word = |c: char| {
            code.split_whitespace()
                .find_map(|w| w.strip_prefix(c))
                .and_then(|v| v.parse::<f64>().ok())
        };
        let (nx, ny) = (word('X').unwrap_or(x), word('Y').unwrap_or(y));
        if wall && word('E').is_some_and(|e| e > 0.0) {
            *out.entry(z).or_insert(0.0) += (nx - x).hypot(ny - y);
        }
        (x, y) = (nx, ny);
    }
    out
}

/// Every layer with walls in `base` has them in `other`, at least `share` of the length.
fn keeps_walls(base: &BTreeMap<i64, f64>, other: &BTreeMap<i64, f64>, share: f64, what: &str) {
    assert!(!base.is_empty(), "{what}: no walls at all");
    for (z, len) in base {
        let got = other.get(z).copied().unwrap_or(0.0);
        assert!(
            got >= len * share,
            "{what}: layer at {z} um has {got:.1} mm of wall, plain aegis {len:.1}"
        );
    }
}

fn same_with_shards(m: &Arc<Mesh>, config: &Value, options: &Value, what: &str) -> String {
    let one = run(m, config.clone(), options.clone());
    let mut o5 = options.clone();
    o5["shards"] = json!(5);
    let five = run(m, config.clone(), o5);
    assert!(one == five, "{what}: five shards differ from one");
    one
}

#[test]
fn wall_features_keep_every_aegis_wall_and_shard_alike() {
    let m = wedge();
    let base = walls(&same_with_shards(&m, &json!({}), &json!({}), "plain"));
    let cases: Vec<(&str, Value, f64)> = vec![
        ("seam aligned", json!({"seam_position": "aligned"}), 0.97),
        ("seam nearest", json!({"seam_position": "nearest"}), 0.97),
        ("seam random", json!({"seam_position": "random"}), 0.97),
        ("seam back", json!({"seam_position": "back"}), 0.97),
        ("scarf outer", json!({"seam_slope_type": "external"}), 0.97),
        ("scarf all", json!({"seam_slope_type": "all"}), 0.97),
        ("fuzzy outer", json!({"fuzzy_skin": "external"}), 0.97),
        ("fuzzy all walls", json!({"fuzzy_skin": "allwalls"}), 0.97),
        ("ironing", json!({"ironing_type": "top"}), 0.99),
        (
            "outer wall first",
            json!({"wall_sequence": "outer wall/inner wall"}),
            0.99,
        ),
    ];
    for (what, config, share) in cases {
        let g = same_with_shards(&m, &config, &json!({}), what);
        keeps_walls(&base, &walls(&g), share, what);
    }
}

#[test]
fn sleipnir_layers_keep_aegis_walls_on_every_layer_and_shard_alike() {
    let m = wedge();
    // Thin layers low down, thick ones above, as sleipnir plans a part that changes with height.
    let mut tops = Vec::new();
    let mut z: f64 = 0.2;
    while z < 30.0 {
        tops.push((z * 1000.0).round() / 1000.0);
        z += if z < 3.0 { 0.08 } else { 0.28 };
    }
    let g = same_with_shards(&m, &json!({}), &json!({"layerTopsMm": tops}), "sleipnir");
    let w = walls(&g);
    let layers = g.matches(sx_core::extras::layer_mark(&g)).count();
    assert!(layers > 20, "{layers} layers");
    assert_eq!(w.len(), layers, "every layer prints walls");
    assert!(w.values().all(|l| *l > 1.0), "{w:?}");
}

#[test]
fn two_filaments_keep_aegis_walls_and_shard_alike() {
    let m = mesh(
        "packages/core/bench/models/x-mark-2color.3mf",
        "x-mark-2color.3mf",
    );
    let classic = walls(&run(&m, json!({"wall_generator": "classic"}), json!({})));
    let g = same_with_shards(&m, &json!({}), &json!({}), "two filaments");
    assert!(
        g.contains("\nT1\n") || g.contains("\nT1 "),
        "both filaments print"
    );
    // Walls of both filaments on every layer: aegis lays at least as much wall as the classic walls do, less
    // a little where it merges thin beads.
    keeps_walls(&classic, &walls(&g), 0.9, "two filaments");
}
