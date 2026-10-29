// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! On Bambu Lab printers, strips whose surface lines run across them print as before: the narrow piece rules for lines
//! across a strip on other printers leave them alone.
//!
//! A1 0.4 projects of strips 30.9 mm long along 135 degrees, the surface lines along 45 (`fixtures/line-across`: the
//! projects and each strip's center, direction and size), sliced with `sx slice` and the wall generator named: two
//! walls on the top (`2top2`) and the stock one wall on the top (`stock2`), no sparse infill. Per strip the test
//! reads, on the top layer and the first, the surface pieces across the strip and along it and the gap fill.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::disallowed_methods,
    clippy::float_cmp,
    reason = "a G-code reader for the test: positions, angles and lengths in mm"
)]

mod bambu_strips;

use bambu_strips::{Move, moves};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/line-across")
        .join(name)
}

/// One strip: its center, the direction it runs (degrees), its width and length, mm.
struct Strip {
    c: [f64; 2],
    ang: f64,
    w: f64,
    l: f64,
}

impl Strip {
    /// A point in the strip's frame: along its axis from its center, and across it.
    fn frame(&self, p: [f64; 2]) -> (f64, f64) {
        let a = self.ang.to_radians();
        let (ux, uy) = (a.cos(), a.sin());
        let (dx, dy) = (p[0] - self.c[0], p[1] - self.c[1]);
        (dx * ux + dy * uy, -dx * uy + dy * ux)
    }

    fn corners(&self) -> [[f64; 2]; 4] {
        let a = self.ang.to_radians();
        let (ux, uy) = (a.cos(), a.sin());
        [(-1.0, -1.0), (-1.0, 1.0), (1.0, -1.0), (1.0, 1.0)].map(|(i, j): (f64, f64)| {
            [
                self.c[0] + ux * i * self.l / 2.0 - uy * j * self.w / 2.0,
                self.c[1] + uy * i * self.l / 2.0 + ux * j * self.w / 2.0,
            ]
        })
    }
}

fn center(pts: impl Iterator<Item = [f64; 2]>) -> [f64; 2] {
    let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
    for p in pts {
        for k in 0..2 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    [f64::midpoint(lo[0], hi[0]), f64::midpoint(lo[1], hi[1])]
}

/// Each strip of the project `case` sliced with the wall generator `walls`, narrowest first, as one letter per layer
/// (top, first): `.` walls only, `g` gap fill only, `X` surface lines across the strip, `Y` the same with gap fill,
/// `L` surface lines along it, `M` the same with gap fill.
fn codes(case: &str, walls: &str) -> (String, String) {
    let config = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("line-across-{walls}.json"));
    std::fs::write(&config, format!("{{\"wall_generator\":\"{walls}\"}}")).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_sx"))
        .arg("slice")
        .arg(fixture(&format!("{case}.3mf")))
        .arg("--config")
        .arg(&config)
        .args(["--plate", "1", "-o", "-"])
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let moves = moves(&String::from_utf8(out.stdout).unwrap());
    let v: Value =
        serde_json::from_slice(&std::fs::read(fixture(&format!("{case}.strips.json"))).unwrap()).unwrap();
    let mut strips: Vec<Strip> = v
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            let f = |k: &str| s[k].as_f64().unwrap();
            Strip {
                c: [f("cx"), f("cy")],
                ang: f("ang"),
                w: f("W"),
                l: f("L"),
            }
        })
        .collect();
    strips.sort_by(|a, b| a.w.total_cmp(&b.w));
    // Where the slice put the object: the first layer's outer wall against the strips' own bounds.
    let first_z = moves.iter().map(|m| m.z).min().unwrap();
    let top_z = moves.iter().map(|m| m.z).max().unwrap();
    let placed = center(
        moves
            .iter()
            .filter(|m| m.z == first_z && m.feature == "Outer wall")
            .flat_map(|m| [m.a, m.b]),
    );
    let own = center(strips.iter().flat_map(Strip::corners));
    for s in &mut strips {
        s.c = [s.c[0] + placed[0] - own[0], s.c[1] + placed[1] - own[1]];
    }
    let code = |s: &Strip, z: i64, surface: &str| -> char {
        let mine: Vec<&Move> = moves
            .iter()
            .filter(|m| {
                let (u, v) = s.frame([f64::midpoint(m.a[0], m.b[0]), f64::midpoint(m.a[1], m.b[1])]);
                m.z == z && u.abs() <= s.l / 2.0 + 0.05 && v.abs() <= s.w / 2.0 + 0.05
            })
            .collect();
        let (mut across, mut along, mut gap, mut other) = (0.0, 0.0, 0.0, 0.0);
        for m in mine {
            let ((u0, v0), (u1, v1)) = (s.frame(m.a), s.frame(m.b));
            let len = (u1 - u0).hypot(v1 - v0);
            let off = ((v1 - v0).atan2(u1 - u0).to_degrees() + 90.0).rem_euclid(180.0) - 90.0;
            match m.feature.as_str() {
                f if f == surface && off.abs() >= 80.0 => across += len,
                f if f == surface && off.abs() <= 10.0 => along += len,
                "Gap infill" => gap += len,
                "Outer wall" | "Inner wall" => {}
                _ => other += len,
            }
        }
        match (across >= 0.05 && across >= along, along > 0.05, gap > 0.05) {
            (true, _, false) => 'X',
            (true, _, true) => 'Y',
            (false, true, false) => 'L',
            (false, true, true) => 'M',
            (false, false, true) => 'g',
            _ if other > 0.05 => 'o',
            _ => '.',
        }
    };
    (
        strips.iter().map(|s| code(s, top_z, "Top surface")).collect(),
        strips
            .iter()
            .map(|s| code(s, first_z, "Bottom surface"))
            .collect(),
    )
}

/// LA-G6 (guard). The A1, no sparse infill, the aegis walls, lines across the strips 1.682 to 3.190 mm wide: with two
/// walls on the top, the top prints lines across with gap fill beside them from 2.436 mm; with the stock one wall on
/// the top, every strip does. The first layer prints walls only below 2.927 mm and lines across from there, in both
/// projects.
#[test]
fn la_g6_bambu_lab_strips_with_lines_across_are_unchanged() {
    let got = [
        codes("a1--n4-cl-sp0-ac-2top2", "aegis"),
        codes("a1--n4-cl-sp0-ac-stock2", "aegis"),
    ];
    let want = [
        (
            "....................YYYYYYYYYYYYYYYYYYYYY",
            ".................................XXXXXXXX",
        ),
        (
            "YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY",
            ".................................XXXXXXXX",
        ),
    ]
    .map(|(t, f): (&str, &str)| (t.to_owned(), f.to_owned()));
    assert_eq!(got, want);
}

/// LA-G7 (guard). The same A1 project with two walls on the top and the classic walls: the first layer keeps its gap
/// fill bead in every strip that had one, 1.682 to 1.833 mm and 2.097 to 2.361 mm, then prints surface lines from
/// 2.399 mm. On a Bambu Lab printer a first-layer strip counts as surface only where a line of its pitch plus 0.05 mm
/// fits, as the surface fill there prints it; a strip with less room keeps its bead rather than printing walls only.
#[test]
fn la_g7_bambu_lab_first_layer_strips_keep_their_gap_fill_with_classic_walls() {
    let (_, first) = codes("a1--n4-cl-sp0-ac-2top2", "classic");
    assert_eq!(first, "ggggg......ggggggggLLLLLLLLLLLXXXXXXXXXXX");
}
