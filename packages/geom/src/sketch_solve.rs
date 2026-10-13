// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! the sketch solver: points, lines, circles and arcs held by constraints. Newton steps, with a
//! Levenberg-Marquardt fallback when a step doesn't help; degrees of freedom by the jacobian's rank; the
//! constraints that conflict or repeat, by index
// point, parameter and row indices are checked when the sketch is read
#![allow(clippy::indexing_slicing)]

use crate::error::{Error, Result};
use crate::fm::Fm;
use serde::{Deserialize, Serialize};
use std::ops::{Add, Div, Mul, Neg, Sub};

#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Entity {
    Line {
        a: usize,
        b: usize,
    },
    /// `radius` is where the solve starts; the solved one comes back in `Solved::radii`
    Circle {
        center: usize,
        radius: f64,
    },
    /// counterclockwise from `start` to `end`; its radius is the distance from `center` to `start`
    Arc {
        center: usize,
        start: usize,
        end: usize,
    },
}

/// Lines, circles and arcs are by entity index, points by point index. Values are mm, angles degrees.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Constraint {
    Coincident {
        a: usize,
        b: usize,
    },
    /// the point stays where it is
    Fix {
        point: usize,
    },
    Horizontal {
        line: usize,
    },
    Vertical {
        line: usize,
    },
    Parallel {
        a: usize,
        b: usize,
    },
    Perpendicular {
        a: usize,
        b: usize,
    },
    Collinear {
        a: usize,
        b: usize,
    },
    /// two lines of one length, or two circles or arcs of one radius
    Equal {
        a: usize,
        b: usize,
    },
    /// a line and a circle or arc, or two circles or arcs
    Tangent {
        a: usize,
        b: usize,
    },
    Midpoint {
        point: usize,
        line: usize,
    },
    Concentric {
        a: usize,
        b: usize,
    },
    OnLine {
        point: usize,
        line: usize,
    },
    OnCircle {
        point: usize,
        circle: usize,
    },
    /// `a` and `b` mirror each other across `line`
    Symmetric {
        a: usize,
        b: usize,
        line: usize,
    },
    Distance {
        a: usize,
        b: usize,
        value: f64,
    },
    HorizontalDistance {
        a: usize,
        b: usize,
        value: f64,
    },
    VerticalDistance {
        a: usize,
        b: usize,
        value: f64,
    },
    Length {
        line: usize,
        value: f64,
    },
    Radius {
        circle: usize,
        value: f64,
    },
    Diameter {
        circle: usize,
        value: f64,
    },
    /// from line `a` to line `b`, counterclockwise
    Angle {
        a: usize,
        b: usize,
        value: f64,
    },
    LineDistance {
        point: usize,
        line: usize,
        value: f64,
    },
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sketch {
    pub points: Vec<[f64; 2]>,
    #[serde(default)]
    pub entities: Vec<Entity>,
    #[serde(default)]
    pub constraints: Vec<Constraint>,
}

/// a point pulled toward `to` while it is dragged: it gives way only where the constraints make it
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Drag {
    pub point: usize,
    pub to: [f64; 2],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    /// every constraint holds
    Ok,
    /// every constraint holds, and some say again what others already say
    Redundant,
    /// the constraints can't all hold; the sketch is left as it was
    Conflict,
    /// no solution found from here; the sketch is left as it was
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Solved {
    pub status: Status,
    pub points: Vec<[f64; 2]>,
    /// per entity: the circle's radius, the arc's, none for a line
    pub radii: Vec<Option<f64>>,
    /// degrees of freedom left; 0 is fully defined
    pub dof: usize,
    /// per point: it can still move
    pub free_points: Vec<bool>,
    /// per entity: a circle or arc whose radius can still change
    pub free_radii: Vec<bool>,
    /// constraints that conflict with the ones before them
    pub conflicting: Vec<usize>,
    /// constraints that hold but add nothing
    pub redundant: Vec<usize>,
    pub iterations: usize,
}

const TOL: f64 = 1e-9;
const MAX_ITER: usize = 60;
const VARS: usize = 8;

// forward-mode dual number: a value and its gradient over the (at most 8) parameters of one constraint
#[derive(Debug, Clone, Copy)]
struct D {
    v: f64,
    d: [f64; VARS],
}

impl D {
    fn c(v: f64) -> Self {
        Self { v, d: [0.0; VARS] }
    }
    fn map(self, v: f64, k: f64) -> Self {
        Self {
            v,
            d: self.d.map(|x| x * k),
        }
    }
    fn sqrt(self) -> Self {
        let v = self.v.max(0.0).sqrt();
        // the gradient of a zero length is taken as zero, not infinite
        self.map(v, if v > 1e-150 { 0.5 / v } else { 0.0 })
    }
    fn abs(self) -> Self {
        if self.v < 0.0 { -self } else { self }
    }
}

impl Add for D {
    type Output = Self;
    fn add(self, o: Self) -> Self {
        let mut d = self.d;
        for (x, y) in d.iter_mut().zip(o.d) {
            *x += y;
        }
        Self { v: self.v + o.v, d }
    }
}

impl Sub for D {
    type Output = Self;
    fn sub(self, o: Self) -> Self {
        self + -o
    }
}

impl Neg for D {
    type Output = Self;
    fn neg(self) -> Self {
        self.map(-self.v, -1.0)
    }
}

impl Mul for D {
    type Output = Self;
    fn mul(self, o: Self) -> Self {
        let mut d = [0.0; VARS];
        for (i, x) in d.iter_mut().enumerate() {
            *x = self.d[i] * o.v + o.d[i] * self.v;
        }
        Self { v: self.v * o.v, d }
    }
}

impl Div for D {
    type Output = Self;
    fn div(self, o: Self) -> Self {
        let mut d = [0.0; VARS];
        let w = o.v * o.v;
        for (i, x) in d.iter_mut().enumerate() {
            *x = (self.d[i] * o.v - o.d[i] * self.v) / w;
        }
        Self { v: self.v / o.v, d }
    }
}

impl Mul<f64> for D {
    type Output = Self;
    fn mul(self, k: f64) -> Self {
        self.map(self.v * k, k)
    }
}

impl Sub<f64> for D {
    type Output = Self;
    fn sub(self, k: f64) -> Self {
        Self {
            v: self.v - k,
            d: self.d,
        }
    }
}

#[derive(Clone, Copy)]
struct P {
    x: D,
    y: D,
}

impl P {
    fn sub(self, o: Self) -> Self {
        Self {
            x: self.x - o.x,
            y: self.y - o.y,
        }
    }
    fn dot(self, o: Self) -> D {
        self.x * o.x + self.y * o.y
    }
    fn cross(self, o: Self) -> D {
        self.x * o.y - self.y * o.x
    }
    fn len(self) -> D {
        self.dot(self).sqrt()
    }
}

// the parameters: each point's x and y (coincident points share them), then each circle's radius
struct Layout {
    rep: Vec<usize>,
    radius: Vec<Option<usize>>,
    count: usize,
}

#[derive(Clone, Copy, PartialEq)]
enum Src {
    Constraint(usize),
    // an arc's end held on its circle
    Arc(usize),
}

// one residual row: where it came from, which of its rows it is, the parameters it reads
struct Row {
    src: Src,
    nth: usize,
    vars: Vec<usize>,
}

impl Row {
    fn of(&self) -> Option<usize> {
        match self.src {
            Src::Constraint(k) => Some(k),
            Src::Arc(_) => None,
        }
    }
}

// reads the parameters of one constraint as duals, in the order they are first asked for
struct Ctx<'a> {
    x: &'a [f64],
    vars: Vec<usize>,
}

