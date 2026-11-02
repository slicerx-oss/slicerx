// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! How a monotonic line top ends at a sharp tip on Bambu Lab printers, and the cap the strip in front of its lines
//! gets. Checked on the A1 with classic walls on plates of isosceles triangles with 7 mm legs, the bottom wall level
//! and the tip at +x (`tips`) or -x (`tipsm`), 24 to an angle, each shifted a little more against the line grid so
//! their tips sample every line phase, and on a 40 by 12 mm triangle (`tri`).
//!
//! - Below about 25 degrees a classic wall gap fill bead (the wedge) runs down the tip's bisector between the two
//!   sides of the wall, from near the tip into the body. E is its medial end, the point farthest from the tip, and Q
//!   is 0.207 mm further along the bisector. The surface's lines end at a straight cut across the bisector through Q.
//! - p is the gap from Q to the nearest surface line's edge (its centerline less half its width; negative when a line
//!   covers Q). With p at least 0.123 mm the tip gets exactly one cap across the bisector, from the line-end boundary
//!   on one side to the other, its near side at the cut and 0.021 mm narrower than p. With p up to 0.104 it gets none.
//! - Tips without a wedge (50 and 70 degrees) get none.

#![allow(
    clippy::disallowed_methods,
    clippy::float_cmp,
    clippy::many_single_char_names,
    clippy::cast_precision_loss,
    reason = "a G-code reader for the test: plate coordinates and layer heights in mm"
)]

use serde_json::{Map, Value, json};
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(format!("{}/{path}", root())).unwrap()).unwrap()
}

/// The stock A1 as the app sets it up with uniform layers and the classic walls and plain outer wall its projects
/// carry, then `edits`.
fn a1(edits: &[(&str, Value)]) -> Map<String, Value> {
    let mut out = Map::new();
    for (k, v) in read("packages/settings/defaults.json").as_object().unwrap() {
        out.insert(k.clone(), v[1].clone());
    }
    let m = read("packages/profiles/resolved/bambu-lab.json")["models"]["bambu-a1"].clone();
    let base = m["base"].as_str().unwrap().to_owned();
    for part in [&m["process"][&base], &m["filament"], &m["machine"]] {
        for (k, v) in part.as_object().unwrap() {
            out.insert(k.clone(), v.clone());
        }
    }
    out.insert("smart_layer".into(), json!("off"));
    out.insert("wall_generator".into(), json!("classic"));
    out.insert("precise_outer_wall".into(), json!(false));
    for (k, v) in edits {
        out.insert((*k).to_owned(), v.clone());
    }
    out
}

type P = (f64, f64);

/// One triangle of a plate: its corners with the tip first (counterclockwise), its tip angle and its index in the
/// full sweep the plate was cut from.
struct Tri {
    poly: [P; 3],
    angle: f64,
    island: usize,
}

/// A plate of triangles: the model and each triangle in model coordinates.
struct Plate {
    stl: Vec<u8>,
    tris: Vec<Tri>,
}

fn plate(name: &str) -> Plate {
    let dir = format!("{}/packages/core/tests/fixtures/gap-fill", root());
    let meta: Value =
        serde_json::from_slice(&std::fs::read(format!("{dir}/{name}.meta.json")).unwrap()).unwrap();
    let f = |v: &Value| v.as_f64().unwrap();
    Plate {
        stl: std::fs::read(format!("{dir}/{name}.stl")).unwrap(),
        tris: meta["tips"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| {
                let p = t["poly"].as_array().unwrap();
                let at = |i: usize| (f(&p[i][0]), f(&p[i][1]));
                Tri {
                    poly: [at(0), at(1), at(2)],
                    angle: f(&t["angle"]),
                    island: usize::try_from(t["island"].as_u64().unwrap()).unwrap(),
                }
            })
            .collect(),
    }
}

/// The G-code of one part on the plate where the app puts it.
fn slice(model: &[u8], config: Map<String, Value>) -> String {
    let mesh = Arc::new(Mesh::load(model, "m.stl").unwrap());
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"id": "o1", "name": "part", "mesh": "m"}]},
        "config": Value::Object(config),
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let r = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(r.gcode).unwrap()
}

/// One XY move: its feature, the feature before it, layer z, ends, whether it extrudes and its stated width.
#[derive(Clone)]
struct Move {
    feature: String,
    before: String,
    z: f64,
    from: P,
    to: P,
    extrudes: bool,
    width: f64,
}

fn word(code: &str, k: char) -> Option<f64> {
    code.split_whitespace()
        .skip(1)
        .find_map(|w| w.strip_prefix(k))
        .and_then(|v| v.parse().ok())
}

