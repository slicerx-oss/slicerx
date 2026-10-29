// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Strip projects for the Bambu Lab surface tests: `sx slice` a project of `fixtures/bambu-surface-edge` and read,
//! per strip, its top layer and first layer (surface lines, gap fill and wall centerlines).
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::disallowed_methods,
    clippy::float_cmp,
    dead_code,
    reason = "a G-code reader for the tests: positions, angles and lengths in mm; each test file uses part of it"
)]

use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;

pub fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/bambu-surface-edge")
        .join(name)
}

/// One strip of a project: its center, the direction it runs (degrees), its width and length, mm.
pub struct Strip {
    pub cx: f64,
    pub cy: f64,
    pub ang: f64,
    pub w: f64,
    pub l: f64,
}

/// What one strip prints on one layer.
#[derive(Debug, Default, Clone)]
pub struct Row {
    /// The strip's width, mm.
    pub w: f64,
    /// Surface line offsets from the strip's low long side across the lines, merged within 0.01 mm.
    pub lines: Vec<f64>,
    /// The surface lines' stated widths.
    pub widths: Vec<f64>,
    /// Gap fill length, mm.
    pub gap_fill: f64,
    /// Wall centerlines along the strip as distances from its nearer long side, with each one's length.
    pub walls: Vec<(f64, f64)>,
    /// Where the strip's low long side lies across the lines, mm from the center of the object's box.
    pub base: f64,
}

impl Row {
    pub fn margins(&self) -> Option<(f64, f64, f64)> {
        let (first, last) = (*self.lines.first()?, *self.lines.last()?);
        let n = self.lines.len();
        (n >= 2).then(|| (first, self.w - last, (last - first) / (n - 1) as f64))
    }
}

/// One layer of a project: each strip's row, narrowest first.
pub struct Layer(pub Vec<Row>);

impl Layer {
    /// The row of the strip `w` wide (to the stated 3 decimals).
    pub fn at(&self, w: f64) -> &Row {
        self.0
            .iter()
            .find(|r| (r.w - w).abs() < 0.0006)
            .unwrap_or_else(|| panic!("no strip {w}"))
    }

    /// The wall centerlines seen on 3 strips or more, each at least 5 mm long, merged within 0.004 mm.
    pub fn walls(&self) -> Vec<f64> {
        let mut all: Vec<f64> = self
            .0
            .iter()
            .flat_map(|r| r.walls.iter().filter(|w| w.1 > 5.0).map(|w| w.0))
            .collect();
        all.sort_by(f64::total_cmp);
        let mut groups: Vec<Vec<f64>> = Vec::new();
        for d in all {
            match groups.last_mut() {
                Some(g) if g.last().is_some_and(|l| d - l <= 0.004) => g.push(d),
                _ => groups.push(vec![d]),
            }
        }
        groups
            .into_iter()
            .filter(|g| g.len() >= 3)
            .map(|g| g.iter().sum::<f64>() / g.len() as f64)
            .collect()
    }

    /// Where a spread surface starts, mm from the outline: each margin less half the line spacing, over the strips
    /// with 2 lines or more whose two margins agree within 0.01 mm.
    pub fn ins(&self) -> f64 {
        let ins: Vec<f64> = self
            .0
            .iter()
            .filter_map(Row::margins)
            .filter(|(m0, m1, _)| (m0 - m1).abs() < 0.01)
            .flat_map(|(m0, m1, gap)| [m0 - gap / 2.0, m1 - gap / 2.0])
            .collect();
        assert!(ins.len() >= 6, "too few spread strips: {}", ins.len());
        ins.iter().sum::<f64>() / ins.len() as f64
    }

    /// The interval a grid surface's first line threshold lies in, mm from the outline: (the largest margin less the
    /// median line spacing, the smallest margin], over the strips with 2 lines or more.
    pub fn threshold(&self) -> (f64, f64) {
        let rows: Vec<(f64, f64, f64)> = self.0.iter().filter_map(Row::margins).collect();
        let mut gaps: Vec<f64> = rows.iter().map(|r| r.2).collect();
        gaps.sort_by(f64::total_cmp);
        let median = gaps[gaps.len() / 2];
        let margins = rows.iter().flat_map(|r| [r.0, r.1]);
        (
            margins.clone().map(|m| m - median).fold(f64::MIN, f64::max),
            margins.fold(f64::MAX, f64::min),
        )
    }

