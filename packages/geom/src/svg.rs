// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `extrude.svg`
// path data is scanned by byte index within its own length
#![allow(
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::too_many_lines,
    clippy::collapsible_if,
    clippy::format_push_string
)]

use crate::build;
use crate::error::{Error, Result};
use crate::fm::Fm;
use crate::import::container::{Ev, attr, events};
use crate::import::{build_palette, hex};
use crate::mesh::TriMesh;
use crate::poly2d::{self, Polygon};
use crate::vec3::{Frame, V2};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::float::simplify::SimplifyShape;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::rc::Rc;

type Mat = [f64; 6];
type Rgb = [u8; 3];
type Region = Vec<Vec<V2>>;

const IDENTITY: Mat = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
const PX_MM: f64 = 25.4 / 96.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SvgOptions {
    pub height_mm: f64,
    pub base_mm: f64,
    pub base_margin_mm: f64,
    pub base_color: Option<String>,
    pub tolerance_mm: f64,
    pub scale: Option<f64>,
    pub fit_width_mm: Option<f64>,
    pub fit_height_mm: Option<f64>,
    pub default_color: String,
    pub max_colors: usize,
}

impl Default for SvgOptions {
    fn default() -> Self {
        Self {
            height_mm: 2.0,
            base_mm: 0.0,
            base_margin_mm: 2.0,
            base_color: None,
            tolerance_mm: 0.02,
            scale: None,
            fit_width_mm: None,
            fit_height_mm: None,
            default_color: "#000000".to_owned(),
            max_colors: 16,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SvgPart {
    pub name: String,
    pub color: String,
    pub slot: u8,
    pub mesh: TriMesh,
    pub area_mm2: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SvgModel {
    pub parts: Vec<SvgPart>,
    pub slot_colors: Vec<String>,
    pub size_mm: [f64; 3],
    pub mm_per_unit: f64,
    pub warnings: Vec<String>,
}

fn mul(a: &Mat, b: &Mat) -> Mat {
    [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ]
}

fn apply(m: &Mat, p: V2) -> V2 {
    [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]
}

fn parse_transform(s: &str) -> Mat {
    let mut m = IDENTITY;
    let mut rest = s;
    while let Some(open) = rest.find('(') {
        let name = rest[..open].trim().trim_start_matches(',').trim();
        let Some(close) = rest[open..].find(')') else {
            break;
        };
        let args: Vec<f64> = rest[open + 1..open + close]
            .split(|c: char| c == ',' || c.is_whitespace())
            .filter(|t| !t.is_empty())
            .filter_map(|t| t.parse().ok())
            .collect();
        rest = &rest[open + close + 1..];
        let t: Option<Mat> = match (name, args.as_slice()) {
            ("matrix", [a, b, c, d, e, f]) => Some([*a, *b, *c, *d, *e, *f]),
            ("translate", [x]) => Some([1.0, 0.0, 0.0, 1.0, *x, 0.0]),
            ("translate", [x, y]) => Some([1.0, 0.0, 0.0, 1.0, *x, *y]),
            ("scale", [x]) => Some([*x, 0.0, 0.0, *x, 0.0, 0.0]),
            ("scale", [x, y]) => Some([*x, 0.0, 0.0, *y, 0.0, 0.0]),
            ("rotate", [a]) => {
                let (s, c) = a.to_radians().m_sin_cos();
                Some([c, s, -s, c, 0.0, 0.0])
            }
            ("rotate", [a, cx, cy]) => {
                let (s, c) = a.to_radians().m_sin_cos();
                let r = [c, s, -s, c, 0.0, 0.0];
                let there = [1.0, 0.0, 0.0, 1.0, *cx, *cy];
                let back = [1.0, 0.0, 0.0, 1.0, -*cx, -*cy];
                Some(mul(&mul(&there, &r), &back))
            }
            ("skewX", [a]) => Some([1.0, 0.0, a.to_radians().m_tan(), 1.0, 0.0, 0.0]),
            ("skewY", [a]) => Some([1.0, a.to_radians().m_tan(), 0.0, 1.0, 0.0, 0.0]),
            _ => None,
        };
        if let Some(t) = t {
            m = mul(&m, &t);
        }
    }
    m
}

fn named_color(name: &str) -> Option<Rgb> {
    Some(match name {
        "black" => [0, 0, 0],
        "white" => [255, 255, 255],
        "red" => [255, 0, 0],
        "green" => [0, 128, 0],
        "lime" => [0, 255, 0],
        "blue" => [0, 0, 255],
        "yellow" => [255, 255, 0],
        "cyan" | "aqua" => [0, 255, 255],
        "magenta" | "fuchsia" => [255, 0, 255],
        "gray" | "grey" => [128, 128, 128],
        "silver" => [192, 192, 192],
        "maroon" => [128, 0, 0],
        "olive" => [128, 128, 0],
        "navy" => [0, 0, 128],
        "purple" => [128, 0, 128],
        "teal" => [0, 128, 128],
        "orange" => [255, 165, 0],
        "pink" => [255, 192, 203],
        "brown" => [165, 42, 42],
        _ => return None,
    })
}

fn parse_color(s: &str) -> Option<Rgb> {
    let s = s.trim().to_ascii_lowercase();
    if let Some(hex) = s.strip_prefix('#') {
        let d = |i: usize, n: usize| u8::from_str_radix(hex.get(i..i + n)?, 16).ok();
        return match hex.len() {
            3 => Some([d(0, 1)? * 17, d(1, 1)? * 17, d(2, 1)? * 17]),
            6 => Some([d(0, 2)?, d(2, 2)?, d(4, 2)?]),
            _ => None,
        };
    }
    if let Some(body) = s.strip_prefix("rgb(").and_then(|b| b.strip_suffix(')')) {
        let v: Vec<f64> = body
            .split(|c: char| c == ',' || c == '/' || c.is_whitespace())
            .filter(|t| !t.is_empty())
            .take(3)
            .map(|t| match t.strip_suffix('%') {
                Some(p) => p.parse::<f64>().ok().map(|x| x * 2.55),
                None => t.parse::<f64>().ok(),
            })
            .collect::<Option<_>>()?;
        if let [r, g, b] = v.as_slice() {
            let byte = |x: f64| x.round().clamp(0.0, 255.0) as u8;
            return Some([byte(*r), byte(*g), byte(*b)]);
        }
        return None;
    }
    named_color(&s)
}

fn style_prop<'a>(attrs: &'a str, key: &str) -> Option<&'a str> {
    let style = attr(attrs, "style")?;
    style.split(';').find_map(|decl| {
        let (k, v) = decl.split_once(':')?;
        (k.trim() == key).then_some(v.trim())
    })
}

fn prop<'a>(attrs: &'a str, key: &str) -> Option<&'a str> {
    style_prop(attrs, key).or_else(|| attr(attrs, key))
}