impl Ctx<'_> {
    fn var(&mut self, i: usize) -> D {
        let k = self.vars.iter().position(|&v| v == i).unwrap_or_else(|| {
            self.vars.push(i);
            self.vars.len() - 1
        });
        let mut d = D::c(self.x[i]);
        d.d[k] = 1.0;
        d
    }
}

struct Model<'a> {
    s: &'a Sketch,
    l: Layout,
    // per constraint, a side chosen from where the sketch starts: which side of a line, which tangency
    sign: Vec<f64>,
}

impl Model<'_> {
    fn point(&self, c: &mut Ctx<'_>, p: usize) -> P {
        let r = self.l.rep[p];
        P {
            x: c.var(2 * r),
            y: c.var(2 * r + 1),
        }
    }

    fn line(&self, c: &mut Ctx<'_>, e: usize) -> Result<(P, P)> {
        match self.s.entities.get(e) {
            Some(Entity::Line { a, b }) => Ok((self.point(c, *a), self.point(c, *b))),
            _ => Err(Error::invalid("constraints", format!("entity {e} is not a line"))),
        }
    }

    // a circle or an arc: its center and radius
    fn round(&self, c: &mut Ctx<'_>, e: usize) -> Result<(P, D)> {
        match self.s.entities.get(e) {
            Some(Entity::Circle { center, .. }) => {
                let p = self.point(c, *center);
                let r = c.var(self.l.radius[e].unwrap_or(0));
                Ok((p, r))
            }
            Some(Entity::Arc { center, start, .. }) => {
                let p = self.point(c, *center);
                let s = self.point(c, *start);
                Ok((p, s.sub(p).len()))
            }
            _ => Err(Error::invalid(
                "constraints",
                format!("entity {e} is not a circle or an arc"),
            )),
        }
    }

    fn is_line(&self, e: usize) -> bool {
        matches!(self.s.entities.get(e), Some(Entity::Line { .. }))
    }

    // the residuals of constraint `k`, zero when it holds
    #[allow(clippy::too_many_lines, reason = "one arm per constraint")]
    fn residuals(&self, k: usize, c: &mut Ctx<'_>) -> Result<Vec<D>> {
        let sign = self.sign.get(k).copied().unwrap_or(1.0);
        let unit = |a: P, b: P| -> (P, D) {
            let d = b.sub(a);
            (d, d.len())
        };
        Ok(match self.s.constraints[k] {
            Constraint::Coincident { .. } | Constraint::Fix { .. } => vec![],
            Constraint::Horizontal { line } => {
                let (a, b) = self.line(c, line)?;
                vec![b.y - a.y]
            }
            Constraint::Vertical { line } => {
                let (a, b) = self.line(c, line)?;
                vec![b.x - a.x]
            }
            Constraint::Parallel { a, b } | Constraint::Perpendicular { a, b } => {
                let (a0, a1) = self.line(c, a)?;
                let (b0, b1) = self.line(c, b)?;
                let (da, la) = unit(a0, a1);
                let (db, lb) = unit(b0, b1);
                let v = if matches!(self.s.constraints[k], Constraint::Parallel { .. }) {
                    da.cross(db)
                } else {
                    da.dot(db)
                };
                vec![v / (la * lb)]
            }
            Constraint::Collinear { a, b } => {
                let (a0, a1) = self.line(c, a)?;
                let (b0, b1) = self.line(c, b)?;
                let (d, l) = unit(a0, a1);
                vec![d.cross(b0.sub(a0)) / l, d.cross(b1.sub(a0)) / l]
            }
            Constraint::Equal { a, b } => match (self.is_line(a), self.is_line(b)) {
                (true, true) => {
                    let (a0, a1) = self.line(c, a)?;
                    let (b0, b1) = self.line(c, b)?;
                    vec![a1.sub(a0).len() - b1.sub(b0).len()]
                }
                (false, false) => {
                    let (_, ra) = self.round(c, a)?;
                    let (_, rb) = self.round(c, b)?;
                    vec![ra - rb]
                }
                _ => {
                    return Err(Error::invalid(
                        "constraints",
                        format!("constraint {k}: equal needs two lines or two rounds"),
                    ));
                }
            },
            Constraint::Tangent { a, b } => {
                let (line, round) = match (self.is_line(a), self.is_line(b)) {
                    (true, false) => (Some(a), b),
                    (false, true) => (Some(b), a),
                    (false, false) => (None, b),
                    (true, true) => {
                        return Err(Error::invalid(
                            "constraints",
                            format!("constraint {k}: two lines can't be tangent"),
                        ));
                    }
                };
                if let Some(line) = line {
                    let (l0, l1) = self.line(c, line)?;
                    let (center, r) = self.round(c, round)?;
                    let (d, l) = unit(l0, l1);
                    vec![d.cross(center.sub(l0)) / l * sign - r]
                } else {
                    let (ca, ra) = self.round(c, a)?;
                    let (cb, rb) = self.round(c, b)?;
                    let d = cb.sub(ca).len();
                    // outside each other (sign 1) or one inside the other
                    vec![if sign > 0.0 {
                        d - (ra + rb)
                    } else {
                        d - (ra - rb).abs()
                    }]
                }
            }
            Constraint::Midpoint { point, line } => {
                let p = self.point(c, point);
                let (a, b) = self.line(c, line)?;
                vec![p.x * 2.0 - a.x - b.x, p.y * 2.0 - a.y - b.y]
            }
            Constraint::Concentric { a, b } => {
                let (ca, _) = self.round(c, a)?;
                let (cb, _) = self.round(c, b)?;
                vec![ca.x - cb.x, ca.y - cb.y]
            }
            Constraint::OnLine { point, line } => {
                let p = self.point(c, point);
                let (a, b) = self.line(c, line)?;
                let (d, l) = unit(a, b);
                vec![d.cross(p.sub(a)) / l]
            }
            Constraint::OnCircle { point, circle } => {
                let p = self.point(c, point);
                let (center, r) = self.round(c, circle)?;
                vec![p.sub(center).len() - r]
            }
            Constraint::Symmetric { a, b, line } => {
                let pa = self.point(c, a);
                let pb = self.point(c, b);
                let (l0, l1) = self.line(c, line)?;
                let (d, l) = unit(l0, l1);
                let mid = P {
                    x: (pa.x + pb.x) * 0.5,
                    y: (pa.y + pb.y) * 0.5,
                };
                vec![d.cross(mid.sub(l0)) / l, d.dot(pb.sub(pa)) / l]
            }
            Constraint::Distance { a, b, value } => {
                let (pa, pb) = (self.point(c, a), self.point(c, b));
                vec![pb.sub(pa).len() - value]
            }
            Constraint::HorizontalDistance { a, b, value } => {
                let (pa, pb) = (self.point(c, a), self.point(c, b));
                vec![(pb.x - pa.x) * sign - value]
            }
            Constraint::VerticalDistance { a, b, value } => {
                let (pa, pb) = (self.point(c, a), self.point(c, b));
                vec![(pb.y - pa.y) * sign - value]
            }
            Constraint::Length { line, value } => {
                let (a, b) = self.line(c, line)?;
                vec![b.sub(a).len() - value]
            }
            Constraint::Radius { circle, value } => {
                let (_, r) = self.round(c, circle)?;
                vec![r - value]
            }
            Constraint::Diameter { circle, value } => {
                let (_, r) = self.round(c, circle)?;
                vec![r * 2.0 - value]
            }
            Constraint::Angle { a, b, value } => {
                let (a0, a1) = self.line(c, a)?;
                let (b0, b1) = self.line(c, b)?;
                let (da, la) = unit(a0, a1);
                let (db, lb) = unit(b0, b1);
                let (s, co) = value.to_radians().m_sin_cos();
                // sin of the angle from a to b, less the one asked for
                vec![(da.cross(db) * co - da.dot(db) * s) / (la * lb)]
            }
            Constraint::LineDistance { point, line, value } => {
                let p = self.point(c, point);
                let (a, b) = self.line(c, line)?;
                let (d, l) = unit(a, b);
                vec![d.cross(p.sub(a)) / l * sign - value]
            }
        })
    }

    // built-in rows: an arc's end stays on its circle
    fn arc_rows(&self, e: usize, c: &mut Ctx<'_>) -> Vec<D> {
        let Some(Entity::Arc { center, start, end }) = self.s.entities.get(e).copied() else {
            return vec![];
        };
        let (cp, s, t) = (self.point(c, center), self.point(c, start), self.point(c, end));
        vec![t.sub(cp).len() - s.sub(cp).len()]
    }
}

