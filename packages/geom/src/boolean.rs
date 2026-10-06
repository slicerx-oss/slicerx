// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! booleans on closed meshes

use crate::error::{Error, Result};
use crate::faces::{self, Faces, Surface};
use crate::mesh::{self, TriMesh};
use manifold_rust::manifold::Manifold;
use manifold_rust::types::{BooleanEngine, Error as MfError, MeshGL64, OpType, WindingRule};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BoolOp {
    Union,
    Difference,
    Intersection,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    #[default]
    Auto,
    Exact,
    Robust,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BooleanOptions {
    pub engine: Engine,
    pub keep_inverted: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BooleanReport {
    pub engine: String,
    pub unclean_inputs: usize,
    pub triangles: usize,
    pub shells: usize,
    pub volume_mm3: f64,
    pub watertight: bool,
    pub empty: bool,
}

#[derive(Clone)]
pub struct Solid {
    pub(crate) m: Manifold,
    pub soup: bool,
    /// The face table of each input mesh in this solid, by the kernel's id for that mesh: each output
    /// triangle names its input mesh and the face it came from.
    tables: Vec<(u32, Arc<Vec<Surface>>)>,
}

impl Solid {
    pub fn new(mesh: &TriMesh) -> Result<Self> {
        mesh.validate("boolean")?;
        if mesh.triangles.is_empty() {
            return Ok(Self {
                m: Manifold::empty(),
                soup: false,
                tables: Vec::new(),
            });
        }
        let mut w = mesh.weld(mesh::weld_tolerance(mesh.bounds()));
        // A mesh without faces gets them by recognition, so the result has faces wherever it came from.
        let f = w.faces.take().unwrap_or_else(|| faces::recognize(&w));
        let mut gl = to_gl(&w);
        gl.face_id = f.ids.iter().map(|&i| u64::from(i)).collect();
        // One run under an id of our own, which every output triangle from this mesh reports back.
        let id = Manifold::reserve_ids(1);
        gl.run_original_id = vec![id];
        gl.run_index = vec![0, gl.tri_verts.len() as u64];
        let table = Arc::new(f.table);
        let with = |m: Manifold, soup: bool| Self {
            m,
            soup,
            tables: vec![(id, Arc::clone(&table))],
        };
        let m = Manifold::from_mesh_gl64(&gl);
        match m.status() {
            MfError::NoError => Ok(with(m, false)),
            MfError::NotManifold => {
                let m = Manifold::from_mesh_gl64_robust(&gl);
                match m.status() {
                    MfError::NoError => Ok(with(m, true)),
                    MfError::NotClosed => Err(not_closed()),
                    e => Err(Error::geometry("boolean", e.to_str().to_owned())),
                }
            }
            MfError::NonFiniteVertex => Err(Error::mesh("boolean", "a vertex is not a finite number")),
            e => Err(Error::geometry("boolean", e.to_str().to_owned())),
        }
    }

    pub fn self_intersects(&self) -> bool {
        !self.m.is_empty() && self.m.has_self_intersections()
    }

    pub fn unclean(&self) -> bool {
        self.soup || self.self_intersects()
    }

    pub fn is_empty(&self) -> bool {
        self.m.is_empty()
    }

    pub fn volume(&self) -> f64 {
        self.m.volume()
    }

    pub fn to_mesh(&self) -> TriMesh {
        let gl = self.m.get_mesh_gl64(-1);
        let mut out = from_gl(&gl);
        if !out.triangles.is_empty() {
            out.faces = Some(faces::merge_meeting_planes(&out, self.faces_of(&gl)));
        }
        out
    }

    /// The face of each output triangle: its input mesh's face, seen from the other side in a run the kernel
    /// marks as a back side (a subtracted body), numbered in order of first use.
    #[allow(
        clippy::cast_possible_truncation,
        reason = "triangle and face counts stay below 2^32"
    )]
    fn faces_of(&self, gl: &MeshGL64) -> Faces {
        let n = gl.tri_verts.len() / 3;
        let tables: HashMap<u32, &Arc<Vec<Surface>>> = self.tables.iter().map(|(id, t)| (*id, t)).collect();
        let mut ids = vec![0u32; n];
        let mut table = Vec::new();
        let mut seen: HashMap<(u32, bool, u64), u32> = HashMap::new();
        let starts: Vec<usize> = gl
            .run_index
            .iter()
            .map(|&i| usize::try_from(i / 3).unwrap_or(n))
            .collect();
        for (run, &start) in starts.iter().enumerate() {
            let end = starts.get(run + 1).copied().unwrap_or(n).min(n);
            let original = gl.run_original_id.get(run).copied().unwrap_or(0);
            let back = gl.run_flags.get(run).is_some_and(|f| f & 1 == 1);
            let source = tables.get(&original);
            for (t, slot) in ids.iter_mut().enumerate().take(end).skip(start) {
                let face = gl.face_id.get(t).copied().unwrap_or(0);
                *slot = *seen.entry((original, back, face)).or_insert_with(|| {
                    let s = source
                        .and_then(|tab| usize::try_from(face).ok().and_then(|i| tab.get(i)))
                        .copied()
                        .unwrap_or(Surface::Other);
                    table.push(if back { s.flipped() } else { s });
                    (table.len() - 1) as u32
                });
            }
        }
        Faces { ids, table }
    }

    pub fn rebuilt(&self, keep_inverted: bool) -> Result<Self> {
        let rule = if keep_inverted {
            WindingRule::Nonzero
        } else {
            WindingRule::Positive
        };
        let m = self.m.rebuild_solid(rule);
        check(&m)?;
        Ok(Self {
            m,
            soup: false,
            tables: self.tables.clone(),
        })
    }

    fn apply(&self, other: &Self, op: OpType, opts: BooleanOptions) -> Result<(Self, bool)> {
        let robust = match opts.engine {
            Engine::Robust => true,
            Engine::Exact => false,
            Engine::Auto => opts.keep_inverted || self.unclean() || other.unclean(),
        };
        if !robust && (self.soup || other.soup) {
            return Err(Error::geometry(
                "boolean",
                "the exact engine needs manifold inputs; use the robust or auto engine",
            ));
        }
        let engine = if robust {
            BooleanEngine::Robust
        } else {
            BooleanEngine::Exact
        };
        let rule = if opts.keep_inverted {
            WindingRule::Nonzero
        } else {
            WindingRule::Positive
        };
        let m = self
            .m
            .boolean_with_engine_rule_and_progress(&other.m, op, engine, rule, None, None);
        check(&m)?;
        let tables = self.tables.iter().chain(&other.tables).cloned().collect();
        Ok((
            Self {
                m,
                soup: false,
                tables,
            },
            robust,
        ))
    }
}