fn moves(g: &str) -> Vec<Move> {
    let (mut x, mut y, mut z, mut w) = (0.0_f64, 0.0_f64, 0.0_f64, 0.0_f64);
    let (mut feature, mut before) = (String::new(), String::new());
    let mut out = Vec::new();
    for line in g.lines() {
        let s = line.trim();
        if let Some(f) = s.strip_prefix("; FEATURE:").or_else(|| s.strip_prefix(";TYPE:")) {
            let f = f.trim().to_owned();
            if f != feature {
                before = std::mem::replace(&mut feature, f);
            }
            continue;
        }
        if let Some(v) = s.strip_prefix("; Z_HEIGHT:").or_else(|| s.strip_prefix(";Z:")) {
            z = v.trim().parse().unwrap();
            continue;
        }
        if let Some(v) = s
            .strip_prefix("; LINE_WIDTH:")
            .or_else(|| s.strip_prefix(";WIDTH:"))
        {
            w = v.trim().parse().unwrap();
            continue;
        }
        let code = s.split(';').next().unwrap_or("").trim();
        if !["G0 ", "G1 ", "G2 ", "G3 "].iter().any(|p| code.starts_with(p)) {
            continue;
        }
        let (nx, ny) = (word(code, 'X').unwrap_or(x), word(code, 'Y').unwrap_or(y));
        if (nx, ny) != (x, y) {
            out.push(Move {
                feature: feature.clone(),
                before: before.clone(),
                z,
                from: (x, y),
                to: (nx, ny),
                extrudes: word(code, 'E').is_some_and(|e| e > 0.0),
                width: w,
            });
        }
        (x, y) = (nx, ny);
    }
    out
}

fn dist(a: P, b: P) -> f64 {
    (a.0 - b.0).hypot(a.1 - b.1)
}

/// The distance from `p` to the segment from `a` to `b`.
fn to_segment(p: P, a: P, b: P) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let l2 = dx * dx + dy * dy;
    let t = if l2 == 0.0 {
        0.0
    } else {
        (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / l2).clamp(0.0, 1.0)
    };
    dist(p, (a.0 + t * dx, a.1 + t * dy))
}

const TOP: &str = "Top surface";
const SURFACES: [&str; 3] = ["Top surface", "Bottom surface", "Internal solid infill"];
const GAP: &str = "Gap infill";

/// A run of gap fill moves: the feature printed before it, its points and the width of each move.
#[derive(Clone)]
struct Piece {
    before: String,
    points: Vec<P>,
    widths: Vec<f64>,
}

impl Piece {
    fn len(&self) -> f64 {
        self.points.windows(2).map(|w| dist(w[0], w[1])).sum()
    }
}

/// The gap fill pieces of the layer at `z`.
fn pieces(all: &[Move], z: f64) -> Vec<Piece> {
    let mut out: Vec<Piece> = Vec::new();
    let mut open = false;
    for m in all.iter().filter(|m| m.z == z) {
        if m.extrudes && m.feature == GAP {
            match out.last_mut().filter(|_| open) {
                Some(p) => {
                    p.points.push(m.to);
                    p.widths.push(m.width);
                }
                None => out.push(Piece {
                    before: m.before.clone(),
                    points: vec![m.from, m.to],
                    widths: vec![m.width],
                }),
            }
            open = true;
        } else {
            open = false;
        }
    }
    out
}

/// One tip as printed on one layer.
struct Tip {
    island: usize,
    angle: f64,
    /// The gap p, mm.
    p: f64,
    /// Where the wedge ends and where the lines end off both walls, mm along the bisector from the tip.
    wedge_end: f64,
    cut_ends: Vec<f64>,
    /// The tip's caps.
    caps: Vec<Piece>,
    /// Where Q is, mm along the bisector from the tip, and the line-end boundary's half width there.
    q: f64,
    /// The bisector's position u and offset v across it of a point, mm.
    frame: Frame,
    /// Where the line ends sit in from the walls, mm.
    ends_inset: f64,
}

#[derive(Clone, Copy)]
struct Frame {
    tip: P,
    along: P,
    half: f64,
}

impl Frame {
    /// The frame of a triangle with its tip first.
    fn of(poly: [P; 3]) -> Self {
        let tip = poly[0];
        let unit = |p: P| ((p.0 - tip.0) / dist(p, tip), (p.1 - tip.1) / dist(p, tip));
        let (u1, u2) = (unit(poly[1]), unit(poly[2]));
        let l = (u1.0 + u2.0).hypot(u1.1 + u2.1);
        Frame {
            tip,
            along: ((u1.0 + u2.0) / l, (u1.1 + u2.1) / l),
            half: (u1.0 * u2.0 + u1.1 * u2.1).acos() / 2.0,
        }
    }

    fn uv(self, p: P) -> P {
        let (dx, dy) = (p.0 - self.tip.0, p.1 - self.tip.1);
        (
            dx * self.along.0 + dy * self.along.1,
            -dx * self.along.1 + dy * self.along.0,
        )
    }

    /// How far a point is in from the nearer wall, mm.
    fn in_from_wall(self, p: P) -> f64 {
        let (u, v) = self.uv(p);
        let (s, c) = self.half.sin_cos();
        u * s - v.abs() * c
    }
}