fn find(p: &mut [usize], mut i: usize) -> usize {
    while p[i] != i {
        p[i] = p[p[i]];
        i = p[i];
    }
    i
}

fn check(s: &Sketch) -> Result<()> {
    let np = s.points.len();
    let point = |i: usize| -> Result<()> {
        if i < np {
            Ok(())
        } else {
            Err(Error::invalid("sketch", format!("point {i} is out of range")))
        }
    };
    for p in &s.points {
        if !p.iter().all(|v| v.is_finite()) {
            return Err(Error::invalid("points", "must be finite"));
        }
    }
    for e in &s.entities {
        match *e {
            Entity::Line { a, b } => {
                point(a)?;
                point(b)?;
            }
            Entity::Circle { center, radius } => {
                point(center)?;
                if !radius.is_finite() {
                    return Err(Error::invalid("entities", "a radius must be finite"));
                }
            }
            Entity::Arc { center, start, end } => {
                point(center)?;
                point(start)?;
                point(end)?;
            }
        }
    }
    for c in &s.constraints {
        match *c {
            Constraint::Fix { point: p }
            | Constraint::Midpoint { point: p, .. }
            | Constraint::OnLine { point: p, .. }
            | Constraint::OnCircle { point: p, .. }
            | Constraint::LineDistance { point: p, .. } => point(p)?,
            Constraint::Coincident { a, b }
            | Constraint::Symmetric { a, b, .. }
            | Constraint::Distance { a, b, .. }
            | Constraint::HorizontalDistance { a, b, .. }
            | Constraint::VerticalDistance { a, b, .. } => {
                point(a)?;
                point(b)?;
            }
            _ => {}
        }
    }
    Ok(())
}

fn layout(s: &Sketch) -> Layout {
    let n = s.points.len();
    let mut parent: Vec<usize> = (0..n).collect();
    for c in &s.constraints {
        if let Constraint::Coincident { a, b } = *c {
            let (ra, rb) = (find(&mut parent, a), find(&mut parent, b));
            if ra != rb {
                parent[ra.max(rb)] = ra.min(rb);
            }
        }
    }
    let rep = (0..n).map(|i| find(&mut parent, i)).collect();
    let mut count = 2 * n;
    let radius = s
        .entities
        .iter()
        .map(|e| {
            matches!(e, Entity::Circle { .. }).then(|| {
                count += 1;
                count - 1
            })
        })
        .collect();
    Layout { rep, radius, count }
}