    /// One code per strip, narrowest first: `.` walls only, `g` gap fill only, a digit N surface lines, `a` to `i`
    /// 1 to 9 lines plus gap fill.
    pub fn codes(&self) -> String {
        self.0
            .iter()
            .map(|r| {
                let gap = r.gap_fill > 0.05;
                match (r.lines.len(), gap) {
                    (0, false) => '.',
                    (0, true) => 'g',
                    (n, false) => char::from_digit(n as u32, 10).unwrap_or('X'),
                    (n, true) => char::from(b'a' + (n as u8 - 1)),
                }
            })
            .collect()
    }
}

pub fn strips(case: &str) -> Vec<Strip> {
    let v: Value =
        serde_json::from_slice(&std::fs::read(fixture(&format!("{case}.strips.json"))).unwrap()).unwrap();
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| {
            let f = |k: &str| s[k].as_f64().unwrap();
            Strip {
                cx: f("cx"),
                cy: f("cy"),
                ang: f("ang"),
                w: f("W"),
                l: f("L"),
            }
        })
        .collect()
}

pub fn word(line: &str, key: char) -> Option<f64> {
    line.split(';')
        .next()?
        .split_whitespace()
        .find_map(|w| w.strip_prefix(key).and_then(|v| v.parse().ok()))
}

/// One extruding move: feature, layer z (micrometers), start, end, stated width.
pub struct Move {
    pub feature: String,
    pub z: i64,
    pub a: [f64; 2],
    pub b: [f64; 2],
    pub width: Option<f64>,
}

/// The project `case`'s G-code, as `sx slice <project> --plate 1` writes it.
pub fn slice(case: &str) -> String {
    let out = Command::new(env!("CARGO_BIN_EXE_sx"))
        .arg("slice")
        .arg(fixture(&format!("{case}.3mf")))
        .args(["--plate", "1", "-o", "-"])
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap()
}

pub fn moves(gcode: &str) -> Vec<Move> {
    let (mut x, mut y): (Option<f64>, Option<f64>) = (None, None);
    let (mut feature, mut width, mut z) = (String::new(), None, None::<f64>);
    let mut out = Vec::new();
    for line in gcode.lines() {
        if let Some(t) = line
            .strip_prefix(";TYPE:")
            .or_else(|| line.strip_prefix("; FEATURE:"))
        {
            t.trim().clone_into(&mut feature);
            continue;
        }
        if let Some(t) = line
            .strip_prefix(";WIDTH:")
            .or_else(|| line.strip_prefix("; LINE_WIDTH:"))
        {
            width = t.trim().parse().ok();
            continue;
        }
        if let Some(t) = line
            .strip_prefix(";Z:")
            .or_else(|| line.strip_prefix("; Z_HEIGHT:"))
        {
            z = t.trim().parse().ok();
            continue;
        }
        // The projects turn arc fitting off, so arcs are only travel (the lift's spiral) and the printer's own start
        // and end G-code; an extruding one would be read as its chord.
        if line.starts_with("G2 ") || line.starts_with("G3 ") {
            assert!(
                word(line, 'E').unwrap_or(0.0) <= 0.0 || feature.is_empty() || feature == "Custom",
                "an extruding arc in {feature}: {line}"
            );
            (x, y) = (word(line, 'X').or(x), word(line, 'Y').or(y));
            continue;
        }
        if !(line.starts_with("G1 ") || line.starts_with("G0 ")) {
            continue;
        }
        let (nx, ny) = (word(line, 'X').or(x), word(line, 'Y').or(y));
        let e = word(line, 'E').unwrap_or(0.0);
        if let (Some(ax), Some(ay), Some(bx), Some(by), Some(zz)) = (x, y, nx, ny, z)
            && e > 0.0
            && (ax != bx || ay != by)
        {
            out.push(Move {
                feature: feature.clone(),
                z: (zz * 1000.0).round() as i64,
                a: [ax, ay],
                b: [bx, by],
                width,
            });
        }
        (x, y) = (nx, ny);
    }
    out
}