/// Where the outer wall's centerline sits in from the model's edge on the stock A1, mm.
const OUTER: f64 = 0.21;
/// Where the surface lines end in from the model's edge with one wall, mm.
const LINE_ENDS: f64 = 0.417;

/// The plate offset of the printed part from its model: the outer wall's lowest and leftmost points against the
/// triangles' corners pulled in by the wall.
fn shift(layer: &[&Move], plate: &Plate) -> P {
    let walls: Vec<P> = layer
        .iter()
        .filter(|m| m.extrudes && m.feature == "Outer wall")
        .map(|m| m.to)
        .collect();
    let lo = walls
        .iter()
        .fold((f64::MAX, f64::MAX), |a, p| (a.0.min(p.0), a.1.min(p.1)));
    let mut want = (f64::MAX, f64::MAX);
    for t in &plate.tris {
        for i in 0..3 {
            let (a, b, c) = (t.poly[(i + 2) % 3], t.poly[i], t.poly[(i + 1) % 3]);
            // The corner b pulled in along its bisector so it is OUTER from both edges.
            let u1 = ((a.0 - b.0) / dist(a, b), (a.1 - b.1) / dist(a, b));
            let u2 = ((c.0 - b.0) / dist(c, b), (c.1 - b.1) / dist(c, b));
            let bis = (u1.0 + u2.0, u1.1 + u2.1);
            let l = bis.0.hypot(bis.1);
            let half = (u1.0 * u2.0 + u1.1 * u2.1).acos() / 2.0;
            let k = OUTER / half.sin();
            let p = (b.0 + bis.0 / l * k, b.1 + bis.1 / l * k);
            want = (want.0.min(p.0), want.1.min(p.1));
        }
    }
    (lo.0 - want.0, lo.1 - want.1)
}

/// The surface layer at `z` (the top when `None`) of a plate of triangles, one entry per triangle with a wedge.
fn tips(g: &str, plate: &Plate, z: Option<f64>) -> Vec<Tip> {
    let all = moves(g);
    let zt = z.unwrap_or_else(|| {
        all.iter()
            .filter(|m| m.extrudes && m.feature == TOP)
            .map(|m| m.z)
            .fold(f64::MIN, f64::max)
    });
    let layer: Vec<&Move> = all.iter().filter(|m| m.z == zt).collect();
    // Placed by the top layer's walls: the first layer's are pulled in against elephant foot.
    let top_z = all
        .iter()
        .filter(|m| m.extrudes && m.feature == TOP)
        .map(|m| m.z)
        .fold(f64::MIN, f64::max);
    let top: Vec<&Move> = all.iter().filter(|m| m.z == top_z).collect();
    let sh = shift(&top, plate);
    let gaps = pieces(&all, zt);
    let lines: Vec<&&Move> = layer
        .iter()
        .filter(|m| m.extrudes && SURFACES.contains(&m.feature.as_str()) && dist(m.from, m.to) > 0.05)
        .collect();
    let mut out = Vec::new();
    for t in &plate.tris {
        let poly = t.poly.map(|p| (p.0 + sh.0, p.1 + sh.1));
        let frame = Frame::of(poly);
        let wedge: Vec<&Piece> = gaps
            .iter()
            .filter(|pc| {
                pc.points.iter().all(|&q| {
                    let (u, v) = frame.uv(q);
                    v.abs() < 0.03 && u > 0.0 && u < 8.0
                }) && pc.widths.iter().copied().fold(0.0, f64::max) > 0.25
            })
            .collect();
        let Some(e) = wedge
            .iter()
            .flat_map(|pc| pc.points.iter().copied())
            .max_by(|a, b| frame.uv(*a).0.total_cmp(&frame.uv(*b).0))
        else {
            continue;
        };
        let wedge_end = frame.uv(e).0;
        let inside = |p: P| frame.in_from_wall(p) > -0.05 && frame.uv(p).0 < wedge_end + 3.0;
        let own: Vec<&&&Move> = lines.iter().filter(|m| inside(m.from) && inside(m.to)).collect();
        // Where the line ends sit in from the walls: most ends away from the tip are on a wall.
        let mut far: Vec<f64> = own
            .iter()
            .flat_map(|m| [m.from, m.to])
            .filter(|&end| frame.uv(end).0 > wedge_end + 0.5)
            .map(|end| frame.in_from_wall(end))
            .collect();
        far.sort_by(f64::total_cmp);
        let ends_inset = far.get(far.len() / 2).copied().unwrap_or(LINE_ENDS);
        let q = wedge_end + 0.207;
        let qp = (e.0 + 0.207 * frame.along.0, e.1 + 0.207 * frame.along.1);
        let p = own
            .iter()
            .map(|m| to_segment(qp, m.from, m.to) - m.width / 2.0)
            .fold(f64::MAX, f64::min);
        let cut_ends = own
            .iter()
            .flat_map(|m| [m.from, m.to])
            .filter(|&end| frame.in_from_wall(end) > ends_inset + 0.03 && frame.uv(end).0 < wedge_end + 1.0)
            .map(|end| frame.uv(end).0)
            .collect();
        let caps = gaps
            .iter()
            .filter(|pc| {
                !wedge.iter().any(|w| std::ptr::eq(*w, *pc)) && SURFACES.contains(&pc.before.as_str()) && {
                    let uv: Vec<P> = pc.points.iter().map(|&q| frame.uv(q)).collect();
                    uv.iter().any(|x| x.1 < -0.08)
                        && uv.iter().any(|x| x.1 > 0.08)
                        && uv.iter().any(|x| (x.0 - q).abs() < 0.6)
                }
            })
            .cloned()
            .collect();
        out.push(Tip {
            island: t.island,
            angle: t.angle,
            p,
            wedge_end,
            cut_ends,
            caps,
            q,
            frame,
            ends_inset,
        });
    }
    out
}