/// Solves `sketch`, the dragged point pulled toward its target. The sketch comes back as it was when the
/// constraints can't all hold, with the ones to blame named.
#[allow(clippy::too_many_lines, reason = "one pass: layout, rows, groups, report")]
pub fn solve(sketch: &Sketch, drag: Option<Drag>) -> Result<Solved> {
    check(sketch)?;
    let l = layout(sketch);
    let mut x = vec![0.0; l.count];
    for (i, p) in sketch.points.iter().enumerate() {
        let r = l.rep[i];
        if r == i {
            x[2 * i] = p[0];
            x[2 * i + 1] = p[1];
        }
    }
    for (e, ent) in sketch.entities.iter().enumerate() {
        if let (Entity::Circle { radius, .. }, Some(k)) = (ent, l.radius[e]) {
            x[k] = *radius;
        }
    }
    let start = x.clone();
    // fixed parameters are not solved for
    let mut fixed = vec![false; l.count];
    for c in &sketch.constraints {
        if let Constraint::Fix { point } = *c {
            let r = l.rep[point];
            fixed[2 * r] = true;
            fixed[2 * r + 1] = true;
        }
    }
    let mut weight = vec![1.0; l.count];
    if let Some(d) = drag {
        let r = *l
            .rep
            .get(d.point)
            .ok_or_else(|| Error::invalid("drag", "point is out of range"))?;
        if !fixed[2 * r] && d.to.iter().all(|v| v.is_finite()) {
            x[2 * r] = d.to[0];
            x[2 * r + 1] = d.to[1];
            weight[2 * r] = 1e4;
            weight[2 * r + 1] = 1e4;
        }
    }
    let mut m = Model {
        s: sketch,
        l,
        sign: vec![],
    };
    m.sign = (0..sketch.constraints.len())
        .map(|k| side(&m, k, &start))
        .collect::<Result<_>>()?;
    // the rows, with the parameters each reads
    let mut rows: Vec<Row> = Vec::new();
    for k in 0..sketch.constraints.len() {
        let mut c = Ctx { x: &x, vars: vec![] };
        for nth in 0..m.residuals(k, &mut c)?.len() {
            rows.push(Row {
                src: Src::Constraint(k),
                nth,
                vars: c.vars.clone(),
            });
        }
    }
    for e in 0..sketch.entities.len() {
        let mut c = Ctx { x: &x, vars: vec![] };
        for nth in 0..m.arc_rows(e, &mut c).len() {
            rows.push(Row {
                src: Src::Arc(e),
                nth,
                vars: c.vars.clone(),
            });
        }
    }
    // independent groups of parameters solve on their own
    let mut parent: Vec<usize> = (0..m.l.count).collect();
    for r in &rows {
        for w in r.vars.windows(2) {
            let (a, b) = (find(&mut parent, w[0]), find(&mut parent, w[1]));
            if a != b {
                parent[a.max(b)] = a.min(b);
            }
        }
    }
    let used: Vec<bool> = {
        let mut u = vec![false; m.l.count];
        for (i, &r) in m.l.rep.iter().enumerate() {
            if r == i {
                u[2 * i] = true;
                u[2 * i + 1] = true;
            }
        }
        for k in m.l.radius.iter().flatten() {
            u[*k] = true;
        }
        u
    };
    let mut groups: std::collections::BTreeMap<usize, (Vec<usize>, Vec<usize>)> =
        std::collections::BTreeMap::new();
    for v in 0..m.l.count {
        if used[v] && !fixed[v] {
            groups.entry(find(&mut parent, v)).or_default().0.push(v);
        }
    }
    for (i, r) in rows.iter().enumerate() {
        if let Some(&v) = r.vars.iter().find(|&&v| !fixed[v]) {
            groups.entry(find(&mut parent, v)).or_default().1.push(i);
        }
    }
    let mut out = Report::default();
    let mut determined = fixed.clone();
    // a row on fixed points only holds or it doesn't
    let mut last = None;
    for r in rows.iter().filter(|r| r.vars.iter().all(|&v| fixed[v])) {
        if last == Some(r.src) {
            continue;
        }
        last = Some(r.src);
        let mut c = Ctx { x: &x, vars: vec![] };
        let vals = match r.src {
            Src::Constraint(k) => m.residuals(k, &mut c)?,
            Src::Arc(e) => m.arc_rows(e, &mut c),
        };
        let held = vals.iter().all(|v| v.v.abs() <= TOL * 10.0);
        if let Some(k) = r.of() {
            if held {
                out.dependent_met.push(k);
            } else {
                out.dependent_unmet.push(k);
            }
        }
        out.unmet |= !held;
    }
    for (vars, rs) in groups.values() {
        let g = Group {
            m: &m,
            rows: &rows,
            vars,
            idx: rs,
            weight: &weight,
        };
        g.solve(&mut x, &mut out, &mut determined);
    }
    let failed = out.unmet;
    if failed {
        x = start;
    }
    let mut conflicting: Vec<usize> = out.dependent_unmet.into_iter().collect();
    conflicting.sort_unstable();
    conflicting.dedup();
    let mut redundant: Vec<usize> = out
        .dependent_met
        .into_iter()
        .filter(|k| !conflicting.contains(k))
        .collect();
    redundant.sort_unstable();
    redundant.dedup();
    let status = if failed {
        if conflicting.is_empty() {
            Status::Failed
        } else {
            Status::Conflict
        }
    } else if redundant.is_empty() {
        Status::Ok
    } else {
        Status::Redundant
    };
    if failed && conflicting.is_empty() {
        conflicting = out.worst.into_iter().collect();
    }
    let points = (0..sketch.points.len())
        .map(|i| {
            let r = m.l.rep[i];
            [x[2 * r], x[2 * r + 1]]
        })
        .collect();
    let radii = sketch
        .entities
        .iter()
        .enumerate()
        .map(|(e, ent)| match *ent {
            Entity::Line { .. } => None,
            Entity::Circle { .. } => m.l.radius[e].map(|k| x[k]),
            Entity::Arc { center, start, .. } => {
                let (c, s) = (m.l.rep[center], m.l.rep[start]);
                Some((x[2 * s] - x[2 * c]).m_hypot(x[2 * s + 1] - x[2 * c + 1]))
            }
        })
        .collect();
    let free_points = (0..sketch.points.len())
        .map(|i| {
            let r = m.l.rep[i];
            !(determined[2 * r] && determined[2 * r + 1])
        })
        .collect();
    let free_radii = sketch
        .entities
        .iter()
        .enumerate()
        .map(|(e, ent)| match *ent {
            Entity::Line { .. } => false,
            Entity::Circle { .. } => m.l.radius[e].is_some_and(|k| !determined[k]),
            // an arc's radius is set once its center and start are
            Entity::Arc { center, start, .. } => {
                let (c, s) = (m.l.rep[center], m.l.rep[start]);
                ![2 * c, 2 * c + 1, 2 * s, 2 * s + 1]
                    .iter()
                    .all(|&k| determined[k])
            }
        })
        .collect();
    let dof = (0..m.l.count).filter(|&v| used[v] && !fixed[v]).count() - out.rank;
    Ok(Solved {
        status,
        points,
        radii,
        dof,
        free_points,
        free_radii,
        conflicting,
        redundant,
        iterations: out.iterations,
    })
}

// the side a constraint keeps, read from where the sketch starts
fn side(m: &Model<'_>, k: usize, x: &[f64]) -> Result<f64> {
    let s = |v: f64| if v < 0.0 { -1.0 } else { 1.0 };
    let mut c = Ctx { x, vars: vec![] };
    Ok(match m.s.constraints[k] {
        Constraint::Tangent { a, b } => match (m.is_line(a), m.is_line(b)) {
            (true, false) | (false, true) => {
                let (line, round) = if m.is_line(a) { (a, b) } else { (b, a) };
                let (l0, l1) = m.line(&mut c, line)?;
                let (center, _) = m.round(&mut c, round)?;
                s(l1.sub(l0).cross(center.sub(l0)).v)
            }
            _ => {
                let (ca, ra) = m.round(&mut c, a)?;
                let (cb, rb) = m.round(&mut c, b)?;
                let d = cb.sub(ca).len().v;
                // closer to touching from outside, or from inside
                if (d - (ra.v + rb.v)).abs() <= (d - (ra.v - rb.v).abs()).abs() {
                    1.0
                } else {
                    -1.0
                }
            }
        },
        Constraint::HorizontalDistance { a, b, .. } => {
            let (pa, pb) = (m.point(&mut c, a), m.point(&mut c, b));
            s(pb.x.v - pa.x.v)
        }
        Constraint::VerticalDistance { a, b, .. } => {
            let (pa, pb) = (m.point(&mut c, a), m.point(&mut c, b));
            s(pb.y.v - pa.y.v)
        }
        Constraint::LineDistance { point, line, .. } => {
            let p = m.point(&mut c, point);
            let (l0, l1) = m.line(&mut c, line)?;
            s(l1.sub(l0).cross(p.sub(l0)).v)
        }
        _ => 1.0,
    })
}

#[derive(Default)]
struct Report {
    rank: usize,
    iterations: usize,
    unmet: bool,
    dependent_met: Vec<usize>,
    dependent_unmet: Vec<usize>,
    worst: Option<usize>,
}

struct Group<'a> {
    m: &'a Model<'a>,
    rows: &'a [Row],
    vars: &'a [usize],
    idx: &'a [usize],
    weight: &'a [f64],
}

// the jacobian by rows: (column, value) for the few parameters each row reads
type Sparse = Vec<Vec<(usize, f64)>>;

// a row counts as repeating the ones before it when what it adds is this small, squared, against its own size
const DEPENDENT: f64 = 1e-12;