/// The project `case`'s top layer and first layer, per strip.
pub fn measure(case: &str) -> (Layer, Layer) {
    let moves = moves(&slice(case));
    let mut strips = strips(case);
    // Where the slice put the object: the first layer's outer wall against the strips' own bounds.
    let corners = |s: &Strip| {
        let a = s.ang.to_radians();
        let (ux, uy) = (a.cos(), a.sin());
        [(-1.0, -1.0), (-1.0, 1.0), (1.0, -1.0), (1.0, 1.0)].map(|(i, j): (f64, f64)| {
            [
                s.cx + ux * i * s.l / 2.0 - uy * j * s.w / 2.0,
                s.cy + uy * i * s.l / 2.0 + ux * j * s.w / 2.0,
            ]
        })
    };
    let center = |pts: &mut dyn Iterator<Item = [f64; 2]>| {
        let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
        for p in pts {
            for k in 0..2 {
                lo[k] = lo[k].min(p[k]);
                hi[k] = hi[k].max(p[k]);
            }
        }
        [f64::midpoint(lo[0], hi[0]), f64::midpoint(lo[1], hi[1])]
    };
    let first_z = moves.iter().map(|m| m.z).min().unwrap();
    let placed = center(
        &mut moves
            .iter()
            .filter(|m| m.z == first_z && m.feature == "Outer wall")
            .flat_map(|m| [m.a, m.b]),
    );
    let own = center(&mut strips.iter().flat_map(corners));
    for s in &mut strips {
        s.cx += placed[0] - own[0];
        s.cy += placed[1] - own[1];
    }
    let inside = |s: &Strip, p: [f64; 2]| {
        let a = s.ang.to_radians();
        let (ux, uy) = (a.cos(), a.sin());
        let (dx, dy) = (p[0] - s.cx, p[1] - s.cy);
        (dx * ux + dy * uy).abs() <= s.l / 2.0 + 0.05 && (-dx * uy + dy * ux).abs() <= s.w / 2.0 + 0.05
    };
    let mut by: BTreeMap<(i64, usize), Vec<&Move>> = BTreeMap::new();
    for m in &moves {
        let mid = [f64::midpoint(m.a[0], m.b[0]), f64::midpoint(m.a[1], m.b[1])];
        if let Some(i) = strips.iter().position(|s| inside(s, mid)) {
            by.entry((m.z, i)).or_default().push(m);
        }
    }
    let top_z = by.keys().map(|k| k.0).max().unwrap();
    let first_z = by.keys().map(|k| k.0).min().unwrap();
    let layer = |z: i64, surface: &str| {
        let mut rows: Vec<Row> = strips
            .iter()
            .enumerate()
            .map(|(i, s)| row(s, by.get(&(z, i)).map_or(&[][..], Vec::as_slice), surface, placed))
            .collect();
        rows.sort_by(|a, b| a.w.total_cmp(&b.w));
        Layer(rows)
    };
    (layer(top_z, "Top surface"), layer(first_z, "Bottom surface"))
}