struct Scanner<'a> {
    b: &'a [u8],
    i: usize,
}

impl Scanner<'_> {
    fn skip(&mut self) {
        while self.i < self.b.len() && (self.b[self.i].is_ascii_whitespace() || self.b[self.i] == b',') {
            self.i += 1;
        }
    }

    fn peek_number(&mut self) -> bool {
        self.skip();
        self.b
            .get(self.i)
            .is_some_and(|c| c.is_ascii_digit() || matches!(c, b'-' | b'+' | b'.'))
    }

    fn number(&mut self) -> Option<f64> {
        self.skip();
        let start = self.i;
        let at = |s: &Self| s.b.get(s.i).copied();
        if matches!(at(self), Some(b'-' | b'+')) {
            self.i += 1;
        }
        while at(self).is_some_and(|c| c.is_ascii_digit()) {
            self.i += 1;
        }
        if at(self) == Some(b'.') {
            self.i += 1;
            while at(self).is_some_and(|c| c.is_ascii_digit()) {
                self.i += 1;
            }
        }
        if matches!(at(self), Some(b'e' | b'E')) {
            let save = self.i;
            self.i += 1;
            if matches!(at(self), Some(b'-' | b'+')) {
                self.i += 1;
            }
            if at(self).is_some_and(|c| c.is_ascii_digit()) {
                while at(self).is_some_and(|c| c.is_ascii_digit()) {
                    self.i += 1;
                }
            } else {
                self.i = save;
            }
        }
        std::str::from_utf8(&self.b[start..self.i]).ok()?.parse().ok()
    }

    fn flag(&mut self) -> Option<bool> {
        self.skip();
        let c = self.b.get(self.i).copied()?;
        self.i += 1;
        match c {
            b'0' => Some(false),
            b'1' => Some(true),
            _ => None,
        }
    }
}

fn dist(a: V2, b: V2) -> f64 {
    (a[0] - b[0]).m_hypot(a[1] - b[1])
}