impl Group<'_> {
    // the residuals and the jacobian over this group's parameters, columns scaled by 1/sqrt(weight)
    fn eval(&self, x: &[f64], col: &[Option<usize>], weight: &[f64]) -> (Vec<f64>, Sparse) {
        let mut f = Vec::with_capacity(self.idx.len());
        let mut j = Vec::with_capacity(self.idx.len());
        let mut last: Option<(Src, Vec<D>, Vec<usize>)> = None;
        for &ri in self.idx {
            let r = &self.rows[ri];
            // rows of one constraint come together: evaluate it once
            if last.as_ref().is_none_or(|l| l.0 != r.src) {
                let mut c = Ctx { x, vars: vec![] };
                let v = match r.src {
                    Src::Constraint(k) => self.m.residuals(k, &mut c).unwrap_or_default(),
                    Src::Arc(e) => self.m.arc_rows(e, &mut c),
                };
                last = Some((r.src, v, c.vars));
            }
            let (v, vars) = match &last {
                Some((_, vals, vars)) => (vals.get(r.nth).copied().unwrap_or(D::c(0.0)), vars),
                None => continue,
            };
            f.push(v.v);
            j.push(
                vars.iter()
                    .enumerate()
                    .filter_map(|(k, &p)| col[p].map(|c| (c, v.d[k] / weight[p].sqrt())))
                    .filter(|e| e.1 != 0.0)
                    .collect(),
            );
        }
        (f, j)
    }

    fn solve(&self, x: &mut [f64], out: &mut Report, determined: &mut [bool]) {
        let n = self.vars.len();
        let mut col = vec![None; x.len()];
        for (c, &v) in self.vars.iter().enumerate() {
            col[v] = Some(c);
        }
        let (mut f, mut j) = self.eval(x, &col, self.weight);
        let norm = |f: &[f64]| f.iter().map(|v| v * v).sum::<f64>();
        let mut mu = 1e-3;
        let mut it = 0;
        while it < MAX_ITER && f.iter().any(|v| v.abs() > TOL) {
            it += 1;
            let before = norm(&f);
            let mut moved = false;
            // Newton first, then Levenberg-Marquardt with growing damping
            for damp in std::iter::once(0.0).chain((0..12).map(|i| mu * 10f64.m_powi(i))) {
                let dx = Gram::new(&j, n).factor(damp).step(&j, &f, n);
                let mut y = x.to_vec();
                for (c, &v) in self.vars.iter().enumerate() {
                    y[v] += dx[c] / self.weight[v].sqrt();
                }
                let (f2, j2) = self.eval(&y, &col, self.weight);
                if norm(&f2) < before {
                    x.copy_from_slice(&y);
                    (f, j) = (f2, j2);
                    if damp > 0.0 {
                        mu = (damp / 10.0).max(1e-9);
                    }
                    moved = true;
                    break;
                }
            }
            if !moved {
                break;
            }
        }
        out.iterations += it;
        let met = f.iter().all(|v| v.abs() <= TOL * 10.0);
        if !met {
            out.unmet = true;
            let worst = f
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
                .map(|(i, _)| i);
            out.worst = out
                .worst
                .or_else(|| worst.and_then(|i| self.rows[self.idx[i]].of()));
        }
        // rank, repeated rows and pinned parameters, unweighted, from where the solve ended
        let ones = vec![1.0; x.len()];
        let (_, j) = self.eval(x, &col, &ones);
        let g = Gram::new(&j, n).factor(0.0);
        for (i, &d) in g.dropped.iter().enumerate() {
            if let (true, Some(k)) = (d, self.rows[self.idx[i]].of()) {
                if met {
                    out.dependent_met.push(k);
                } else {
                    out.dependent_unmet.push(k);
                }
            }
        }
        out.rank += g.dropped.iter().filter(|d| !**d).count();
        // a parameter is pinned when its own direction lies in the rows' span
        let mut by_col: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];
        for (r, row) in j.iter().enumerate() {
            for &(c, v) in row {
                by_col[c].push((r, v));
            }
        }
        for (c, u) in by_col.iter().enumerate() {
            if u.is_empty() {
                continue;
            }
            let p = g.projected(u);
            if p >= 1.0 - 1e-6 {
                determined[self.vars[c]] = true;
            }
        }
    }
}

// J J^T in envelope form: each row stored from its first nonzero, which keeps a chain of constraints banded
struct Gram {
    m: usize,
    first: Vec<usize>,
    a: Vec<Vec<f64>>,
    size: Vec<f64>,
    dropped: Vec<bool>,
}