fn not_closed() -> Error {
    Error::geometry(
        "boolean",
        "the mesh is not closed (it has holes or open edges); repair it first",
    )
}

fn check(m: &Manifold) -> Result<()> {
    match m.status() {
        MfError::NoError => Ok(()),
        MfError::NotClosed => Err(not_closed()),
        MfError::ResultTooLarge => Err(Error::geometry("boolean", "the result is too large")),
        e => Err(Error::geometry("boolean", e.to_str().to_owned())),
    }
}

fn to_gl(m: &TriMesh) -> MeshGL64 {
    MeshGL64 {
        num_prop: 3,
        vert_properties: m.positions.iter().flatten().copied().collect(),
        tri_verts: m.triangles.iter().flatten().map(|&i| u64::from(i)).collect(),
        ..MeshGL64::default()
    }
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "the kernel indexes vertices with 32 bits"
)]
fn from_gl(gl: &MeshGL64) -> TriMesh {
    let stride = usize::try_from(gl.num_prop).unwrap_or(3).max(3);
    let positions = gl
        .vert_properties
        .chunks_exact(stride)
        .map(|c| {
            [
                c.first().copied().unwrap_or(0.0),
                c.get(1).copied().unwrap_or(0.0),
                c.get(2).copied().unwrap_or(0.0),
            ]
        })
        .collect();
    let triangles = gl
        .tri_verts
        .as_chunks::<3>()
        .0
        .iter()
        .map(|&[a, b, c]| [a as u32, b as u32, c as u32])
        .collect();
    TriMesh::new(positions, triangles)
}