fn lerp(a: V2, b: V2, t: f64) -> V2 {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

fn flatten_cubic(p: [V2; 4], tol: f64, out: &mut Vec<V2>) {
    let d1 = dist(lerp(p[0], p[2], 0.5), p[1]) * 2.0;
    let d2 = dist(lerp(p[1], p[3], 0.5), p[2]) * 2.0;
    let dd = d1.max(d2);
    let n = ((0.75 * dd / tol.max(1e-9)).sqrt().ceil() as usize).clamp(1, 512);
    for k in 1..=n {
        let t = k as f64 / n as f64;
        let (a, b, c) = (lerp(p[0], p[1], t), lerp(p[1], p[2], t), lerp(p[2], p[3], t));
        let (d, e) = (lerp(a, b, t), lerp(b, c, t));
        out.push(lerp(d, e, t));
    }
}

fn vec_angle(u: V2, v: V2) -> f64 {
    (u[0] * v[1] - u[1] * v[0]).m_atan2(u[0] * v[0] + u[1] * v[1])
}

fn arc_to_cubics(p0: V2, rx: f64, ry: f64, phi_deg: f64, large: bool, sweep: bool, p1: V2) -> Vec<[V2; 3]> {
    if dist(p0, p1) < 1e-12 {
        return Vec::new();
    }
    let (mut rx, mut ry) = (rx.abs(), ry.abs());
    if rx < 1e-12 || ry < 1e-12 {
        return vec![[p0, p1, p1]];
    }
    let (sin, cos) = phi_deg.to_radians().m_sin_cos();
    let (dx, dy) = ((p0[0] - p1[0]) / 2.0, (p0[1] - p1[1]) / 2.0);
    let (x1p, y1p) = (cos * dx + sin * dy, -sin * dx + cos * dy);
    let lambda = (x1p / rx).m_powi(2) + (y1p / ry).m_powi(2);
    if lambda > 1.0 {
        let s = lambda.sqrt();
        rx *= s;
        ry *= s;
    }
    let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let coef = if den > 0.0 {
        (num / den).max(0.0).sqrt()
    } else {
        0.0
    } * if large == sweep { -1.0 } else { 1.0 };
    let (cxp, cyp) = (coef * rx * y1p / ry, -coef * ry * x1p / rx);
    let c = [
        cos * cxp - sin * cyp + f64::midpoint(p0[0], p1[0]),
        sin * cxp + cos * cyp + f64::midpoint(p0[1], p1[1]),
    ];
    let u = [(x1p - cxp) / rx, (y1p - cyp) / ry];
    let v = [(-x1p - cxp) / rx, (-y1p - cyp) / ry];
    let theta = vec_angle([1.0, 0.0], u);
    let mut delta = vec_angle(u, v);
    if !sweep && delta > 0.0 {
        delta -= std::f64::consts::TAU;
    } else if sweep && delta < 0.0 {
        delta += std::f64::consts::TAU;
    }
    let n = ((delta.abs() / std::f64::consts::FRAC_PI_2).ceil() as usize).max(1);
    let step = delta / n as f64;
    let k = 4.0 / 3.0 * (step / 4.0).m_tan();
    let map = |x: f64, y: f64| {
        [
            c[0] + cos * rx * x - sin * ry * y,
            c[1] + sin * rx * x + cos * ry * y,
        ]
    };
    (0..n)
        .map(|i| {
            let (a1, a2) = (theta + step * i as f64, theta + step * (i + 1) as f64);
            let (s1, c1) = a1.m_sin_cos();
            let (s2, c2) = a2.m_sin_cos();
            [
                map(c1 - k * s1, s1 + k * c1),
                map(c2 + k * s2, s2 - k * c2),
                map(c2, s2),
            ]
        })
        .collect()
}

fn flatten_path(d: &str, m: &Mat, tol: f64) -> (Vec<Vec<V2>>, bool) {
    let mut sc = Scanner {
        b: d.as_bytes(),
        i: 0,
    };
    let mut rings: Vec<Vec<V2>> = Vec::new();
    let mut ring: Vec<V2> = Vec::new();
    let (mut cur, mut start) = ([0.0, 0.0], [0.0, 0.0]);
    let (mut c_ctrl, mut q_ctrl): (Option<V2>, Option<V2>) = (None, None);
    let mut cmd = b' ';
    let mut ok = true;
    let finish = |ring: &mut Vec<V2>, rings: &mut Vec<Vec<V2>>| {
        if ring.len() >= 3 {
            rings.push(std::mem::take(ring));
        } else {
            ring.clear();
        }
    };
    macro_rules! num {
        () => {
            match sc.number() {
                Some(v) => v,
                None => {
                    ok = false;
                    break;
                }
            }
        };
    }
    loop {
        sc.skip();
        let Some(&c) = sc.b.get(sc.i) else { break };
        if c.is_ascii_alphabetic() {
            cmd = c;
            sc.i += 1;
        } else if !sc.peek_number() || cmd == b' ' || matches!(cmd, b'z' | b'Z') {
            ok = false;
            break;
        } else if cmd == b'M' {
            cmd = b'L';
        } else if cmd == b'm' {
            cmd = b'l';
        }
        let rel = cmd.is_ascii_lowercase();
        let base = if rel { cur } else { [0.0, 0.0] };
        match cmd.to_ascii_uppercase() {
            b'M' => {
                finish(&mut ring, &mut rings);
                let (x, y) = (num!(), num!());
                cur = [base[0] + x, base[1] + y];
                start = cur;
                ring.push(apply(m, cur));
                (c_ctrl, q_ctrl) = (None, None);
                cmd = if rel { b'l' } else { b'L' };
            }
            b'L' | b'H' | b'V' => {
                let up = cmd.to_ascii_uppercase();
                let next = match up {
                    b'L' => {
                        let (x, y) = (num!(), num!());
                        [base[0] + x, base[1] + y]
                    }
                    b'H' => [if rel { cur[0] } else { 0.0 } + num!(), cur[1]],
                    _ => [cur[0], if rel { cur[1] } else { 0.0 } + num!()],
                };
                cur = next;
                ring.push(apply(m, cur));
                (c_ctrl, q_ctrl) = (None, None);
            }
            b'C' | b'S' | b'Q' | b'T' => {
                let up = cmd.to_ascii_uppercase();
                let (c1, c2, end): (V2, V2, V2);
                match up {
                    b'C' => {
                        let v = [num!(), num!(), num!(), num!(), num!(), num!()];
                        c1 = [base[0] + v[0], base[1] + v[1]];
                        c2 = [base[0] + v[2], base[1] + v[3]];
                        end = [base[0] + v[4], base[1] + v[5]];
                        c_ctrl = Some(c2);
                        q_ctrl = None;
                    }
                    b'S' => {
                        let v = [num!(), num!(), num!(), num!()];
                        c1 = c_ctrl.map_or(cur, |p| [2.0 * cur[0] - p[0], 2.0 * cur[1] - p[1]]);
                        c2 = [base[0] + v[0], base[1] + v[1]];
                        end = [base[0] + v[2], base[1] + v[3]];
                        c_ctrl = Some(c2);
                        q_ctrl = None;
                    }
                    _ => {
                        let q = if up == b'Q' {
                            let v = [num!(), num!()];
                            [base[0] + v[0], base[1] + v[1]]
                        } else {
                            q_ctrl.map_or(cur, |p| [2.0 * cur[0] - p[0], 2.0 * cur[1] - p[1]])
                        };
                        let v = [num!(), num!()];
                        end = [base[0] + v[0], base[1] + v[1]];
                        c1 = [
                            cur[0] + 2.0 / 3.0 * (q[0] - cur[0]),
                            cur[1] + 2.0 / 3.0 * (q[1] - cur[1]),
                        ];
                        c2 = [
                            end[0] + 2.0 / 3.0 * (q[0] - end[0]),
                            end[1] + 2.0 / 3.0 * (q[1] - end[1]),
                        ];
                        q_ctrl = Some(q);
                        c_ctrl = None;
                    }
                }
                let start_pt = apply(m, cur);
                if ring.is_empty() {
                    ring.push(start_pt);
                }
                flatten_cubic(
                    [start_pt, apply(m, c1), apply(m, c2), apply(m, end)],
                    tol,
                    &mut ring,
                );
                cur = end;
            }
            b'A' => {
                let (rx, ry, rot) = (num!(), num!(), num!());
                let (Some(large), Some(sweep)) = (sc.flag(), sc.flag()) else {
                    ok = false;
                    break;
                };
                let (x, y) = (num!(), num!());
                let end = [base[0] + x, base[1] + y];
                if ring.is_empty() {
                    ring.push(apply(m, cur));
                }
                for [c1, c2, e] in arc_to_cubics(cur, rx, ry, rot, large, sweep, end) {
                    let s = *ring.last().unwrap_or(&apply(m, cur));
                    flatten_cubic([s, apply(m, c1), apply(m, c2), apply(m, e)], tol, &mut ring);
                }
                cur = end;
                (c_ctrl, q_ctrl) = (None, None);
            }
            b'Z' => {
                finish(&mut ring, &mut rings);
                cur = start;
                (c_ctrl, q_ctrl) = (None, None);
                ring.push(apply(m, cur));
            }
            _ => {
                ok = false;
                break;
            }
        }
    }
    finish(&mut ring, &mut rings);
    (rings, ok)
}

fn orient_shapes(shapes: Vec<Vec<Vec<V2>>>) -> Region {
    let mut out = Vec::new();
    for mut rings in shapes {
        if rings.is_empty() {
            continue;
        }
        let outer = rings.remove(0);
        let mut p = Polygon { outer, holes: rings };
        p.normalize_orientation();
        if p.outer.len() < 3 {
            continue;
        }
        out.push(p.outer);
        out.extend(p.holes.into_iter().filter(|h| h.len() >= 3));
    }
    out
}

fn resolve(contours: Vec<Vec<V2>>, rule: FillRule) -> Region {
    let contours: Vec<Vec<V2>> = contours.into_iter().filter(|c| c.len() >= 3).collect();
    if contours.is_empty() {
        return Vec::new();
    }
    orient_shapes(contours.simplify_shape(rule))
}

fn union(mut a: Region, b: &Region) -> Region {
    a.extend(b.iter().cloned());
    resolve(a, FillRule::NonZero)
}

fn difference(a: &Region, b: &Region) -> Region {
    if b.is_empty() || a.is_empty() {
        return a.clone();
    }
    let mut all = a.clone();
    all.extend(b.iter().map(|c| c.iter().rev().copied().collect::<Vec<V2>>()));
    resolve(all, FillRule::Positive)
}

fn bounds(r: &Region) -> Option<(V2, V2)> {
    let mut it = r.iter().flatten().copied();
    let first = it.next()?;
    Some(it.fold((first, first), |(lo, hi), p| {
        (
            [lo[0].min(p[0]), lo[1].min(p[1])],
            [hi[0].max(p[0]), hi[1].max(p[1])],
        )
    }))
}

fn intersect(a: &Region, b: &Region) -> Region {
    let (Some((alo, ahi)), Some((blo, bhi))) = (bounds(a), bounds(b)) else {
        return Vec::new();
    };
    let pad = 1.0;
    let (lo, hi) = (
        [alo[0].min(blo[0]) - pad, alo[1].min(blo[1]) - pad],
        [ahi[0].max(bhi[0]) + pad, ahi[1].max(bhi[1]) + pad],
    );
    let frame = vec![poly2d::rect(lo, hi)];
    let outside = difference(&frame, b);
    difference(a, &outside)
}

fn area(r: &Region) -> f64 {
    r.iter().map(|c| poly2d::signed_area(c)).sum()
}

// document walk

#[derive(Clone)]
struct Style {
    fill: Option<Rgb>,
    evenodd: bool,
    m: Mat,
    clips: Vec<Rc<Region>>,
}

struct ClipShape {
    tag: String,
    attrs: String,
    m: Mat,
    evenodd: bool,
}

#[derive(Default)]
struct Defs {
    clips: HashMap<String, Vec<ClipShape>>,
    gradients: HashMap<String, Rgb>,
}

fn is_shape(tag: &str) -> bool {
    matches!(
        tag,
        "path" | "rect" | "circle" | "ellipse" | "polygon" | "polyline"
    )
}

fn stop_color(attrs: &str) -> Option<Rgb> {
    prop(attrs, "stop-color").and_then(parse_color)
}

fn scan_defs(xml: &str) -> Defs {
    let mut defs = Defs::default();
    let mut clip: Option<(String, Vec<Mat>)> = None;
    let mut grad: Option<String> = None;
    for ev in events(xml) {
        match ev {
            Ev::Start { name, attrs, empty } => {
                match name {
                    "clipPath" => {
                        let id = attr(attrs, "id").unwrap_or("").to_owned();
                        let m = attr(attrs, "transform").map_or(IDENTITY, parse_transform);
                        defs.clips.entry(id.clone()).or_default();
                        if !empty {
                            clip = Some((id, vec![m]));
                        }
                    }
                    "linearGradient" | "radialGradient" if !empty => {
                        grad = attr(attrs, "id").map(str::to_owned);
                    }
                    "stop" => {
                        if let (Some(id), Some(c)) = (&grad, stop_color(attrs)) {
                            defs.gradients.entry(id.clone()).or_insert(c);
                        }
                    }
                    _ => {
                        if let Some((id, stack)) = &mut clip {
                            let local = attr(attrs, "transform").map_or(IDENTITY, parse_transform);
                            let m = mul(stack.last().unwrap_or(&IDENTITY), &local);
                            if is_shape(name) {
                                if let Some(list) = defs.clips.get_mut(id) {
                                    list.push(ClipShape {
                                        tag: name.to_owned(),
                                        attrs: attrs.to_owned(),
                                        m,
                                        evenodd: prop(attrs, "clip-rule") == Some("evenodd"),
                                    });
                                }
                            } else if !empty {
                                stack.push(m);
                            }
                        }
                    }
                }
                if empty && name == "linearGradient" {
                    grad = None;
                }
            }
            Ev::End(name) => match name {
                "clipPath" => clip = None,
                "linearGradient" | "radialGradient" => grad = None,
                _ => {
                    if let Some((_, stack)) = &mut clip {
                        if stack.len() > 1 && !is_shape(name) {
                            stack.pop();
                        }
                    }
                }
            },
            Ev::Text(_) => {}
        }
    }
    defs
}

fn num_attr(attrs: &str, key: &str) -> Option<f64> {
    let v = attr(attrs, key)?.trim();
    let end = v
        .find(|c: char| !(c.is_ascii_digit() || matches!(c, '.' | '-' | '+' | 'e' | 'E')))
        .unwrap_or(v.len());
    v[..end].parse().ok()
}

fn absolute_mm(attrs: &str, key: &str) -> Option<f64> {
    let v = attr(attrs, key)?.trim();
    let n = num_attr(attrs, key)?;
    let unit = v.trim_start_matches(|c: char| c.is_ascii_digit() || matches!(c, '.' | '-' | '+' | 'e' | 'E'));
    Some(
        n * match unit.trim() {
            "mm" => 1.0,
            "cm" => 10.0,
            "in" => 25.4,
            "pt" => 25.4 / 72.0,
            "pc" => 25.4 / 6.0,
            "px" | "" => PX_MM,
            _ => return None,
        },
    )
}

fn shape_path(tag: &str, attrs: &str) -> Option<String> {
    let n = |k: &str| num_attr(attrs, k).unwrap_or(0.0);
    match tag {
        "path" => attr(attrs, "d").map(str::to_owned),
        "rect" => {
            let (x, y, w, h) = (n("x"), n("y"), n("width"), n("height"));
            if w <= 0.0 || h <= 0.0 {
                return None;
            }
            let (rx, ry) = (num_attr(attrs, "rx"), num_attr(attrs, "ry"));
            let (rx, ry) = (
                rx.or(ry).unwrap_or(0.0).clamp(0.0, w / 2.0),
                ry.or(rx).unwrap_or(0.0).clamp(0.0, h / 2.0),
            );
            if rx > 0.0 && ry > 0.0 {
                Some(format!(
                    "M{} {}H{}A{rx} {ry} 0 0 1 {} {}V{}A{rx} {ry} 0 0 1 {} {}H{}A{rx} {ry} 0 0 1 {} {}V{}A{rx} {ry} 0 0 1 {} {}Z",
                    x + rx,
                    y,
                    x + w - rx,
                    x + w,
                    y + ry,
                    y + h - ry,
                    x + w - rx,
                    y + h,
                    x + rx,
                    x,
                    y + h - ry,
                    y + ry,
                    x + rx,
                    y
                ))
            } else {
                Some(format!("M{x} {y}H{}V{}H{x}Z", x + w, y + h))
            }
        }
        "circle" | "ellipse" => {
            let (cx, cy) = (n("cx"), n("cy"));
            let (rx, ry) = if tag == "circle" {
                (n("r"), n("r"))
            } else {
                (n("rx"), n("ry"))
            };
            (rx > 0.0 && ry > 0.0).then(|| {
                format!(
                    "M{} {cy}A{rx} {ry} 0 1 0 {} {cy}A{rx} {ry} 0 1 0 {} {cy}Z",
                    cx - rx,
                    cx + rx,
                    cx - rx
                )
            })
        }
        "polygon" | "polyline" => {
            let pts: Vec<f64> = attr(attrs, "points")?
                .split(|c: char| c == ',' || c.is_whitespace())
                .filter(|t| !t.is_empty())
                .filter_map(|t| t.parse().ok())
                .collect();
            (pts.len() >= 6).then(|| {
                let mut d = String::from("M");
                for (i, p) in pts.as_chunks::<2>().0.iter().enumerate() {
                    d += &format!("{}{} {}", if i == 0 { "" } else { "L" }, p[0], p[1]);
                }
                d + "Z"
            })
        }
        _ => None,
    }
}

struct Painted {
    color: Rgb,
    region: Region,
}

fn walk(
    xml: &str,
    defs: &Defs,
    base: &Mat,
    opts: &SvgOptions,
    warnings: &mut Vec<String>,
) -> Result<Vec<Painted>> {
    let default_fill = parse_color(&opts.default_color)
        .ok_or_else(|| Error::invalid("defaultColor", "must be a #rrggbb color"))?;
    let root = Style {
        fill: Some(default_fill),
        evenodd: false,
        m: *base,
        clips: Vec::new(),
    };
    let mut stack = vec![root.clone()];
    let mut skip_depth = 0usize;
    let mut out = Vec::new();
    let warn = |what: &str, warnings: &mut Vec<String>| {
        if !warnings.iter().any(|w| w == what) {
            warnings.push(what.to_owned());
        }
    };
    for ev in events(xml) {
        match ev {
            Ev::Start { name, attrs, empty } => {
                if skip_depth > 0 {
                    if !empty {
                        skip_depth += 1;
                    }
                    continue;
                }
                if matches!(
                    name,
                    "defs"
                        | "clipPath"
                        | "mask"
                        | "symbol"
                        | "marker"
                        | "pattern"
                        | "style"
                        | "metadata"
                        | "title"
                        | "desc"
                        | "linearGradient"
                        | "radialGradient"
                        | "filter"
                        | "text"
                        | "image"
                        | "foreignObject"
                ) {
                    if matches!(name, "mask" | "text" | "image" | "filter" | "pattern") {
                        warn(&format!("<{name}> is not supported and was ignored"), warnings);
                    }
                    if !empty {
                        skip_depth = 1;
                    }
                    continue;
                }
                if name == "use" {
                    warn("<use> is not supported and was ignored", warnings);
                }
                let parent = stack.last().unwrap_or(&root).clone();
                let mut style = parent.clone();
                if let Some(t) = attr(attrs, "transform") {
                    style.m = mul(&style.m, &parse_transform(t));
                }
                if let Some(f) = prop(attrs, "fill") {
                    let f = f.trim();
                    style.fill = if f == "none" || f == "transparent" {
                        None
                    } else if f == "currentColor" || f == "inherit" {
                        parent.fill
                    } else if let Some(id) = f.strip_prefix("url(#").and_then(|r| r.split(')').next()) {
                        match defs.gradients.get(id) {
                            Some(c) => {
                                warn(
                                    "gradient fills are drawn in the color of their first stop",
                                    warnings,
                                );
                                Some(*c)
                            }
                            None => parent.fill,
                        }
                    } else if let Some(c) = parse_color(f) {
                        Some(c)
                    } else {
                        warn(
                            &format!("fill \"{f}\" is not supported; the inherited fill is used"),
                            warnings,
                        );
                        parent.fill
                    };
                }
                if let Some(r) = prop(attrs, "fill-rule") {
                    style.evenodd = r.trim() == "evenodd";
                }
                let hidden = attr(attrs, "display") == Some("none")
                    || prop(attrs, "visibility") == Some("hidden")
                    || prop(attrs, "opacity").and_then(|o| o.parse::<f64>().ok()) == Some(0.0)
                    || prop(attrs, "fill-opacity").and_then(|o| o.parse::<f64>().ok()) == Some(0.0);
                if hidden {
                    if !empty {
                        skip_depth = 1;
                    }
                    continue;
                }
                if let Some(id) =
                    prop(attrs, "clip-path").and_then(|c| c.trim().strip_prefix("url(#")?.split(')').next())
                {
                    if let Some(shapes) = defs.clips.get(id) {
                        let mut region: Region = Vec::new();
                        for s in shapes {
                            if let Some(d) = shape_path(&s.tag, &s.attrs) {
                                let (rings, _) = flatten_path(&d, &mul(&style.m, &s.m), opts.tolerance_mm);
                                let rule = if s.evenodd {
                                    FillRule::EvenOdd
                                } else {
                                    FillRule::NonZero
                                };
                                region = union(region, &resolve(rings, rule));
                            }
                        }
                        style.clips.push(Rc::new(region));
                    }
                }
                if is_shape(name) {
                    if let (Some(color), Some(d)) = (style.fill, shape_path(name, attrs)) {
                        let (rings, ok) = flatten_path(&d, &style.m, opts.tolerance_mm);
                        if !ok {
                            warn("malformed path data was cut short", warnings);
                        }
                        let rule = if style.evenodd {
                            FillRule::EvenOdd
                        } else {
                            FillRule::NonZero
                        };
                        let mut region = resolve(rings, rule);
                        for clip in &style.clips {
                            region = intersect(&region, clip);
                        }
                        if !region.is_empty() {
                            out.push(Painted { color, region });
                        }
                    }
                }
                if !empty {
                    stack.push(style);
                }
            }
            Ev::End(_) => {
                if skip_depth > 0 {
                    skip_depth -= 1;
                } else if stack.len() > 1 {
                    stack.pop();
                }
            }
            Ev::Text(_) => {}
        }
    }
    Ok(out)
}

fn polygons(region: &Region) -> Vec<Polygon> {
    if region.is_empty() {
        return Vec::new();
    }
    region
        .clone()
        .simplify_shape(FillRule::NonZero)
        .into_iter()
        .filter_map(|mut rings| {
            if rings.is_empty() {
                return None;
            }
            let outer = rings.remove(0);
            let mut p = Polygon { outer, holes: rings };
            p.normalize_orientation();
            (p.outer.len() >= 3 && p.area() > 1e-9).then_some(p)
        })
        .collect()
}

fn translate(r: &mut Region, d: V2) {
    for p in r.iter_mut().flatten() {
        *p = [p[0] - d[0], p[1] - d[1]];
    }
}

fn paint(svg: &str, opts: &SvgOptions) -> Result<(Vec<Painted>, Vec<String>, f64)> {
    for (what, v) in [("heightMm", opts.height_mm), ("toleranceMm", opts.tolerance_mm)] {
        if !(v.is_finite() && v > 0.0) {
            return Err(Error::invalid(what, "must be above 0"));
        }
    }
    if !(opts.base_mm.is_finite()
        && opts.base_mm >= 0.0
        && opts.base_margin_mm.is_finite()
        && opts.base_margin_mm >= 0.0)
    {
        return Err(Error::invalid("baseMm", "must not be negative"));
    }
    if opts.scale.is_some_and(|s| !(s.is_finite() && s > 0.0)) {
        return Err(Error::invalid("scale", "must be above 0"));
    }
    let root = events(svg)
        .find_map(|e| match e {
            Ev::Start {
                name: "svg", attrs, ..
            } => Some(attrs),
            _ => None,
        })
        .ok_or_else(|| Error::mesh("svg", "no <svg> element"))?;
    let view_w = attr(root, "viewBox").and_then(|v| {
        let n: Vec<f64> = v
            .split(|c: char| c == ',' || c.is_whitespace())
            .filter_map(|t| t.parse().ok())
            .collect();
        (n.len() == 4 && n[2] > 0.0).then(|| n[2])
    });
    let own = match (absolute_mm(root, "width"), view_w) {
        (Some(w), Some(vw)) => w / vw,
        _ => PX_MM,
    };
    let defs = scan_defs(svg);
    let run = |s: f64| -> Result<(Vec<Painted>, Vec<String>)> {
        let mut warnings = Vec::new();
        let base = [s, 0.0, 0.0, -s, 0.0, 0.0];
        let painted = walk(svg, &defs, &base, opts, &mut warnings)?;
        Ok((painted, warnings))
    };
    let mut scale = opts.scale.unwrap_or(own);
    let (mut painted, mut warnings) = run(scale)?;
    if opts.scale.is_none() && (opts.fit_width_mm.is_some() || opts.fit_height_mm.is_some()) {
        let all: Region = painted.iter().flat_map(|p| p.region.iter().cloned()).collect();
        if let Some((lo, hi)) = bounds(&all) {
            let target = opts
                .fit_width_mm
                .map(|w| w / (hi[0] - lo[0]))
                .or_else(|| opts.fit_height_mm.map(|h| h / (hi[1] - lo[1])))
                .filter(|f| f.is_finite() && *f > 0.0);
            if let Some(f) = target {
                scale *= f;
                (painted, warnings) = run(scale)?;
            }
        }
    }
    if painted.is_empty() {
        return Err(Error::mesh("svg", "the artwork has no filled shapes"));
    }
    Ok((painted, warnings, scale))
}

pub fn outline(svg: &str, width_mm: f64, tolerance_mm: f64) -> Result<(Vec<Polygon>, Vec<String>)> {
    if !(width_mm.is_finite() && width_mm > 0.0 && width_mm <= 10_000.0) {
        return Err(Error::invalid("widthMm", "between 0 and 10000 mm"));
    }
    let opts = SvgOptions {
        fit_width_mm: Some(width_mm),
        tolerance_mm,
        ..SvgOptions::default()
    };
    let (painted, warnings, _) = paint(svg, &opts)?;
    let mut all: Region = Vec::new();
    for p in &painted {
        all = union(all, &p.region);
    }
    let (lo, hi) = bounds(&all).ok_or_else(|| Error::mesh("svg", "the artwork has no area"))?;
    translate(
        &mut all,
        [f64::midpoint(lo[0], hi[0]), f64::midpoint(lo[1], hi[1])],
    );
    let polys = polygons(&all);
    if polys.is_empty() {
        return Err(Error::mesh("svg", "the artwork has no area"));
    }
    Ok((polys, warnings))
}

pub fn extrude_svg(svg: &str, opts: &SvgOptions) -> Result<SvgModel> {
    let (painted, warnings, scale) = paint(svg, opts)?;

    let mut covered: Region = Vec::new();
    let mut visible: Vec<(Rgb, Region)> = Vec::new();
    for p in painted.iter().rev() {
        let v = difference(&p.region, &covered);
        covered = union(covered, &p.region);
        if !v.is_empty() {
            visible.push((p.color, v));
        }
    }
    visible.reverse();

    let mut counts: Vec<(Rgb, usize)> = Vec::new();
    for (c, r) in &visible {
        let a = (area(r).abs() * 1000.0) as usize + 1;
        match counts.iter_mut().find(|(x, _)| x == c) {
            Some((_, w)) => *w += a,
            None => counts.push((*c, a)),
        }
    }
    let (palette, slot_of) = build_palette(&counts, opts.max_colors.clamp(1, 255));
    let mut groups: Vec<(usize, Region)> = Vec::new();
    for (c, r) in visible {
        let pi = counts.iter().position(|(x, _)| *x == c).map_or(0, |i| slot_of[i]);
        match groups.iter_mut().find(|(g, _)| *g == pi) {
            Some((_, region)) => *region = union(std::mem::take(region), &r),
            None => groups.push((pi, r)),
        }
    }

    let all: Region = groups.iter().flat_map(|(_, r)| r.iter().cloned()).collect();
    let (lo, hi) = bounds(&all).ok_or_else(|| Error::mesh("svg", "the artwork has no area"))?;
    for (_, r) in &mut groups {
        translate(r, lo);
    }
    let (w, d) = (hi[0] - lo[0], hi[1] - lo[1]);

    let plate_color = match &opts.base_color {
        Some(c) => {
            Some(parse_color(c).ok_or_else(|| Error::invalid("baseColor", "must be a #rrggbb color"))?)
        }
        None => groups.first().map(|(pi, _)| palette[*pi]),
    };
    let mut slot_colors: Vec<Rgb> = Vec::new();
    let slot = |c: Rgb, slot_colors: &mut Vec<Rgb>| -> u8 {
        let i = slot_colors.iter().position(|x| *x == c).unwrap_or_else(|| {
            slot_colors.push(c);
            slot_colors.len() - 1
        });
        u8::try_from(i + 1).unwrap_or(u8::MAX)
    };
    let z0 = opts.base_mm;
    let mut parts: Vec<SvgPart> = Vec::new();
    if opts.base_mm > 0.0 {
        let c = plate_color.unwrap_or([128, 128, 128]);
        let m = opts.base_margin_mm;
        let rect = Polygon::simple(poly2d::rect([-m, -m], [w + m, d + m]));
        let mesh = build::extrude(&[rect], &Frame::WORLD, 0.0, opts.base_mm)?;
        parts.push(SvgPart {
            name: "base plate".to_owned(),
            color: hex(c),
            slot: slot(c, &mut slot_colors),
            mesh,
            area_mm2: (w + 2.0 * m) * (d + 2.0 * m),
        });
    }
    for (pi, region) in &groups {
        let polys = polygons(region);
        if polys.is_empty() {
            continue;
        }
        let c = palette[*pi];
        let mesh = build::extrude(&polys, &Frame::WORLD, z0, z0 + opts.height_mm)?;
        parts.push(SvgPart {
            name: hex(c),
            color: hex(c),
            slot: slot(c, &mut slot_colors),
            mesh,
            area_mm2: polys.iter().map(Polygon::area).sum(),
        });
    }
    if opts.base_mm > 0.0 && opts.base_margin_mm > 0.0 {
        let m = opts.base_margin_mm;
        for p in &mut parts {
            p.mesh.translate([m, m, 0.0]);
        }
    }
    let margin = if opts.base_mm > 0.0 {
        2.0 * opts.base_margin_mm
    } else {
        0.0
    };
    Ok(SvgModel {
        parts,
        slot_colors: slot_colors.into_iter().map(hex).collect(),
        size_mm: [w + margin, d + margin, opts.base_mm + opts.height_mm],
        mm_per_unit: scale,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::float_cmp)]
    use super::*;

    fn opts() -> SvgOptions {
        SvgOptions {
            scale: Some(1.0),
            ..SvgOptions::default()
        }
    }

    fn wrap(body: &str) -> String {
        format!("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\">{body}</svg>")
    }

    fn solid(p: &SvgPart) {
        let e = p.mesh.edge_report();
        assert!(e.is_watertight(), "{}: {e:?}", p.name);
        assert!(p.mesh.volume() > 0.0, "{}", p.name);
    }

    #[test]
    fn rect_and_transforms_extrude_with_the_right_size() {
        let m = extrude_svg(
            &wrap(r##"<g transform="translate(10 20) scale(2)"><rect x="0" y="0" width="10" height="5" fill="#f00"/></g>"##),
            &opts(),
        )
        .unwrap();
        assert_eq!(m.parts.len(), 1);
        assert_eq!(m.slot_colors, vec!["#ff0000"]);
        assert_eq!(m.size_mm, [20.0, 10.0, 2.0]);
        solid(&m.parts[0]);
        assert!((m.parts[0].mesh.volume() - 20.0 * 10.0 * 2.0).abs() < 1e-6);
        let b = m.parts[0].mesh.bounds().unwrap();
        assert!(b.min[0].abs() < 1e-9 && b.min[1].abs() < 1e-9 && b.min[2].abs() < 1e-9);
        let r = extrude_svg(
            &wrap(r#"<rect width="10" height="4" transform="rotate(90)"/>"#),
            &opts(),
        )
        .unwrap();
        assert!(
            (r.size_mm[0] - 4.0).abs() < 1e-9 && (r.size_mm[1] - 10.0).abs() < 1e-9,
            "{:?}",
            r.size_mm
        );
    }

    #[test]
    fn fill_rules_decide_holes() {
        let ring = "M0 0H40V40H0Z M10 10H30V30H10Z";
        let even = extrude_svg(
            &wrap(&format!(r#"<path fill-rule="evenodd" d="{ring}"/>"#)),
            &opts(),
        )
        .unwrap();
        let non = extrude_svg(&wrap(&format!(r#"<path d="{ring}"/>"#)), &opts()).unwrap();
        assert!((even.parts[0].mesh.volume() - (1600.0 - 400.0) * 2.0).abs() < 1e-6);
        assert!((non.parts[0].mesh.volume() - 1600.0 * 2.0).abs() < 1e-6);
        solid(&even.parts[0]);
        let opp = extrude_svg(&wrap(r#"<path d="M0 0H40V40H0Z M10 10V30H30V10Z"/>"#), &opts()).unwrap();
        assert!((opp.parts[0].mesh.volume() - 1200.0 * 2.0).abs() < 1e-6);
        let st = extrude_svg(
            &wrap(&format!(
                r#"<path style="fill-rule:evenodd;fill:#00f" d="{ring}"/>"#
            )),
            &opts(),
        )
        .unwrap();
        assert_eq!(st.slot_colors, vec!["#0000ff"]);
        assert!((st.parts[0].mesh.volume() - 2400.0).abs() < 1e-6);
    }

    #[test]
    fn curves_and_arcs_flatten_within_tolerance() {
        let circle = extrude_svg(&wrap(r#"<circle cx="50" cy="50" r="20"/>"#), &opts()).unwrap();
        let area = circle.parts[0].area_mm2;
        let exact = std::f64::consts::PI * 400.0;
        assert!((area - exact).abs() / exact < 0.005, "{area} vs {exact}");
        solid(&circle.parts[0]);
        let arcs = extrude_svg(
            &wrap(r#"<path d="M30 50a20 20 0 1 0 40 0a20 20 0 1 0-40 0z"/>"#),
            &opts(),
        )
        .unwrap();
        assert!((arcs.parts[0].area_mm2 - exact).abs() / exact < 0.005);
        let k = 0.552_284_75 * 20.0;
        let cubic = extrude_svg(
            &wrap(&format!(
                r#"<path d="M70 50C70 {a} {b} 70 50 70S30 {a} 30 50S{b} 30 50 30S70 {b} 70 50z"/>"#,
                a = 50.0 + k,
                b = 50.0 + 20.0 - 0.0
            )),
            &opts(),
        );
        assert!(cubic.is_ok());
        let coarse = extrude_svg(
            &wrap(r#"<circle cx="50" cy="50" r="20"/>"#),
            &SvgOptions {
                tolerance_mm: 0.5,
                ..opts()
            },
        )
        .unwrap();
        assert!(coarse.parts[0].mesh.triangles.len() < circle.parts[0].mesh.triangles.len());
        let q = extrude_svg(&wrap(r#"<path d="M10 10Q50 -20 90 10T90 50L10 50z"/>"#), &opts()).unwrap();
        solid(&q.parts[0]);
    }

    #[test]
    fn overlapping_colors_paint_bottom_to_top_without_overlap() {
        let m = extrude_svg(
            &wrap(r##"<rect width="40" height="40" fill="#ff0000"/><rect x="10" y="10" width="20" height="20" fill="#0000ff"/>"##),
            &opts(),
        )
        .unwrap();
        assert_eq!(m.parts.len(), 2);
        assert_eq!(m.parts.iter().map(|p| p.slot).collect::<Vec<_>>(), vec![1, 2]);
        assert!((m.parts[0].area_mm2 - 1200.0).abs() < 1e-6);
        assert!((m.parts[1].area_mm2 - 400.0).abs() < 1e-6);
        m.parts.iter().for_each(solid);
        let one = extrude_svg(
            &wrap(r##"<rect width="30" height="30" fill="#0f0"/><rect x="20" y="0" width="30" height="30" fill="#00ff00"/>"##),
            &opts(),
        )
        .unwrap();
        assert_eq!(one.parts.len(), 1);
        assert!((one.parts[0].area_mm2 - 1500.0).abs() < 1e-6);
    }

    #[test]
    fn base_plate_and_limits() {
        let m = extrude_svg(
            &wrap(r##"<rect width="20" height="10" fill="#123456"/>"##),
            &SvgOptions {
                base_mm: 1.5,
                base_margin_mm: 3.0,
                height_mm: 2.0,
                base_color: Some("#ffffff".to_owned()),
                ..opts()
            },
        )
        .unwrap();
        assert_eq!(m.parts.len(), 2);
        assert_eq!(m.parts[0].name, "base plate");
        assert_eq!(m.slot_colors, vec!["#ffffff", "#123456"]);
        assert_eq!(m.size_mm, [26.0, 16.0, 3.5]);
        m.parts.iter().for_each(solid);
        let art = m.parts[1].mesh.bounds().unwrap();
        assert!((art.min[2] - 1.5).abs() < 1e-9 && (art.max[2] - 3.5).abs() < 1e-9);
        assert!((art.min[0] - 3.0).abs() < 1e-9, "{art:?}");
        let plate = m.parts[0].mesh.bounds().unwrap();
        assert!(plate.min[0].abs() < 1e-9 && (plate.max[0] - 26.0).abs() < 1e-9);
        let mut body = String::new();
        for i in 0..8 {
            body += &format!(
                r##"<rect x="{}" width="8" height="8" fill="#{:02x}{:02x}00"/>"##,
                i * 10,
                i * 30,
                255 - i * 30
            );
        }
        let merged = extrude_svg(
            &wrap(&body),
            &SvgOptions {
                max_colors: 3,
                ..opts()
            },
        )
        .unwrap();
        assert_eq!(merged.slot_colors.len(), 3);
        assert!(merged.parts.len() <= 3);
    }

    #[test]
    fn sizes_and_errors() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"50mm\" height=\"25mm\" viewBox=\"0 0 100 50\"><rect width=\"100\" height=\"50\"/></svg>";
        let own = extrude_svg(svg, &SvgOptions::default()).unwrap();
        assert!((own.size_mm[0] - 50.0).abs() < 1e-9 && (own.mm_per_unit - 0.5).abs() < 1e-12);
        let fit = extrude_svg(
            svg,
            &SvgOptions {
                fit_width_mm: Some(80.0),
                ..SvgOptions::default()
            },
        )
        .unwrap();
        assert!((fit.size_mm[0] - 80.0).abs() < 1e-6 && (fit.size_mm[1] - 40.0).abs() < 1e-6);
        let px = extrude_svg(&wrap(r#"<rect width="96" height="96"/>"#), &SvgOptions::default()).unwrap();
        assert!((px.size_mm[0] - 25.4).abs() < 1e-5);
        for bad in [
            "",
            "<div/>",
            "<svg></svg>",
            "<svg><rect width=\"0\" height=\"5\"/></svg>",
        ] {
            assert!(extrude_svg(bad, &opts()).is_err(), "{bad}");
        }
        assert!(
            extrude_svg(
                &wrap("<rect width=\"5\" height=\"5\"/>"),
                &SvgOptions {
                    height_mm: 0.0,
                    ..opts()
                }
            )
            .is_err()
        );
        let m = extrude_svg(
            &wrap(
                r##"<use href="#a"/><rect width="5" height="5" fill="none"/><rect width="9" height="9"/>"##,
            ),
            &opts(),
        )
        .unwrap();
        assert!(m.warnings.iter().any(|w| w.contains("<use>")));
        assert_eq!(m.parts.len(), 1);
        assert!((m.parts[0].area_mm2 - 81.0).abs() < 1e-9);
    }

    #[test]
    fn gradient_stripes_clipped_by_an_x_extrude() {
        let stripes = (0..8).fold(String::new(), |mut out, i| {
            let y = 4.4 + f64::from(i) * 2.9;
            out.push_str(&format!(
                r#"<rect x="0" y="{y}" width="32" height="1.6" fill="url(#g)" clip-path="url(#x)"/>"#
            ));
            out
        });
        let svg = format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32"><defs><linearGradient id="g"><stop offset="0" stop-color="#bd93f9"/><stop offset="1" stop-color="#ff79c6"/></linearGradient><clipPath id="x"><path d="M5.44 4.55L13.78 4.55L16 8.53L18.22 4.55L26.56 4.55L20.17 16L26.56 27.45L18.22 27.45L16 23.47L13.78 27.45L5.44 27.45L11.83 16z"/></clipPath></defs>{stripes}</svg>"##
        );
        let m = extrude_svg(&svg, &opts()).unwrap();
        assert_eq!(m.parts.len(), 1);
        assert_eq!(m.slot_colors, vec!["#bd93f9"]);
        assert!(m.warnings.iter().any(|w| w.contains("gradient")));
        let p = &m.parts[0];
        solid(p);
        assert!(p.mesh.components().len() >= 8, "{}", p.mesh.components().len());
        assert!((m.size_mm[0] - 21.12).abs() < 0.05, "{:?}", m.size_mm);
        assert!((m.size_mm[1] - 21.75).abs() < 0.05, "{:?}", m.size_mm);
        let x_area = 2.0 * (6.2 * 24.0) * 0.6;
        assert!(p.area_mm2 > 100.0 && p.area_mm2 < x_area * 1.6, "{}", p.area_mm2);
        let fine = extrude_svg(
            &svg,
            &SvgOptions {
                tolerance_mm: 0.001,
                ..opts()
            },
        )
        .unwrap();
        solid(&fine.parts[0]);
    }
}