/// The gap p (mm) to the nearest line at each wedge tip of the sweeps the plates were cut from, by island: the
/// values the tip lines are held to.
const TIPS_P: [f64; 48] = [
    0.137, 0.107, 0.076, 0.045, 0.015, -0.015, -0.046, -0.076, -0.107, -0.138, 0.209, 0.178, 0.148, 0.117,
    0.087, 0.056, 0.026, -0.004, -0.036, -0.065, -0.096, -0.127, -0.158, 0.189, 0.016, -0.015, -0.046,
    -0.076, -0.106, -0.137, 0.209, 0.179, 0.149, 0.118, 0.088, 0.057, 0.027, -0.004, -0.034, -0.066, -0.096,
    -0.126, 0.221, 0.190, 0.159, 0.129, 0.099, 0.068,
];
const TIPSM_P: [f64; 48] = [
    -0.199, 0.128, 0.097, 0.067, 0.036, 0.005, -0.025, -0.056, -0.087, -0.117, -0.147, -0.178, -0.208, 0.139,
    0.108, 0.078, 0.047, 0.016, -0.015, -0.045, -0.075, -0.106, -0.137, -0.167, -0.060, -0.091, -0.121,
    -0.151, -0.182, -0.206, 0.134, 0.104, 0.074, 0.043, 0.011, -0.019, -0.049, -0.080, -0.111, -0.141,
    -0.172, -0.202, -0.183, 0.115, 0.084, 0.053, 0.023, -0.008,
];

/// The islands whose short tip line, 0.53 to 0.79 mm long between a wall and the cut, covers Q.
const SHORT_TIP_LINES: [(&str, usize); 18] = [
    ("tips", 8),
    ("tips", 9),
    ("tips", 21),
    ("tips", 22),
    ("tips", 28),
    ("tips", 29),
    ("tips", 40),
    ("tips", 41),
    ("tipsm", 0),
    ("tipsm", 10),
    ("tipsm", 11),
    ("tipsm", 12),
    ("tipsm", 23),
    ("tipsm", 28),
    ("tipsm", 29),
    ("tipsm", 40),
    ("tipsm", 41),
    ("tipsm", 42),
];

/// The capped tips, by island, and the caps' total length on each angle (mm).
const TIPS_CAPS: [usize; 10] = [0, 10, 11, 12, 23, 30, 31, 32, 43, 44];
const TIPSM_CAPS: [usize; 3] = [1, 13, 30];
const CAP_TOTALS: [(&str, f64, f64); 4] = [
    ("tips", 16.7, 3.43),
    ("tips", 20.0, 3.52),
    ("tipsm", 16.7, 1.27),
    ("tipsm", 20.0, 0.64),
];
/// A tip whose next line toward the tip has, by 0.001 mm, the room a line needs from the walls (0.168 against 0.167
/// mm from the cut and both sides), so it prints a line where a cap 0.221 mm from the last line would otherwise go.
const EXTRA_LINE: (&str, usize) = ("tips", 42);
/// Tips left out of the match: no cap at p 0.129 (tips 45), the tips with p from 0.105 to 0.122, and [`EXTRA_LINE`].
/// The totals leave out the same tips.
const UNMATCHED: [(&str, usize); 8] = [
    ("tips", 42),
    ("tips", 45),
    ("tips", 1),
    ("tips", 13),
    ("tips", 33),
    ("tipsm", 14),
    ("tipsm", 31),
    ("tipsm", 43),
];

/// The `tipsm` tips at 50 and 70 degrees whose slivers along the wall near the lines reach within 2 mm of the tip, and
/// how many beads do.
const TIPSM_WIDE_SLIVERS: [(usize, usize); 15] = [
    (96, 1),
    (102, 1),
    (103, 1),
    (104, 1),
    (105, 1),
    (106, 1),
    (107, 1),
    (108, 1),
    (115, 1),
    (116, 1),
    (117, 1),
    (118, 1),
    (119, 1),
    (145, 1),
    (157, 1),
];

