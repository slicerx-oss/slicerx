// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! fillet and chamfer on sketch corners, before extruding
// corner and segment indices are checked against the resolved loops
#![allow(clippy::indexing_slicing)]

use crate::error::{Error, Result};
use crate::fm::Fm;
use crate::sketch::{self, Loop, Prim, Segment};
use crate::vec3::V2;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const MAX_MM: f64 = 1000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CornerRef {
    #[serde(rename = "loop")]
    pub loop_index: usize,
    pub vertex: usize,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CornerCut {
    Fillet(f64),
    Chamfer(f64, f64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Added {
    #[serde(rename = "loop")]
    pub loop_index: usize,
    pub segment: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CornerResult {
    pub loops: Vec<Loop>,
    pub added: Vec<Added>,
}

fn sub(a: V2, b: V2) -> V2 {
    [a[0] - b[0], a[1] - b[1]]
}

fn unit(a: V2) -> V2 {
    let l = a[0].m_hypot(a[1]);
    [a[0] / l, a[1] / l]
}

fn along(p: V2, d: V2, s: f64) -> V2 {
    [p[0] + d[0] * s, p[1] + d[1] * s]
}

fn check(what: &'static str, v: f64) -> Result<f64> {
    if v.is_finite() && v > 0.0 && v <= MAX_MM {
        Ok(v)
    } else {
        Err(Error::invalid(what, "must be above 0 (at most 1000 mm)"))
    }
}

fn line(to: V2) -> Segment {
    Segment {
        kind: "line".into(),
        to: Some(to),
        ..Segment::default()
    }
}

struct Plan {
    request: usize,
    t_in: V2,
    t_out: V2,
    piece: Segment,
}

#[allow(clippy::too_many_lines, reason = "checks and the rewrite in one pass")]
pub fn corners(loops: &[Loop], corners: &[CornerRef], cut: CornerCut) -> Result<CornerResult> {
    let cut = match cut {
        CornerCut::Fillet(r) => CornerCut::Fillet(check("radiusMm", r)?),
        CornerCut::Chamfer(a, b) => CornerCut::Chamfer(check("distanceMm", a)?, check("distance2Mm", b)?),
    };
    if corners.is_empty() {
        return Err(Error::invalid("corners", "pick at least one corner"));
    }
    let mut by_loop: BTreeMap<usize, Vec<(usize, usize)>> = BTreeMap::new();
    for (i, c) in corners.iter().enumerate() {
        let list = by_loop.entry(c.loop_index).or_default();
        if list.iter().any(|&(_, v)| v == c.vertex) {
            return Err(Error::invalid(
                "corners",
                format!(
                    "corner {} of loop {} is listed twice",
                    c.vertex + 1,
                    c.loop_index + 1
                ),
            ));
        }
        list.push((i, c.vertex));
    }
    let mut out = loops.to_vec();
    let mut added = vec![
        Added {
            loop_index: 0,
            segment: 0
        };
        corners.len()
    ];
    for (&l, picks) in &by_loop {
        let Some(lp) = loops.get(l) else {
            return Err(Error::invalid("corners", format!("there is no loop {}", l + 1)));
        };
        let (start, prims) = sketch::resolve(l, lp).map_err(|i| Error::invalid("loops", i.message))?;
        let n = prims.len();
        let starts: Vec<V2> = (0..n)
            .map(|i| if i == 0 { start } else { prims[i - 1].to() })
            .collect();
        let is_line = |i: usize| matches!(prims[i], Prim::Line { .. });
        let mut trim = vec![[0.0f64; 2]; n];
        let mut plans = BTreeMap::new();
        let mut turns = BTreeMap::new();
        for &(req, v) in picks {
            let name = format!("corner {} of loop {}", v + 1, l + 1);
            if v >= n {
                return Err(Error::invalid(
                    "corners",
                    format!("loop {} has no corner {}", l + 1, v + 1),
                ));
            }
            let pv = (v + n - 1) % n;
            if !is_line(pv) || !is_line(v) {
                return Err(Error::invalid(
                    "corners",
                    format!("{name} is not between two straight lines"),
                ));
            }
            let p = starts[v];
            let d_in = unit(sub(p, starts[pv]));
            let d_out = unit(sub(prims[v].to(), p));
            let cross = d_in[0] * d_out[1] - d_in[1] * d_out[0];
            let dot = d_in[0] * d_out[0] + d_in[1] * d_out[1];
            let theta = cross.m_atan2(dot);
            if theta.abs() < 1e-9 {
                return Err(Error::invalid("corners", format!("{name} is straight")));
            }
            let (s_in, s_out) = match cut {
                CornerCut::Fillet(r) => {
                    let s = r * (theta.abs() * 0.5).m_tan();
                    (s, s)
                }
                CornerCut::Chamfer(a, b) => (a, b),
            };
            trim[pv][1] = s_in;
            trim[v][0] = s_out;
            let t_in = along(p, d_in, -s_in);
            let t_out = along(p, d_out, s_out);
            let piece = match cut {
                CornerCut::Fillet(r) => {
                    let k = r.copysign(theta);
                    let center = [t_in[0] - d_in[1] * k, t_in[1] + d_in[0] * k];
                    Segment {
                        kind: "arc".into(),
                        center: Some(center),
                        sweep_deg: Some(theta.to_degrees()),
                        ..Segment::default()
                    }
                }
                CornerCut::Chamfer(..) => line(t_out),
            };
            turns.insert(v, (theta, name, pv));
            plans.insert(
                v,
                Plan {
                    request: req,
                    t_in,
                    t_out,
                    piece,
                },
            );
        }
        let lens: Vec<f64> = (0..n)
            .map(|i| {
                let d = sub(prims[i].to(), starts[i]);
                d[0].m_hypot(d[1])
            })
            .collect();
        for (&v, &(theta, ref name, pv)) in &turns {
            let ok_in = trim[pv][0] + trim[pv][1] <= lens[pv] + 1e-9;
            let ok_out = trim[v][0] + trim[v][1] <= lens[v] + 1e-9;
            if ok_in && ok_out {
                continue;
            }
            let room_in = (lens[pv] - trim[pv][0]).max(0.0);
            let room_out = (lens[v] - trim[v][1]).max(0.0);
            return Err(match cut {
                CornerCut::Fillet(r) => {
                    let max = room_in.min(room_out) / (theta.abs() * 0.5).m_tan();
                    Error::invalid(
                        "radiusMm",
                        format!("{r} mm does not fit at {name}; at most {max:.3} mm"),
                    )
                }
                CornerCut::Chamfer(a, b) => {
                    if ok_in {
                        Error::invalid(
                            "distance2Mm",
                            format!("{b} mm does not fit at {name}; at most {room_out:.3} mm"),
                        )
                    } else {
                        Error::invalid(
                            "distanceMm",
                            format!("{a} mm does not fit at {name}; at most {room_in:.3} mm"),
                        )
                    }
                }
            });
        }
        let new_start = plans.get(&0).map_or(start, |p| p.t_out);
        let mut segs = Vec::new();
        for (i, prim) in prims.iter().enumerate() {
            if let Some(p) = plans.get(&i).filter(|_| i != 0) {
                added[p.request] = Added {
                    loop_index: l,
                    segment: segs.len(),
                };
                segs.push(p.piece.clone());
            }
            let next = (i + 1) % n;
            match *prim {
                Prim::Line { to } => {
                    let end = match plans.get(&next) {
                        Some(p) => p.t_in,
                        None if next == 0 => start,
                        None => to,
                    };
                    segs.push(line(end));
                }
                Prim::Arc { .. } => segs.push(lp.segments[i].clone()),
            }
        }
        if let Some(p) = plans.get(&0) {
            added[p.request] = Added {
                loop_index: l,
                segment: segs.len(),
            };
            segs.push(p.piece.clone());
        }
        out[l] = Loop {
            start: Some(new_start),
            segments: segs,
            ..Loop::default()
        };
    }
    Ok(CornerResult { loops: out, added })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    fn square(s: f64) -> Loop {
        Loop {
            points: vec![[0.0, 0.0], [s, 0.0], [s, s], [0.0, s]],
            ..Loop::default()
        }
    }

    fn at(l: usize, v: usize) -> CornerRef {
        CornerRef {
            loop_index: l,
            vertex: v,
        }
    }

    fn area(loops: &[Loop]) -> f64 {
        let c = sketch::check(loops);
        assert!(c.ok, "{:?}", c.issues);
        c.area_mm2
    }

    #[test]
    fn rounded_square() {
        let all: Vec<_> = (0..4).map(|v| at(0, v)).collect();
        let r = corners(&[square(20.0)], &all, CornerCut::Fillet(3.0)).unwrap();
        let exact = 400.0 - 4.0 * 9.0 * (1.0 - PI / 4.0);
        let a = area(&r.loops);
        assert!((a - exact).abs() < 0.1, "{a} vs {exact}");
        assert_eq!(r.loops[0].segments.len(), 8);
        let s = r.loops[0].start.unwrap();
        assert!((s[0] - 3.0).abs() < 1e-12 && s[1].abs() < 1e-12);
        assert_eq!(r.added[0].segment, 7);
        assert_eq!(r.added[1].segment, 1);
        assert_eq!(r.loops[0].segments[1].kind, "arc");
        let r = corners(&[square(20.0)], &all, CornerCut::Chamfer(2.0, 2.0)).unwrap();
        assert!((area(&r.loops) - (400.0 - 8.0)).abs() < 1e-9);
    }

    #[test]
    fn clockwise_and_mixed_loops() {
        let l = Loop {
            start: Some([0.0, 0.0]),
            segments: vec![
                Segment {
                    kind: "line".into(),
                    length_mm: Some(10.0),
                    angle_deg: Some(90.0),
                    ..Segment::default()
                },
                line([10.0, 10.0]),
                line([10.0, 5.0]),
                Segment {
                    kind: "arc".into(),
                    center: Some([10.0, 2.5]),
                    sweep_deg: Some(-180.0),
                    ..Segment::default()
                },
                line([0.0, 0.0]),
            ],
            ..Loop::default()
        };
        let r = corners(
            std::slice::from_ref(&l),
            &[at(0, 1), at(0, 0)],
            CornerCut::Fillet(2.0),
        )
        .unwrap();
        let before = area(std::slice::from_ref(&l));
        let a = area(&r.loops);
        let cut = 2.0 * 4.0 * (1.0 - PI / 4.0);
        assert!((before - a - cut).abs() < 0.05, "{before} {a}");
        assert!(r.loops[0].segments.iter().any(|s| s.center == Some([10.0, 2.5])));
        let err = corners(std::slice::from_ref(&l), &[at(0, 3)], CornerCut::Fillet(1.0))
            .unwrap_err()
            .to_string();
        assert_eq!(
            err,
            "corners: corner 4 of loop 1 is not between two straight lines"
        );
        let err = corners(&[l], &[at(0, 9)], CornerCut::Fillet(1.0))
            .unwrap_err()
            .to_string();
        assert_eq!(err, "corners: loop 1 has no corner 10");
    }

    #[test]
    fn too_big_fails_in_words() {
        let err = corners(&[square(10.0)], &[at(0, 1)], CornerCut::Fillet(11.0))
            .unwrap_err()
            .to_string();
        assert_eq!(
            err,
            "radiusMm: 11 mm does not fit at corner 2 of loop 1; at most 10.000 mm"
        );
        let err = corners(&[square(10.0)], &[at(0, 1), at(0, 2)], CornerCut::Fillet(6.0))
            .unwrap_err()
            .to_string();
        assert!(err.contains("at most 4.000 mm"), "{err}");
        assert!(corners(&[square(10.0)], &[at(0, 1), at(0, 2)], CornerCut::Fillet(5.0)).is_ok());
        let err = corners(&[square(10.0)], &[at(0, 1)], CornerCut::Chamfer(2.0, 12.0))
            .unwrap_err()
            .to_string();
        assert!(err.starts_with("distance2Mm: 12 mm does not fit"), "{err}");
        let err = corners(&[square(10.0)], &[], CornerCut::Fillet(1.0))
            .unwrap_err()
            .to_string();
        assert_eq!(err, "corners: pick at least one corner");
        let err = corners(&[square(10.0)], &[at(0, 1)], CornerCut::Fillet(-1.0))
            .unwrap_err()
            .to_string();
        assert_eq!(err, "radiusMm: must be above 0 (at most 1000 mm)");
        let straight = Loop {
            points: vec![[0.0, 0.0], [5.0, 0.0], [10.0, 0.0], [10.0, 10.0]],
            ..Loop::default()
        };
        let err = corners(&[straight], &[at(0, 1)], CornerCut::Fillet(1.0))
            .unwrap_err()
            .to_string();
        assert_eq!(err, "corners: corner 2 of loop 1 is straight");
    }

    #[test]
    fn untouched_loops_stay_as_typed() {
        let hole = Loop {
            kind: Some("circle".into()),
            center: Some([10.0, 10.0]),
            diameter_mm: Some(4.0),
            ..Loop::default()
        };
        let r = corners(&[square(20.0), hole.clone()], &[at(0, 2)], CornerCut::Fillet(2.0)).unwrap();
        assert_eq!(r.loops[1], hole);
        assert!(sketch::check(&r.loops).ok);
    }
}