impl Gram {
    fn new(j: &Sparse, n: usize) -> Self {
        let m = j.len();
        let mut by_col: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];
        for (r, row) in j.iter().enumerate() {
            for &(c, v) in row {
                by_col[c].push((r, v));
            }
        }
        let first: Vec<usize> = (0..m)
            .map(|r| {
                j[r].iter()
                    .filter_map(|&(c, _)| by_col[c].first().map(|e| e.0))
                    .min()
                    .unwrap_or(r)
                    .min(r)
            })
            .collect();
        let mut a: Vec<Vec<f64>> = (0..m).map(|r| vec![0.0; r - first[r] + 1]).collect();
        for (r, row) in j.iter().enumerate() {
            for &(c, v) in row {
                for &(s, w) in &by_col[c] {
                    if s > r {
                        break;
                    }
                    a[r][s - first[r]] += v * w;
                }
            }
        }
        let size = (0..m).map(|r| a[r][r - first[r]]).collect();
        Self {
            m,
            first,
            a,
            size,
            dropped: vec![false; m],
        }
    }

    fn at(&self, r: usize, s: usize) -> f64 {
        if s < self.first[r] {
            0.0
        } else {
            self.a[r][s - self.first[r]]
        }
    }

    // cholesky in place, damping added to the diagonal; a row that adds nothing new is dropped
    fn factor(mut self, damp: f64) -> Self {
        let scale = self.size.iter().fold(0.0f64, |a, &v| a.max(v)).max(1e-300);
        let add = damp * scale;
        for r in 0..self.m {
            let fr = self.first[r];
            for s in fr..=r {
                if s < r && self.dropped[s] {
                    self.a[r][s - fr] = 0.0;
                    continue;
                }
                let lo = fr.max(self.first[s]);
                let mut v = self.a[r][s - fr];
                for k in lo..s {
                    v -= self.a[r][k - fr] * self.at(s, k);
                }
                if s < r {
                    self.a[r][s - fr] = v / self.a[s][s - self.first[s]];
                } else {
                    v += add;
                    if v <= DEPENDENT * (self.size[r] + add) || self.size[r] == 0.0 {
                        self.dropped[r] = true;
                        self.a[r].iter_mut().for_each(|x| *x = 0.0);
                        self.a[r][r - fr] = 1.0;
                    } else {
                        self.a[r][r - fr] = v.sqrt();
                    }
                }
            }
        }
        self
    }

    // L y = b, dropped rows left at zero
    fn forward(&self, b: &mut [f64], from: usize) {
        for r in from..self.m {
            if self.dropped[r] {
                b[r] = 0.0;
                continue;
            }
            let fr = self.first[r].max(from);
            let v = b[r] - (fr..r).map(|k| self.at(r, k) * b[k]).sum::<f64>();
            b[r] = v / self.at(r, r);
        }
    }

    // the least-change step dx = J^T (J J^T + damp)^-1 (-F)
    fn step(&self, j: &Sparse, f: &[f64], n: usize) -> Vec<f64> {
        let mut y: Vec<f64> = f.iter().map(|v| -v).collect();
        self.forward(&mut y, 0);
        for r in (0..self.m).rev() {
            if self.dropped[r] {
                y[r] = 0.0;
                continue;
            }
            y[r] /= self.at(r, r);
            let fr = self.first[r];
            for k in fr..r {
                y[k] -= self.a[r][k - fr] * y[r];
            }
        }
        let mut dx = vec![0.0; n];
        for (r, row) in j.iter().enumerate() {
            for &(c, v) in row {
                dx[c] += v * y[r];
            }
        }
        if dx.iter().all(|v| v.is_finite()) {
            dx
        } else {
            vec![0.0; n]
        }
    }

    // |L^-1 u|^2 for the jacobian column u of a parameter: the share of its direction the rows span, 1 when they pin it
    fn projected(&self, u: &[(usize, f64)]) -> f64 {
        let mut b = vec![0.0; self.m];
        for &(r, v) in u {
            b[r] = v;
        }
        let from = u.iter().map(|e| e.0).min().unwrap_or(0);
        self.forward(&mut b, from);
        b.iter().map(|v| v * v).sum::<f64>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Constraint as C;

    fn lines(pairs: &[(usize, usize)]) -> Vec<Entity> {
        pairs.iter().map(|&(a, b)| Entity::Line { a, b }).collect()
    }

    fn near(a: [f64; 2], b: [f64; 2]) -> bool {
        (a[0] - b[0]).m_hypot(a[1] - b[1]) < 1e-6
    }

    // a rough quad, closed by its point indices
    fn quad() -> Sketch {
        Sketch {
            points: vec![[0.0, 0.0], [9.0, 1.0], [11.0, 9.0], [1.0, 11.0]],
            entities: lines(&[(0, 1), (1, 2), (2, 3), (3, 0)]),
            constraints: vec![],
        }
    }

    fn square() -> Sketch {
        let mut s = quad();
        s.constraints = vec![
            C::Fix { point: 0 },
            C::Horizontal { line: 0 },
            C::Vertical { line: 1 },
            C::Horizontal { line: 2 },
            C::Vertical { line: 3 },
            C::Length { line: 0, value: 10.0 },
            C::Equal { a: 0, b: 1 },
        ];
        s
    }

    #[test]
    fn a_square_is_fully_defined() {
        let r = solve(&square(), None).unwrap();
        assert_eq!(r.status, Status::Ok);
        assert_eq!(r.dof, 0);
        assert!(r.free_points.iter().all(|f| !f), "{:?}", r.free_points);
        for (p, want) in r
            .points
            .iter()
            .zip([[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]])
        {
            assert!(near(*p, want), "{p:?} {want:?}");
        }
    }

    #[test]
    fn dof_counts_what_is_left() {
        let mut s = quad();
        assert_eq!(solve(&s, None).unwrap().dof, 8);
        s.constraints = vec![C::Fix { point: 0 }, C::Horizontal { line: 0 }];
        let r = solve(&s, None).unwrap();
        assert_eq!(r.dof, 5);
        assert_eq!(r.free_points, vec![false, true, true, true]);
        // a fixed start, a horizontal line of set length: its end is pinned too
        s.constraints.push(C::Length { line: 0, value: 4.0 });
        let r = solve(&s, None).unwrap();
        assert_eq!(r.dof, 4);
        assert_eq!(r.free_points, vec![false, false, true, true]);
        assert!(near(r.points[1], [4.0, 0.0]), "{:?}", r.points[1]);
    }

    #[test]
    fn dof_table() {
        let line = || lines(&[(0, 1)]);
        let two = vec![[0.0, 0.0], [10.0, 0.5]];
        let three = vec![[0.0, 0.0], [5.0, 0.0], [0.0, 5.0]];
        let cases: Vec<(&str, Sketch, usize)> = vec![
            (
                "a free point",
                Sketch {
                    points: vec![[1.0, 2.0]],
                    ..Sketch::default()
                },
                2,
            ),
            (
                "a free line",
                Sketch {
                    points: two.clone(),
                    entities: line(),
                    constraints: vec![],
                },
                4,
            ),
            (
                "a horizontal line",
                Sketch {
                    points: two.clone(),
                    entities: line(),
                    constraints: vec![C::Horizontal { line: 0 }],
                },
                3,
            ),
            (
                "a horizontal line with fixed ends",
                Sketch {
                    points: vec![[0.0, 0.0], [10.0, 0.0]],
                    entities: line(),
                    constraints: vec![
                        C::Fix { point: 0 },
                        C::Fix { point: 1 },
                        C::Horizontal { line: 0 },
                    ],
                },
                0,
            ),
            (
                "a free circle",
                Sketch {
                    points: vec![[0.0, 0.0]],
                    entities: vec![Entity::Circle {
                        center: 0,
                        radius: 2.0,
                    }],
                    constraints: vec![],
                },
                3,
            ),
            (
                "a circle on a fixed center",
                Sketch {
                    points: vec![[0.0, 0.0]],
                    entities: vec![Entity::Circle {
                        center: 0,
                        radius: 2.0,
                    }],
                    constraints: vec![C::Fix { point: 0 }],
                },
                1,
            ),
            (
                "a free arc",
                Sketch {
                    points: three.clone(),
                    entities: vec![Entity::Arc {
                        center: 0,
                        start: 1,
                        end: 2,
                    }],
                    constraints: vec![],
                },
                5,
            ),
        ];
        for (what, s, dof) in cases {
            assert_eq!(solve(&s, None).unwrap().dof, dof, "{what}");
        }
    }

    #[test]
    fn a_repeated_constraint_is_named() {
        let mut s = square();
        s.constraints.push(C::Parallel { a: 0, b: 2 });
        let r = solve(&s, None).unwrap();
        assert_eq!(r.status, Status::Redundant);
        assert_eq!(r.redundant, vec![7]);
        assert_eq!(r.dof, 0);
    }

    #[test]
    fn a_conflict_leaves_the_sketch_as_it_was() {
        let mut s = square();
        s.constraints.push(C::Length { line: 1, value: 12.0 });
        let r = solve(&s, None).unwrap();
        assert_eq!(r.status, Status::Conflict);
        assert_eq!(r.conflicting, vec![7]);
        assert_eq!(r.points, s.points);
    }

    #[test]
    fn fixed_points_take_no_dimension() {
        let s = |value: f64| Sketch {
            points: vec![[0.0, 0.0], [3.0, 4.0]],
            entities: lines(&[(0, 1)]),
            constraints: vec![
                C::Fix { point: 0 },
                C::Fix { point: 1 },
                C::Length { line: 0, value },
            ],
        };
        // the length they already have says it again; another one can't hold
        let r = solve(&s(5.0), None).unwrap();
        assert_eq!(
            (r.status, r.redundant.clone(), r.dof),
            (Status::Redundant, vec![2], 0)
        );
        let r = solve(&s(6.0), None).unwrap();
        assert_eq!((r.status, r.conflicting.clone()), (Status::Conflict, vec![2]));
    }

    #[test]
    fn under_over_and_repeated_on_one_circle() {
        let circle = |constraints: Vec<Constraint>| Sketch {
            points: vec![[1.0, 1.0]],
            entities: vec![Entity::Circle {
                center: 0,
                radius: 2.0,
            }],
            constraints,
        };
        let r = solve(
            &circle(vec![C::Radius {
                circle: 0,
                value: 3.0,
            }]),
            None,
        )
        .unwrap();
        assert_eq!(
            (r.status, r.dof, r.free_points.clone(), r.free_radii.clone()),
            (Status::Ok, 2, vec![true], vec![false])
        );
        let r = solve(
            &circle(vec![
                C::Radius {
                    circle: 0,
                    value: 3.0,
                },
                C::Diameter {
                    circle: 0,
                    value: 6.0,
                },
            ]),
            None,
        )
        .unwrap();
        assert_eq!((r.status, r.redundant.clone()), (Status::Redundant, vec![1]));
        let over = circle(vec![
            C::Radius {
                circle: 0,
                value: 3.0,
            },
            C::Diameter {
                circle: 0,
                value: 8.0,
            },
        ]);
        let r = solve(&over, None).unwrap();
        assert_eq!((r.status, r.conflicting.clone()), (Status::Conflict, vec![1]));
        assert_eq!(r.points, over.points);
        assert_eq!(r.radii, vec![Some(2.0)]);
    }

    #[test]
    fn coincident_points_move_as_one() {
        // two separate lines joined end to end by a constraint
        let s = Sketch {
            points: vec![[0.0, 0.0], [5.0, 0.3], [5.2, 0.1], [5.0, 6.0]],
            entities: lines(&[(0, 1), (2, 3)]),
            constraints: vec![
                C::Fix { point: 0 },
                C::Coincident { a: 1, b: 2 },
                C::Horizontal { line: 0 },
                C::Perpendicular { a: 0, b: 1 },
                C::Length { line: 0, value: 5.0 },
                C::Length { line: 1, value: 6.0 },
            ],
        };
        let r = solve(&s, None).unwrap();
        assert_eq!(r.status, Status::Ok);
        assert_eq!(r.dof, 0);
        assert!(near(r.points[1], r.points[2]));
        assert!(near(r.points[3], [5.0, 6.0]), "{:?}", r.points[3]);
    }

    #[test]
    fn a_line_tangent_to_a_circle() {
        let s = Sketch {
            points: vec![[0.0, 0.0], [-10.0, 4.0], [10.0, 4.5]],
            entities: vec![
                Entity::Circle {
                    center: 0,
                    radius: 4.0,
                },
                Entity::Line { a: 1, b: 2 },
            ],
            constraints: vec![
                C::Fix { point: 0 },
                C::Radius {
                    circle: 0,
                    value: 5.0,
                },
                C::Tangent { a: 1, b: 0 },
                C::Horizontal { line: 1 },
            ],
        };
        let r = solve(&s, None).unwrap();
        assert_eq!(r.status, Status::Ok);
        assert!((r.radii[0].unwrap() - 5.0).abs() < 1e-9);
        // it stays on the side it started on
        assert!(
            (r.points[1][1] - 5.0).abs() < 1e-6 && (r.points[2][1] - 5.0).abs() < 1e-6,
            "{:?}",
            r.points
        );
        assert!(!r.free_radii[0]);
    }

    #[test]
    fn two_circles_touch_outside_or_inside() {
        let s = |inside: bool| Sketch {
            points: vec![[0.0, 0.0], [if inside { 1.0 } else { 9.0 }, 0.0]],
            entities: vec![
                Entity::Circle {
                    center: 0,
                    radius: 5.0,
                },
                Entity::Circle {
                    center: 1,
                    radius: 3.0,
                },
            ],
            constraints: vec![
                C::Fix { point: 0 },
                C::Radius {
                    circle: 0,
                    value: 5.0,
                },
                C::Radius {
                    circle: 1,
                    value: 3.0,
                },
                C::Tangent { a: 0, b: 1 },
            ],
        };
        for (inside, want) in [(false, 8.0), (true, 2.0)] {
            let r = solve(&s(inside), None).unwrap();
            assert_eq!(r.status, Status::Ok);
            assert!(
                (r.points[1][0].m_hypot(r.points[1][1]) - want).abs() < 1e-6,
                "{inside} {:?}",
                r.points[1]
            );
            assert_eq!(r.dof, 1, "the small circle can still roll round");
        }
    }

    #[test]
    fn an_arc_keeps_its_end_on_its_circle() {
        let s = Sketch {
            points: vec![[0.0, 0.0], [5.0, 0.0], [0.0, 4.0]],
            entities: vec![Entity::Arc {
                center: 0,
                start: 1,
                end: 2,
            }],
            constraints: vec![
                C::Fix { point: 0 },
                C::Radius {
                    circle: 0,
                    value: 6.0,
                },
            ],
        };
        let r = solve(&s, None).unwrap();
        assert_eq!(r.status, Status::Ok);
        for p in &r.points[1..] {
            assert!((p[0].m_hypot(p[1]) - 6.0).abs() < 1e-6, "{p:?}");
        }
        // two angles left
        assert_eq!(r.dof, 2);
    }

    #[test]
    fn angles_midpoints_and_symmetry() {
        let s = Sketch {
            points: vec![
                [0.0, 0.0],
                [10.0, 0.0],
                [0.0, 0.0],
                [7.0, 5.0],
                [5.2, 0.3],
                [2.0, 3.0],
                [8.0, 2.0],
            ],
            entities: lines(&[(0, 1), (2, 3)]),
            constraints: vec![
                C::Fix { point: 0 },
                C::Horizontal { line: 0 },
                C::Length { line: 0, value: 10.0 },
                C::Coincident { a: 0, b: 2 },
                C::Angle {
                    a: 0,
                    b: 1,
                    value: 30.0,
                },
                C::Length { line: 1, value: 8.0 },
                C::Midpoint { point: 4, line: 0 },
                C::Symmetric { a: 5, b: 6, line: 1 },
            ],
        };
        let r = solve(&s, None).unwrap();
        assert_eq!(r.status, Status::Ok);
        let (sn, cs) = 30f64.to_radians().m_sin_cos();
        assert!(near(r.points[3], [8.0 * cs, 8.0 * sn]), "{:?}", r.points[3]);
        assert!(near(r.points[4], [5.0, 0.0]));
        // mirrored across the 30 degree line: midpoint on it, the pair square to it
        let (a, b) = (r.points[5], r.points[6]);
        let mid = [f64::midpoint(a[0], b[0]), f64::midpoint(a[1], b[1])];
        assert!((mid[0] * sn - mid[1] * cs).abs() < 1e-6);
        assert!(((b[0] - a[0]) * cs + (b[1] - a[1]) * sn).abs() < 1e-6);
        // the mirrored pair keeps two of its four
        assert_eq!(r.dof, 2);
    }

    #[test]
    fn a_dragged_point_goes_where_the_constraints_let_it() {
        // a fixed pivot, a rod of length 10: the end follows the cursor round the circle
        let s = Sketch {
            points: vec![[0.0, 0.0], [10.0, 0.0]],
            entities: lines(&[(0, 1)]),
            constraints: vec![C::Fix { point: 0 }, C::Length { line: 0, value: 10.0 }],
        };
        let r = solve(
            &s,
            Some(Drag {
                point: 1,
                to: [0.0, 20.0],
            }),
        )
        .unwrap();
        assert_eq!(r.status, Status::Ok);
        assert!(near(r.points[1], [0.0, 10.0]), "{:?}", r.points[1]);
        // the free end of a free line goes right to the cursor and the other end stays
        let s = Sketch {
            points: vec![[0.0, 0.0], [10.0, 0.0]],
            entities: lines(&[(0, 1)]),
            constraints: vec![C::Horizontal { line: 0 }],
        };
        let r = solve(
            &s,
            Some(Drag {
                point: 1,
                to: [12.0, 3.0],
            }),
        )
        .unwrap();
        let p = r.points[1];
        assert!((p[0] - 12.0).abs() < 1e-3 && (p[1] - 3.0).abs() < 1e-3, "{p:?}");
        assert!(
            (r.points[0][1] - 3.0).abs() < 1e-3 && r.points[0][0].abs() < 1e-3,
            "{:?}",
            r.points[0]
        );
    }

    #[test]
    fn distances_keep_their_side() {
        let s = Sketch {
            points: vec![[0.0, 0.0], [10.0, 0.0], [3.0, -2.0], [7.0, 4.0]],
            entities: lines(&[(0, 1)]),
            constraints: vec![
                C::Fix { point: 0 },
                C::Fix { point: 1 },
                C::LineDistance {
                    point: 2,
                    line: 0,
                    value: 5.0,
                },
                C::HorizontalDistance {
                    a: 3,
                    b: 2,
                    value: 6.0,
                },
                C::VerticalDistance {
                    a: 0,
                    b: 3,
                    value: 1.0,
                },
                C::Distance {
                    a: 0,
                    b: 2,
                    value: 13.0,
                },
            ],
        };
        let r = solve(&s, None).unwrap();
        assert_eq!(r.status, Status::Ok);
        let (p, q) = (r.points[2], r.points[3]);
        assert!(near(p, [12.0, -5.0]), "{p:?}");
        assert!(near(q, [18.0, 1.0]), "{q:?}");
        assert_eq!(r.dof, 0);
    }

    #[test]
    fn concentric_on_circle_and_diameter() {
        let s = Sketch {
            points: vec![[0.0, 0.0], [0.5, 0.2], [3.0, 3.0]],
            entities: vec![
                Entity::Circle {
                    center: 0,
                    radius: 3.0,
                },
                Entity::Circle {
                    center: 1,
                    radius: 1.0,
                },
            ],
            constraints: vec![
                C::Fix { point: 0 },
                C::Concentric { a: 0, b: 1 },
                C::Diameter {
                    circle: 0,
                    value: 8.0,
                },
                C::Equal { a: 0, b: 1 },
                C::OnCircle { point: 2, circle: 1 },
            ],
        };
        let r = solve(&s, None).unwrap();
        assert_eq!(r.status, Status::Ok);
        assert!(near(r.points[1], [0.0, 0.0]));
        assert!((r.radii[1].unwrap() - 4.0).abs() < 1e-9);
        assert!((r.points[2][0].m_hypot(r.points[2][1]) - 4.0).abs() < 1e-6);
        assert_eq!(r.dof, 1);
        assert_eq!(r.free_points, vec![false, false, true]);
    }

    #[test]
    fn collinear_and_on_line() {
        let s = Sketch {
            points: vec![[0.0, 0.0], [10.0, 0.0], [12.0, 1.0], [20.0, -1.0], [5.0, 3.0]],
            entities: lines(&[(0, 1), (2, 3)]),
            constraints: vec![
                C::Fix { point: 0 },
                C::Fix { point: 1 },
                C::Collinear { a: 0, b: 1 },
                C::OnLine { point: 4, line: 0 },
            ],
        };
        let r = solve(&s, None).unwrap();
        assert_eq!(r.status, Status::Ok);
        for p in &r.points[2..] {
            assert!(p[1].abs() < 1e-6, "{p:?}");
        }
        assert_eq!(r.dof, 3);
    }

    #[test]
    fn bad_indices_are_refused() {
        let s = Sketch {
            points: vec![[0.0, 0.0]],
            entities: lines(&[(0, 3)]),
            constraints: vec![],
        };
        assert!(solve(&s, None).unwrap_err().to_string().contains("point 3"));
        let s = Sketch {
            points: vec![[0.0, 0.0], [1.0, 0.0]],
            entities: lines(&[(0, 1)]),
            constraints: vec![C::Radius {
                circle: 0,
                value: 2.0,
            }],
        };
        assert!(solve(&s, None).is_err());
    }

    // a stepped profile of 100 lines held to dimension: every line horizontal or vertical with a length
    fn stairs(n: usize) -> Sketch {
        let mut s = Sketch::default();
        let (mut x, mut y) = (0.0, 0.0);
        s.points.push([x, y]);
        for i in 0..n {
            // drawn by hand: a little off square, a little off length
            let wob = 0.3 * ((i * 7 % 5) as f64 - 2.0) / 2.0;
            if i % 2 == 0 {
                x += 5.0 + wob;
                y += 0.2 * wob;
            } else {
                x += 0.2 * wob;
                y += 3.0 - wob;
            }
            s.points.push([x, y]);
            s.entities.push(Entity::Line { a: i, b: i + 1 });
            s.constraints.push(if i % 2 == 0 {
                C::Horizontal { line: i }
            } else {
                C::Vertical { line: i }
            });
            s.constraints.push(C::Length {
                line: i,
                value: if i % 2 == 0 { 5.0 } else { 3.0 },
            });
        }
        s.constraints.push(C::Fix { point: 0 });
        s
    }

    #[test]
    fn a_hundred_lines_solve_in_two_ms() {
        let s = stairs(100);
        let r = solve(&s, None).unwrap();
        assert_eq!(r.status, Status::Ok);
        assert_eq!(r.dof, 0);
        assert!(near(r.points[100], [250.0, 150.0]), "{:?}", r.points[100]);
        // timed in release builds only
        if cfg!(debug_assertions) {
            return;
        }
        let runs = 50;
        let t = std::time::Instant::now();
        for _ in 0..runs {
            std::hint::black_box(solve(std::hint::black_box(&s), None).unwrap());
        }
        let ms = t.elapsed().as_secs_f64() * 1e3 / f64::from(runs);
        assert!(ms < 2.0, "{ms:.3} ms a solve");
    }
}