fn wanted_p(name: &str, island: usize) -> f64 {
    if name == "tips" {
        TIPS_P[island]
    } else {
        TIPSM_P[island]
    }
}

/// The G-code of each plate, sliced once for every test.
fn sweep_gcode() -> &'static [(&'static str, String)] {
    static G: std::sync::OnceLock<Vec<(&'static str, String)>> = std::sync::OnceLock::new();
    G.get_or_init(|| {
        ["tips", "tipsm"]
            .into_iter()
            .map(|name| (name, slice(&plate(name).stl, a1(&[]))))
            .collect()
    })
}

/// Each plate's top with its wedge tips.
fn sweep() -> Vec<(&'static str, Plate, Vec<Tip>)> {
    sweep_gcode()
        .iter()
        .map(|(name, g)| {
            let p = plate(name);
            let t = tips(g, &p, None);
            (*name, p, t)
        })
        .collect()
}

/// What breaks the presence rule at one tip, if anything.
fn presence(tag: &str, t: &Tip) -> Option<String> {
    let n = t.caps.len();
    if t.p >= 0.123 && n != 1 {
        Some(format!("{tag} (p {:.3}): {n} caps, want one", t.p))
    } else if t.p <= 0.104 && n != 0 {
        Some(format!("{tag} (p {:.3}): {n} caps, want none", t.p))
    } else {
        None
    }
}

/// What breaks the cap's shape at one tip.
fn shape(tag: &str, t: &Tip, tol_w: f64) -> Vec<String> {
    let mut out = Vec::new();
    let Some(cap) = t.caps.first() else {
        return out;
    };
    let uv: Vec<P> = cap.points.iter().map(|&q| t.frame.uv(q)).collect();
    // The move across the bisector, within 7 degrees of square to it.
    let crossing = uv.windows(2).find(|w| (w[0].1 < 0.0) != (w[1].1 < 0.0)).map(|w| {
        ((w[1].0 - w[0].0).abs())
            .atan2((w[1].1 - w[0].1).abs())
            .to_degrees()
    });
    match crossing {
        Some(a) if a <= 7.0 => {}
        other => out.push(format!("{tag}: crossing move {other:?} degrees from square")),
    }
    let w = cap.widths.iter().copied().fold(0.0, f64::max);
    let near = uv.iter().map(|x| x.0).fold(f64::MAX, f64::min) - w / 2.0;
    if (near - t.q).abs() > 0.03 {
        out.push(format!("{tag}: near side {:.3} from the cut", near - t.q));
    }
    for end in [cap.points[0], *cap.points.last().unwrap()] {
        let off = t.frame.in_from_wall(end) - t.ends_inset;
        if off.abs() > 0.04 {
            out.push(format!("{tag}: end {off:.3} from the line-end boundary"));
        }
    }
    let lo = uv.iter().map(|x| x.1).fold(f64::MAX, f64::min);
    let hi = uv.iter().map(|x| x.1).fold(f64::MIN, f64::max);
    let half = t.q * t.frame.half.tan() - t.ends_inset / t.frame.half.cos();
    if lo > -half + 0.04 || hi < half - 0.04 {
        out.push(format!("{tag}: spans {lo:.3} to {hi:.3}, boundary +-{half:.3}"));
    }
    if (w - (t.p - 0.021)).abs() > tol_w {
        out.push(format!(
            "{tag} (p {:.3}): width {w:.3}, want {:.3}",
            t.p,
            t.p - 0.021
        ));
    }
    if !SURFACES.contains(&cap.before.as_str()) {
        out.push(format!("{tag}: printed after {}", cap.before));
    }
    out
}

#[test]
fn tip_lines_end_at_the_cut() {
    for (name, _, tips) in sweep() {
        let mut ends = 0;
        let mut wrong = Vec::new();
        for t in tips.iter().filter(|t| t.angle < 25.0) {
            for &u in &t.cut_ends {
                ends += 1;
                let off = u - t.wedge_end;
                if (off - 0.207).abs() > 0.005 {
                    wrong.push(format!("{name} {}: ends {off:.3} past the wedge", t.island));
                }
            }
        }
        assert!(ends >= 5, "{name}: {ends} line ends at the cut");
        assert!(wrong.is_empty(), "{} of {ends}: {wrong:?}", wrong.len());
    }
}

#[test]
fn short_tip_lines_are_kept() {
    let mut wrong = Vec::new();
    for (name, _, tips) in sweep() {
        for t in &tips {
            let want = wanted_p(name, t.island);
            let short = SHORT_TIP_LINES.contains(&(name, t.island));
            if (name, t.island) == EXTRA_LINE {
                continue;
            }
            if (short && t.p >= 0.0) || (t.p - want).abs() > 0.01 {
                wrong.push(format!("{name} {}: p {:.3}, want {want:.3}", t.island, t.p));
            }
        }
    }
    assert!(wrong.is_empty(), "{} tips: {wrong:?}", wrong.len());
}

#[test]
fn wedge_tips_get_a_cap_by_the_gap() {
    let mut wrong = Vec::new();
    let mut capped = 0;
    for (name, _, tips) in sweep() {
        assert_eq!(tips.len(), 48, "{name}: wedge tips");
        for t in &tips {
            capped += t.caps.len();
            wrong.extend(presence(&format!("{name} {}", t.island), t));
        }
    }
    assert!(capped >= 10, "{capped} caps");
    assert!(wrong.is_empty(), "{} tips: {wrong:?}", wrong.len());
}

#[test]
fn a_cap_crosses_the_bisector_at_the_cut() {
    let mut wrong = Vec::new();
    for (name, _, tips) in sweep() {
        for t in &tips {
            wrong.extend(shape(&format!("{name} {}", t.island), t, 0.015));
        }
    }
    assert!(wrong.is_empty(), "{} problems: {wrong:?}", wrong.len());
}

#[test]
fn the_capped_tips_and_totals_hold() {
    for (name, _, tips) in sweep() {
        let want: &[usize] = if name == "tips" { &TIPS_CAPS } else { &TIPSM_CAPS };
        let matched = |t: &&Tip| !UNMATCHED.contains(&(name, t.island));
        let got: Vec<usize> = tips
            .iter()
            .filter(matched)
            .filter(|t| !t.caps.is_empty())
            .map(|t| t.island)
            .collect();
        assert_eq!(got, want, "{name}: capped tips");
        for &(n, angle, total) in CAP_TOTALS.iter().filter(|c| c.0 == name) {
            let sum: f64 = tips
                .iter()
                .filter(matched)
                .filter(|t| t.angle == angle)
                .flat_map(|t| t.caps.iter().map(Piece::len))
                .sum();
            assert!(
                (sum - total).abs() <= 0.15,
                "{n} {angle}: {sum:.2} mm of caps, want {total:.2}"
            );
        }
    }
}

#[test]
fn wide_tips_get_no_cap() {
    // At 50 and 70 degrees there is no wedge, so nothing sets the cut and nothing caps the tip. The gap fill there is
    // the surface's own slivers: one bead at one wide tip of `tips`, and on `tipsm`, where one wall runs near the
    // lines, the slivers along that wall.
    let mut got = Vec::new();
    let mut wanted = Vec::new();
    for (name, g) in sweep_gcode() {
        let plate = plate(name);
        let all = moves(g);
        let zt = all
            .iter()
            .filter(|m| m.extrudes && m.feature == TOP)
            .map(|m| m.z)
            .fold(f64::MIN, f64::max);
        let layer: Vec<&Move> = all.iter().filter(|m| m.z == zt).collect();
        let sh = shift(&layer, &plate);
        let gaps = pieces(&all, zt);
        let mut found = Vec::new();
        for t in plate.tris.iter().filter(|t| t.angle > 45.0) {
            let tip = (t.poly[0].0 + sh.0, t.poly[0].1 + sh.1);
            let n = gaps
                .iter()
                .filter(|pc| pc.points.iter().any(|&q| dist(q, tip) < 2.0))
                .count();
            if n > 0 {
                found.push((t.island, n));
            }
        }
        let want: &[(usize, usize)] = if *name == "tips" {
            &[(100, 1)]
        } else {
            &TIPSM_WIDE_SLIVERS
        };
        got.push((*name, found));
        wanted.push((*name, want.to_vec()));
    }
    assert_eq!(got, wanted, "gap fill at the wide tips");
}

/// The surface gap fill of each layer: gap fill printed right after a surface, mm of path by layer z.
fn surface_gap_by_z(g: &str) -> Vec<(f64, f64)> {
    let mut out: Vec<(f64, f64)> = Vec::new();
    for m in moves(g)
        .iter()
        .filter(|m| m.extrudes && m.feature == GAP && SURFACES.contains(&m.before.as_str()))
    {
        match out.last_mut() {
            Some(l) if l.0 == m.z => l.1 += dist(m.from, m.to),
            _ => out.push((m.z, dist(m.from, m.to))),
        }
    }
    out
}

/// A triangle case: its name, its setting edits, its capped layers with their surface gap fill (z, mm), and whether
/// its whole plate's surface gap fill is held to their sum.
type KitCase = (&'static str, Vec<(&'static str, Value)>, Vec<(f64, f64)>, bool);