/// What strip `s` prints on one layer, from the layer's `moves` within it; `center` is the center of the object's box.
pub fn row(s: &Strip, moves: &[&Move], surface: &str, center: [f64; 2]) -> Row {
    let mut r = Row {
        w: s.w,
        ..Row::default()
    };
    let length = |m: &Move| (m.b[0] - m.a[0]).hypot(m.b[1] - m.a[1]);
    let deg = |m: &Move| (m.b[1] - m.a[1]).atan2(m.b[0] - m.a[0]).to_degrees();
    let off = |d: f64, dir: f64| ((d - dir + 90.0).rem_euclid(180.0) - 90.0).abs();
    let (su, sv) = (s.ang.to_radians().cos(), s.ang.to_radians().sin());
    r.gap_fill = moves
        .iter()
        .filter(|m| m.feature == "Gap infill")
        .map(|m| length(m))
        .sum();
    // Walls: moves at least 1 mm long within 3 degrees of the strip, their midpoints in the middle 60 % of its
    // length, merged within 0.003 mm.
    let mut walls: Vec<(f64, f64)> = moves
        .iter()
        .filter(|m| m.feature.ends_with(" wall") && length(m) >= 1.0 && off(deg(m), s.ang) <= 3.0)
        .filter_map(|m| {
            let (mx, my) = (
                f64::midpoint(m.a[0], m.b[0]) - s.cx,
                f64::midpoint(m.a[1], m.b[1]) - s.cy,
            );
            ((mx * su + my * sv).abs() <= 0.3 * s.l)
                .then(|| (s.w / 2.0 - (-mx * sv + my * su).abs(), length(m)))
        })
        .collect();
    walls.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut groups: Vec<(Vec<f64>, f64)> = Vec::new();
    for (d, len) in walls {
        match groups.last_mut() {
            Some(g) if g.0.last().is_some_and(|l| d - l <= 0.003) => {
                g.0.push(d);
                g.1 += len;
            }
            _ => groups.push((vec![d], len)),
        }
    }
    r.walls = groups
        .into_iter()
        .map(|(ds, len)| (ds.iter().sum::<f64>() / ds.len() as f64, len))
        .collect();
    // Surface lines: moves at least 0.2 mm long in the dominant direction (within 3 degrees).
    let lines: Vec<&&Move> = moves
        .iter()
        .filter(|m| m.feature == surface && length(m) >= 0.2)
        .collect();
    let mut weight: BTreeMap<i64, f64> = BTreeMap::new();
    for m in &lines {
        *weight.entry((deg(m).round() as i64).rem_euclid(180)).or_default() += length(m);
    }
    let Some(dir) = weight
        .iter()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .map(|(d, _)| *d as f64)
    else {
        return r;
    };
    let (ux, uy) = (dir.to_radians().cos(), dir.to_radians().sin());
    let across = |p: [f64; 2]| -uy * (p[0] - s.cx) + ux * (p[1] - s.cy);
    let lo = [(-1.0, -1.0), (-1.0, 1.0), (1.0, -1.0), (1.0, 1.0)]
        .iter()
        .map(|&(i, j): &(f64, f64)| {
            across([
                s.cx + su * i * s.l / 2.0 - sv * j * s.w / 2.0,
                s.cy + sv * i * s.l / 2.0 + su * j * s.w / 2.0,
            ])
        })
        .fold(f64::MAX, f64::min);
    r.base = lo + (-uy * (s.cx - center[0]) + ux * (s.cy - center[1]));
    let mut offs: Vec<f64> = lines
        .iter()
        .filter(|m| off(deg(m), dir) < 3.0)
        .map(|m| across(m.a))
        .collect();
    offs.sort_by(f64::total_cmp);
    for o in offs {
        if r.lines.last().is_none_or(|l| o - (l + lo) > 0.01) {
            r.lines.push(o - lo);
        }
    }
    for m in lines.iter().filter(|m| off(deg(m), dir) < 3.0) {
        if let Some(w) = m.width
            && !r.widths.contains(&w)
        {
            r.widths.push(w);
        }
    }
    r
}

pub fn near(got: f64, want: f64, tol: f64, what: &str) {
    assert!(
        (got - want).abs() <= tol,
        "{what}: {got:.4}, expected {want} within {tol}"
    );
}

pub fn lines_at(row: &Row, want: &[f64], tol: f64, what: &str) {
    assert_eq!(row.lines.len(), want.len(), "{what}: lines {:?}", row.lines);
    for (g, w) in row.lines.iter().zip(want) {
        near(*g, *w, tol, what);
    }
}

pub fn widths(row: &Row, want: f64, tol: f64, what: &str) {
    assert!(!row.widths.is_empty(), "{what}: no surface line");
    for w in &row.widths {
        near(*w, want, tol, what);
    }
}

/// G-c: the wall centerlines of both layers, mm from the outline, as they were before the surface edge moved.
pub fn walls(case: &str, top: &Layer, first: &Layer, want_top: &[f64], want_first: &[f64]) {
    for (layer, got, want) in [
        ("top", top.walls(), want_top),
        ("first", first.walls(), want_first),
    ] {
        assert_eq!(got.len(), want.len(), "{case} {layer} walls {got:?}");
        for (g, w) in got.iter().zip(want) {
            near(*g, *w, 0.0005, &format!("{case} {layer} wall"));
        }
    }
}

pub const A1_TOP: [f64; 2] = [0.21, 0.6021];
pub const A1_FIRST: [f64; 2] = [0.3251, 0.7822];