pub fn boolean(
    a: &[TriMesh],
    b: &[TriMesh],
    op: BoolOp,
    opts: &BooleanOptions,
) -> Result<(TriMesh, BooleanReport)> {
    let sa = a.iter().map(Solid::new).collect::<Result<Vec<_>>>()?;
    let sb = b.iter().map(Solid::new).collect::<Result<Vec<_>>>()?;
    boolean_solids(&sa, &sb, op, opts)
}

pub fn boolean_solids(
    a: &[Solid],
    b: &[Solid],
    op: BoolOp,
    opts: &BooleanOptions,
) -> Result<(TriMesh, BooleanReport)> {
    let unclean = a.iter().chain(b).filter(|s| s.unclean()).count();
    let mut robust = false;
    let mut fold = |items: Vec<&Solid>, op: OpType| -> Result<Option<Solid>> {
        let mut it = items.into_iter();
        let Some(first) = it.next() else {
            return Ok(None);
        };
        let mut acc = first.clone();
        for s in it {
            let (r, used) = acc.apply(s, op, *opts)?;
            robust |= used;
            acc = r;
        }
        Ok(Some(acc))
    };
    let result = match op {
        BoolOp::Union => fold(a.iter().chain(b).collect(), OpType::Add)?,
        BoolOp::Intersection => fold(a.iter().chain(b).collect(), OpType::Intersect)?,
        BoolOp::Difference => {
            let base = fold(a.iter().collect(), OpType::Add)?;
            let cut = fold(b.iter().collect(), OpType::Add)?;
            match (base, cut) {
                (Some(x), Some(y)) => {
                    let (r, used) = x.apply(&y, OpType::Subtract, *opts)?;
                    robust |= used;
                    Some(r)
                }
                (x, _) => x,
            }
        }
    };
    let Some(result) = result else {
        return Err(Error::invalid("meshes", "needs at least one mesh"));
    };
    let out = result.to_mesh();
    let e = out.edge_report();
    let report = BooleanReport {
        engine: if robust { "robust" } else { "exact" }.to_owned(),
        unclean_inputs: unclean,
        triangles: out.triangles.len(),
        shells: if out.triangles.is_empty() {
            0
        } else {
            out.components().len()
        },
        volume_mm3: out.volume(),
        watertight: e.is_watertight() && !out.triangles.is_empty(),
        empty: out.triangles.is_empty(),
    };
    Ok((out, report))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build;
    use crate::faces::Surface;
    use crate::fm::Fm as _;

    fn cube(min: [f64; 3], s: f64) -> TriMesh {
        build::box_mesh(min, [min[0] + s, min[1] + s, min[2] + s])
    }

    #[test]
    fn overlapping_cubes() {
        let a = cube([0.0; 3], 10.0);
        let b = cube([5.0, 5.0, 5.0], 10.0);
        let o = BooleanOptions::default();
        let (u, r) = boolean(
            std::slice::from_ref(&a),
            std::slice::from_ref(&b),
            BoolOp::Union,
            &o,
        )
        .unwrap();
        assert!((u.volume() - (2000.0 - 125.0)).abs() < 1e-6, "{}", u.volume());
        assert!(r.watertight && r.shells == 1 && r.engine == "exact");
        let (d, _) = boolean(
            std::slice::from_ref(&a),
            std::slice::from_ref(&b),
            BoolOp::Difference,
            &o,
        )
        .unwrap();
        assert!((d.volume() - 875.0).abs() < 1e-6);
        let (i, _) = boolean(&[a], &[b], BoolOp::Intersection, &o).unwrap();
        assert!((i.volume() - 125.0).abs() < 1e-6);
    }

    #[test]
    fn coplanar_and_touching_faces() {
        let a = cube([0.0; 3], 10.0);
        let b = cube([10.0, 0.0, 0.0], 10.0);
        let (u, r) = boolean(
            std::slice::from_ref(&a),
            &[b],
            BoolOp::Union,
            &BooleanOptions::default(),
        )
        .unwrap();
        assert!((u.volume() - 2000.0).abs() < 1e-6);
        assert_eq!(r.shells, 1);
        let hole = build::box_mesh([3.0, 3.0, 2.0], [7.0, 7.0, 10.0]);
        let (d, r) = boolean(&[a], &[hole], BoolOp::Difference, &BooleanOptions::default()).unwrap();
        assert!((d.volume() - (1000.0 - 128.0)).abs() < 1e-6);
        assert!(r.watertight);
    }

    #[test]
    fn concave_cutter_and_empty_result() {
        let base = cube([0.0; 3], 20.0);
        let t = build::torus([10.0, 10.0, 20.0], 6.0, 2.0, 48, 16);
        let (d, r) = boolean(
            std::slice::from_ref(&base),
            &[t],
            BoolOp::Difference,
            &BooleanOptions::default(),
        )
        .unwrap();
        assert!(r.watertight);
        let half = std::f64::consts::PI.m_powi(2) * 6.0 * 4.0;
        assert!((8000.0 - d.volume() - half).abs() < 0.03 * half, "{}", d.volume());
        let (e, r) = boolean(
            &[cube([0.0; 3], 5.0)],
            &[base],
            BoolOp::Difference,
            &BooleanOptions::default(),
        )
        .unwrap();
        assert!(r.empty && e.triangles.is_empty());
    }

    #[test]
    fn self_intersecting_input_goes_robust() {
        let mut m = cube([0.0; 3], 10.0);
        m.append(&cube([5.0, 0.0, 0.0], 10.0));
        let s = Solid::new(&m).unwrap();
        assert!(s.self_intersects());
        let fixed = s.rebuilt(false).unwrap();
        assert!((fixed.volume() - 1500.0).abs() < 1e-6, "{}", fixed.volume());
        let other = cube([20.0, 0.0, 0.0], 5.0);
        let (u, r) = boolean(&[m], &[other], BoolOp::Union, &BooleanOptions::default()).unwrap();
        assert_eq!(r.engine, "robust");
        assert_eq!(r.unclean_inputs, 1);
        assert!((u.volume() - 1625.0).abs() < 1e-6, "{}", u.volume());
    }

    #[test]
    fn open_mesh_is_refused() {
        let mut m = cube([0.0; 3], 10.0);
        m.faces = None;
        m.triangles.pop();
        assert!(Solid::new(&m).is_err());
    }

    #[test]
    fn a_union_keeps_the_faces_of_both_boxes() {
        let (u, _) = boolean(
            &[cube([0.0; 3], 10.0)],
            &[cube([5.0; 3], 10.0)],
            BoolOp::Union,
            &BooleanOptions::default(),
        )
        .unwrap();
        assert_eq!(crate::faces::check::faces_agree(&u), 12);
    }

    #[test]
    fn a_cutter_turns_into_the_walls_of_the_hole() {
        let hole = build::box_mesh([3.0, 3.0, 2.0], [7.0, 7.0, 10.0]);
        let (d, _) = boolean(
            &[cube([0.0; 3], 10.0)],
            &[hole],
            BoolOp::Difference,
            &BooleanOptions::default(),
        )
        .unwrap();
        // The block's six sides, the hole's four walls and its floor, each wall facing into the hole.
        assert_eq!(crate::faces::check::faces_agree(&d), 11);
        let f = d.faces.unwrap();
        let walls = f
            .table
            .iter()
            .filter(|s| matches!(s, Surface::Plane { normal, offset } if (normal[0] - 1.0).abs() < 1e-9 && (offset - 3.0).abs() < 1e-9))
            .count();
        assert_eq!(walls, 1, "the wall at x = 3 faces +x");
    }

    #[test]
    fn coplanar_faces_that_meet_become_one_face() {
        let (u, _) = boolean(
            &[cube([0.0; 3], 10.0)],
            &[cube([10.0, 0.0, 0.0], 10.0)],
            BoolOp::Union,
            &BooleanOptions::default(),
        )
        .unwrap();
        // A 20 by 10 by 10 block: six faces, not ten.
        assert_eq!(crate::faces::check::faces_agree(&u), 6);
    }

    #[test]
    fn an_untagged_input_is_recognized_first() {
        let mut a = cube([0.0; 3], 10.0);
        a.faces = None;
        let (u, _) = boolean(
            &[a],
            &[cube([5.0; 3], 10.0)],
            BoolOp::Union,
            &BooleanOptions::default(),
        )
        .unwrap();
        assert_eq!(crate::faces::check::faces_agree(&u), 12);
    }
}