#[test]
fn the_kit_triangle_gets_its_caps() {
    let p = plate("tri");
    let mono = json!("monotonicline");
    // Each case's layers with a cap and their surface gap fill, mm. The internal solid layers under the internal solid
    // monotonic line case are left out: their lines sit elsewhere, so only its top is held.
    let cases: [KitCase; 4] = [
        ("base", vec![], vec![(3.0, 0.65)], true),
        (
            "bottom",
            vec![("bottom_surface_pattern", mono.clone())],
            vec![(3.0, 0.65)],
            true,
        ),
        (
            "raft",
            vec![
                ("raft_layers", json!(2)),
                ("bottom_surface_pattern", mono.clone()),
            ],
            vec![(0.8, 0.70), (3.6, 0.65)],
            true,
        ),
        (
            "internal",
            vec![("internal_solid_infill_pattern", mono)],
            vec![(3.0, 0.65)],
            false,
        ),
    ];
    for (name, edits, want, every) in cases {
        let g = slice(&p.stl, a1(&edits));
        let got = surface_gap_by_z(&g);
        for &(z, mm) in &want {
            let have = got.iter().find(|l| (l.0 - z).abs() < 1e-6).map_or(0.0, |l| l.1);
            assert!(
                (have - mm).abs() <= 0.3_f64.max(0.25 * mm),
                "{name} z {z}: {have:.2} mm, want {mm:.2} ({got:?})"
            );
            let tips = tips(&g, &p, Some(z));
            assert_eq!(tips.len(), 1, "{name} z {z}: wedge tips");
            let t = &tips[0];
            assert_eq!(presence(&format!("{name} z {z}"), t), None);
            let tol = if z < 1.0 { 0.025 } else { 0.015 };
            let wrong = shape(&format!("{name} z {z}"), t, tol);
            assert!(wrong.is_empty(), "{wrong:?}");
        }
        if every {
            let total: f64 = got.iter().map(|l| l.1).sum();
            let want_total: f64 = want.iter().map(|l| l.1).sum();
            assert!(
                (total - want_total).abs() <= 0.3_f64.max(0.25 * want_total),
                "{name}: {total:.2} mm in all, want {want_total:.2} ({got:?})"
            );
        }
    }
}

/// The extruded lines of the top at `z`, in print order, as (start, end): consecutive moves along one straight line,
/// heading the same way, join into one.
fn top_lines(g: &str, z: f64) -> Vec<(P, P)> {
    let mut out: Vec<(P, P)> = Vec::new();
    let mut joined = false;
    for m in moves(g) {
        if !(m.extrudes && m.feature == TOP && (m.z - z).abs() < 1e-6) {
            joined = false;
            continue;
        }
        if joined && let Some(last) = out.last_mut() {
            let (a, b) = *last;
            let cross = (b.0 - a.0) * (m.to.1 - m.from.1) - (b.1 - a.1) * (m.to.0 - m.from.0);
            let dot = (b.0 - a.0) * (m.to.0 - m.from.0) + (b.1 - a.1) * (m.to.1 - m.from.1);
            if b == m.from && cross.abs() < 1e-6 && dot > 0.0 {
                last.1 = m.to;
                continue;
            }
        }
        out.push((m.from, m.to));
        joined = true;
    }
    out
}

#[test]
fn the_shelf_keeps_its_line_directions() {
    // The kit's triangle as a shelf on a column: its top at z 8.0 has one wedge tip, at the plate's +x end. The short
    // line there prints, and keeping it does not turn the top's other lines round: they alternate as before, and the
    // first of them starts on the triangle's long straight edge (the lowest y), heading across it. The short line
    // prints just before that line and ends beside its start, so the zigzag runs on through it.
    let g = slice(
        &std::fs::read(format!(
            "{}/packages/core/tests/fixtures/gap-fill/shelf.stl",
            root()
        ))
        .unwrap(),
        a1(&[]),
    );
    let lines = top_lines(&g, 8.0);
    assert!(lines.len() >= 60, "{} top lines at z 8.0", lines.len());
    let len = |l: &(P, P)| dist(l.0, l.1);
    let x_max = lines.iter().map(|l| l.0.0.max(l.1.0)).fold(f64::MIN, f64::max);
    let tip = lines
        .iter()
        .position(|l| len(l) < 1.0 && l.0.0.max(l.1.0) > x_max - 0.01)
        .unwrap_or_else(|| {
            panic!(
                "no short line at the tip (x {x_max:.3}): {:?}",
                &lines[..3.min(lines.len())]
            )
        });
    let short = len(&lines[tip]);
    assert!((0.55..=0.75).contains(&short), "tip line {short:.3} mm");
    let rest: Vec<(P, P)> = lines
        .iter()
        .enumerate()
        .filter(|&(i, _)| i != tip)
        .map(|(_, l)| *l)
        .collect();
    let y_min = rest.iter().map(|l| l.0.1.min(l.1.1)).fold(f64::MAX, f64::min);
    let first = rest[0];
    assert!(
        (first.0.1 - y_min).abs() < 0.05 && first.1.1 > first.0.1,
        "first line {first:?} does not start on the long edge (y {y_min:.3})"
    );
    let along = |l: &(P, P)| (l.1.0 - l.0.0, l.1.1 - l.0.1);
    let turned: Vec<usize> = rest
        .windows(2)
        .enumerate()
        .filter(|(_, w)| {
            let (a, b) = (along(&w[0]), along(&w[1]));
            a.0 * b.0 + a.1 * b.1 > 0.0
        })
        .map(|(i, _)| i + 1)
        .collect();
    assert!(
        turned.is_empty(),
        "lines {turned:?} print the same way as the one before"
    );
    assert_eq!(tip, 0, "the tip line prints first");
    let gap = dist(lines[0].1, first.0);
    assert!(
        gap < 0.6,
        "the tip line ends {gap:.3} mm from the next line's start"
    );
}

/// The triangles that gain a tip line: the short tip lines over Q that no line covered before the cut, and
/// [`EXTRA_LINE`].
const NEW_TIP_LINES: [(&str, usize); 14] = [
    ("tips", 9),
    ("tips", 21),
    ("tips", 22),
    ("tips", 29),
    ("tips", 41),
    ("tips", 42),
    ("tipsm", 0),
    ("tipsm", 11),
    ("tipsm", 12),
    ("tipsm", 23),
    ("tipsm", 28),
    ("tipsm", 29),
    ("tipsm", 41),
    ("tipsm", 42),
];

#[test]
fn tip_lines_leave_the_chain_alone() {
    // Each triangle's top starts on its lowest line, heading the way the lines run, and the rest follow in turn. A
    // kept tip line goes in beside that chain and leaves it as it is: on the triangles that keep one, the first line
    // printed other than the tip line still heads the way every other triangle's first line does.
    let mut wrong = Vec::new();
    for (name, g) in sweep_gcode() {
        let name: &str = name;
        let plate = plate(name);
        let all = moves(g);
        let zt = all
            .iter()
            .filter(|m| m.extrudes && m.feature == TOP)
            .map(|m| m.z)
            .fold(f64::MIN, f64::max);
        let layer: Vec<&Move> = all.iter().filter(|m| m.z == zt).collect();
        let sh = shift(&layer, &plate);
        let inside = |p: P, t: &Tri| {
            let side = |a: P, b: P| (b.0 - a.0) * (p.1 - a.1) - (b.1 - a.1) * (p.0 - a.0);
            let s = [0, 1, 2].map(|i| side(t.poly[i], t.poly[(i + 1) % 3]));
            s.iter().all(|&v| v >= -0.3) || s.iter().all(|&v| v <= 0.3)
        };
        let lines = top_lines(g, zt);
        let mid = |l: &(P, P)| (f64::midpoint(l.0.0, l.1.0), f64::midpoint(l.0.1, l.1.1));
        let head = |l: &(P, P)| (l.1.0 > l.0.0, l.1.1 > l.0.1);
        let mut want = None;
        let mut firsts = Vec::new();
        for t in &plate.tris {
            let mut own: Vec<(P, P)> = lines
                .iter()
                .filter(|l| inside((mid(l).0 - sh.0, mid(l).1 - sh.1), t))
                .copied()
                .collect();
            let keeps = NEW_TIP_LINES.contains(&(name, t.island));
            if keeps && own.len() > 1 {
                let tip = (t.poly[0].0 + sh.0, t.poly[0].1 + sh.1);
                let nearest = (0..own.len())
                    .min_by(|&a, &b| dist(mid(&own[a]), tip).total_cmp(&dist(mid(&own[b]), tip)))
                    .unwrap();
                own.remove(nearest);
            }
            let Some(first) = own.first() else { continue };
            if !keeps && want.is_none() {
                want = Some(head(first));
            }
            firsts.push((t.island, keeps, head(first)));
        }
        let want = want.unwrap();
        wrong.extend(
            firsts
                .iter()
                .filter(|f| f.2 != want)
                .map(|f| format!("{name} {}{}", f.0, if f.1 { " (tip line)" } else { "" })),
        );
    }
    assert!(
        wrong.is_empty(),
        "{} triangles start the other way: {wrong:?}",
        wrong.len()
    );
}

#[test]
fn no_top_line_prints_twice() {
    // A kept tip line prints once: no two lines of either plate's top have the same two ends.
    let mut twice = Vec::new();
    for (name, g) in sweep_gcode() {
        let all = moves(g);
        let zt = all
            .iter()
            .filter(|m| m.extrudes && m.feature == TOP)
            .map(|m| m.z)
            .fold(f64::MIN, f64::max);
        let lines = top_lines(g, zt);
        for (i, a) in lines.iter().enumerate() {
            for b in &lines[i + 1..] {
                let same = |p: P, q: P| dist(p, q) < 0.01;
                if (same(a.0, b.0) && same(a.1, b.1)) || (same(a.0, b.1) && same(a.1, b.0)) {
                    twice.push(format!("{name} {a:?}"));
                }
            }
        }
    }
    assert!(twice.is_empty(), "{} lines print twice: {twice:?}", twice.len());
}
