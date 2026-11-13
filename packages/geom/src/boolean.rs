// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! booleans on closed meshes

use crate::error::{Error, Result};
use crate::faces::Surface;
#[cfg(feature = "cad")]
use crate::faces::{self, Faces};
use crate::mesh::{self, TriMesh};
use manifold_rust::cancel::CancelToken;
use manifold_rust::manifold::Manifold;
use manifold_rust::progress::ProgressReporter;
use manifold_rust::types::{BooleanEngine, Error as MfError, MeshGL64, OpType, WindingRule};
use serde::{Deserialize, Serialize};
#[cfg(feature = "cad")]
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

/// triangles one join may hand the kernel before it stops with an error, not after minutes
pub const WORK_BUDGET: u64 = 20_000_000;

/// triangles handed to the kernel so far; report counts don't follow cost, so triangles are counted
#[derive(Clone)]
struct Work {
    budget: u64,
    done: Arc<AtomicU64>,
    token: CancelToken,
}

impl Work {
    fn new(budget: u64) -> Self {
        Self {
            budget,
            done: Arc::new(AtomicU64::new(0)),
            token: CancelToken::new(),
        }
    }

    /// false past the budget, which also cancels the step in progress
    fn add(&self, n: u64) -> bool {
        let within = self.done.fetch_add(n, Ordering::Relaxed).saturating_add(n) <= self.budget;
        if !within {
            self.token.cancel();
        }
        within
    }
}

#[cfg(test)]
thread_local! {
    /// what the last join on this thread handed the kernel
    pub(crate) static SPENT: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// what the end cleanup may hand the kernel, per triangle of the body it cleans
const CLEAN_WORK_PER_TRI: u64 = 40;

/// the solid through the robust engine, cut by a box around it, on a budget of its own; none unless that comes out clean
fn cleaned(s: &Solid, opts: BooleanOptions) -> Option<Solid> {
    cleaned_within(s, opts, CLEAN_WORK_PER_TRI)
}

fn cleaned_within(s: &Solid, opts: BooleanOptions, per_tri: u64) -> Option<Solid> {
    let work = Work::new(per_tri * (s.m.num_tri() as u64 + 12));
    let b = s.m.bounding_box();
    let around = crate::build::box_mesh(
        [b.min.x - 1.0, b.min.y - 1.0, b.min.z - 1.0],
        [b.max.x + 1.0, b.max.y + 1.0, b.max.z + 1.0],
    );
    let robust = BooleanOptions {
        engine: Engine::Robust,
        ..opts
    };
    let (r, _) = s
        .apply(
            &Solid::new(&around).ok()?,
            OpType::Intersect,
            robust,
            true,
            Some(&work),
        )
        .ok()?;
    (!r.self_intersects()).then_some(r)
}

fn too_long() -> Error {
    Error::geometry(
        "boolean",
        "this join is taking too long to finish; try fewer copies or join them in smaller groups",
    )
}

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
    tables: Vec<Table>,
}

/// An input mesh's kernel id, its face surfaces and their keys (empty when it has none).
type Table = (u32, Arc<Vec<Surface>>, Arc<Vec<u64>>);

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
        let mut gl = to_gl(&w);
        let tables = tag(&mut w, &mut gl);
        let with = |m: Manifold, soup: bool| Self {
            m,
            soup,
            tables: tables.clone(),
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
        #[allow(unused_mut, reason = "faces are added only in builds with the cad feature")]
        let mut out = from_gl(&gl);
        #[cfg(feature = "cad")]
        if !out.triangles.is_empty() && !self.tables.is_empty() {
            out.faces = Some(faces::merge_meeting_planes(&out, self.faces_of(&gl)));
        }
        out
    }

    #[cfg(feature = "cad")]
    /// The face of each output triangle: its input mesh's face, seen from the other side in a run the kernel
    /// marks as a back side (a subtracted body), numbered in order of first use.
    #[allow(
        clippy::cast_possible_truncation,
        reason = "triangle and face counts stay below 2^32"
    )]
    fn faces_of(&self, gl: &MeshGL64) -> Faces {
        let n = gl.tri_verts.len() / 3;
        let tables: HashMap<u32, &Table> = self.tables.iter().map(|t| (t.0, t)).collect();
        let mut ids = vec![0u32; n];
        let mut table = Vec::new();
        let mut keys = Vec::new();
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
                    let at = usize::try_from(face).ok();
                    let s = source
                        .and_then(|(_, tab, _)| at.and_then(|i| tab.get(i)))
                        .copied()
                        .unwrap_or(Surface::Other);
                    table.push(if back { s.flipped() } else { s });
                    keys.push(
                        source
                            .and_then(|(_, _, k)| at.and_then(|i| k.get(i)))
                            .copied()
                            .unwrap_or(0),
                    );
                    (table.len() - 1) as u32
                });
            }
        }
        // Keys only when some input had them.
        let keys = if keys.iter().any(|&k| k != 0) {
            keys
        } else {
            Vec::new()
        };
        Faces { ids, table, keys }
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

    /// `unclean`: an input folded in so far was unclean
    fn apply(
        &self,
        other: &Self,
        op: OpType,
        opts: BooleanOptions,
        unclean: bool,
        work: Option<&Work>,
    ) -> Result<(Self, bool)> {
        let robust = match opts.engine {
            Engine::Robust => true,
            Engine::Exact => false,
            Engine::Auto => opts.keep_inverted || unclean,
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
        let m = if let Some(work) = work {
            let size = (self.m.num_tri() + other.m.num_tri()) as u64;
            if !work.add(size) {
                return Err(too_long());
            }
            let counted = work.clone();
            let progress = ProgressReporter::new(move |_, at| {
                if at.is_some() {
                    counted.add(size / 100 + 1);
                }
            });
            self.m.boolean_with_engine_rule_and_progress(
                &other.m,
                op,
                engine,
                rule,
                Some(&work.token),
                Some(&progress),
            )
        } else {
            self.m
                .boolean_with_engine_rule_and_progress(&other.m, op, engine, rule, None, None)
        };
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

/// The face ids of a boolean input, sent with it: a mesh without faces gets them by recognition, so the result has
/// faces wherever it came from. Each input runs under an id of its own, which every output triangle from it reports
/// back with its face. Builds without the cad feature send none, and their results carry no faces.
#[cfg(feature = "cad")]
fn tag(w: &mut TriMesh, gl: &mut MeshGL64) -> Vec<Table> {
    let f = w.faces.take().unwrap_or_else(|| faces::recognize(w));
    gl.face_id = f.ids.iter().map(|&i| u64::from(i)).collect();
    let id = Manifold::reserve_ids(1);
    gl.run_original_id = vec![id];
    gl.run_index = vec![0, gl.tri_verts.len() as u64];
    // A mesh with keys keeps them; one the current step made (a tool) gets the step's own.
    let keys = if !f.keys.is_empty() && f.keys.len() == f.table.len() {
        f.keys
    } else {
        faces::fresh_keys(f.table.len())
    };
    vec![(id, Arc::new(f.table), Arc::new(keys))]
}

#[cfg(not(feature = "cad"))]
fn tag(_: &mut TriMesh, _: &mut MeshGL64) -> Vec<Table> {
    Vec::new()
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
        MfError::Cancelled => Err(too_long()),
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

/// validates the mesh representation stored by clients, after returning to its local frame.
#[allow(clippy::cast_possible_truncation, reason = "mesh storage uses f32 positions")]
pub(crate) fn storage_mesh(mesh: &TriMesh) -> Result<TriMesh> {
    stored(mesh, "boolean", "the result is", "change the cut or placement")
}

/// the same check, refused in the words of the op that made the mesh
#[allow(clippy::cast_possible_truncation, reason = "mesh storage uses f32 positions")]
pub(crate) fn stored(mesh: &TriMesh, op: &'static str, what: &str, hint: &str) -> Result<TriMesh> {
    stored_in(mesh, op, |reason| {
        format!("{what} unsafe at mesh storage precision ({reason}); {hint}")
    })
}

/// the same check, refused with `words` for the reason (collapsed triangles, open or non-manifold edges, invalid
/// topology, intersecting faces)
#[allow(clippy::cast_possible_truncation, reason = "mesh storage uses f32 positions")]
pub(crate) fn stored_in(mesh: &TriMesh, op: &'static str, words: impl Fn(&str) -> String) -> Result<TriMesh> {
    let mut out = mesh.clone();
    for point in &mut out.positions {
        *point = point.map(|v| f64::from(v as f32));
    }
    let refuse = |reason: &str| Error::geometry(op, words(reason));
    out.validate(op)?;
    if out.is_empty() {
        return Ok(out);
    }
    if out.triangles.iter().any(|&t| {
        let [a, b, c] = out.corners(t);
        crate::vec3::len(crate::vec3::tri_normal(a, b, c)) <= 0.0
    }) {
        return Err(refuse("collapsed triangles"));
    }
    if !out.edge_report().is_watertight() {
        return Err(refuse("open or non-manifold edges"));
    }
    let solid = Manifold::from_mesh_gl64(&to_gl(&out));
    if solid.status() != MfError::NoError {
        return Err(refuse("invalid topology"));
    }
    if solid.has_self_intersections() {
        return Err(refuse("intersecting faces"));
    }
    Ok(out)
}

/// true when the mesh stores safely: closed, with no collapsed triangles and no crossing faces at storage precision
pub(crate) fn stores_clean(mesh: &TriMesh) -> bool {
    !mesh.is_empty() && storage_mesh(mesh).is_ok()
}

/// a boolean's result with its flat faces filled again and its slivers gone (remesh.rs), for results people see.
/// Slivers go before the fill too: the fill can give up on a mesh full of them and leave it as it was.
pub fn tidy(mut out: TriMesh, report: &mut BooleanReport) -> TriMesh {
    let unslivered = |m: TriMesh| crate::remesh::drop_slivers(&m).unwrap_or(m);
    out = unslivered(out);
    out = unslivered(crate::remesh::tidy_flat(
        &out,
        &crate::remesh::RemeshOptions::default(),
    ));
    report.triangles = out.triangles.len();
    report.volume_mm3 = out.volume();
    out
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
    folded(a, b, op, *opts, None)
}

/// a merged array's join: the engine picked by the inputs, a work budget, and one robust pass for crossing slivers
pub(crate) fn boolean_array(
    a: &[TriMesh],
    b: &[TriMesh],
    op: BoolOp,
    opts: BooleanOptions,
) -> Result<(TriMesh, BooleanReport)> {
    let sa = a.iter().map(Solid::new).collect::<Result<Vec<_>>>()?;
    let sb = b.iter().map(Solid::new).collect::<Result<Vec<_>>>()?;
    folded(&sa, &sb, op, opts, Some(WORK_BUDGET))
}

// only the cad tests call it
#[cfg(all(test, feature = "cad"))]
pub(crate) fn boolean_within(
    a: &[Solid],
    b: &[Solid],
    op: BoolOp,
    opts: BooleanOptions,
    budget: u64,
) -> Result<(TriMesh, BooleanReport)> {
    folded(a, b, op, opts, Some(budget))
}

/// a join step by step; with a budget it is an array's join, without one every step judges its running result
fn folded(
    a: &[Solid],
    b: &[Solid],
    op: BoolOp,
    opts: BooleanOptions,
    budget: Option<u64>,
) -> Result<(TriMesh, BooleanReport)> {
    let work = budget.map(Work::new);
    let work = work.as_ref();
    let flags: Vec<bool> = a.iter().chain(b).map(Solid::unclean).collect();
    let unclean = flags.iter().filter(|&&u| u).count();
    let (fa, fb) = flags.split_at(a.len());
    let mut robust = false;
    let mut ended_exact = false;
    let mut fold = |items: Vec<(&Solid, bool)>, op: OpType| -> Result<Option<(Solid, bool)>> {
        let mut it = items.into_iter();
        let Some((first, mut dirty)) = it.next() else {
            return Ok(None);
        };
        let mut acc = first.clone();
        for (s, u) in it {
            // an array judges by its inputs, since exact slivers read as self-intersections; any other join as before
            dirty = if work.is_some() {
                dirty | u
            } else {
                acc.unclean() || u
            };
            let (r, used) = acc.apply(s, op, opts, dirty, work)?;
            robust |= used;
            ended_exact = !used;
            // a robust step's result is clean
            dirty &= !used;
            acc = r;
        }
        Ok(Some((acc, dirty)))
    };
    let all = || a.iter().chain(b).zip(flags.iter().copied()).collect();
    let result = match op {
        BoolOp::Union => fold(all(), OpType::Add)?,
        BoolOp::Intersection => fold(all(), OpType::Intersect)?,
        BoolOp::Difference => {
            let base = fold(a.iter().zip(fa.iter().copied()).collect(), OpType::Add)?;
            let cut = fold(b.iter().zip(fb.iter().copied()).collect(), OpType::Add)?;
            match (base, cut) {
                (Some((x, ux)), Some((y, uy))) => {
                    let unclean = if work.is_some() {
                        ux || uy
                    } else {
                        x.unclean() || y.unclean()
                    };
                    let (r, used) = x.apply(&y, OpType::Subtract, opts, unclean, work)?;
                    robust |= used;
                    ended_exact = !used;
                    Some((r, false))
                }
                (x, _) => x,
            }
        }
    };
    let mut result = result.map(|(s, _)| s);
    // one look at the end of a longer exact fold, not one a step: crossing slivers get one robust pass
    if opts.engine == Engine::Auto
        && work.is_some()
        && ended_exact
        && a.len() + b.len() >= 3
        && let Some(s) = &result
        && s.self_intersects()
        && let Some(clean) = cleaned(s, opts)
    {
        result = Some(clean);
        robust = true;
    }
    #[cfg(test)]
    SPENT.set(work.map_or(0, |w| w.done.load(Ordering::Relaxed)));
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

#[cfg(all(test, feature = "cad"))]
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

    /// The key of the face under each point, which must be on the mesh's surface.
    fn key_at(m: &TriMesh, p: [f64; 3]) -> u64 {
        let f = m.faces.as_ref().unwrap();
        let t = m
            .triangles
            .iter()
            .position(|&t| {
                let c = m.corners(t);
                let n = crate::vec3::normalize(m.normal(t)).unwrap();
                crate::vec3::dot(crate::vec3::sub(p, c[0]), n).abs() < 1e-6 && {
                    (0..3).all(|i| {
                        let e = crate::vec3::sub(c[(i + 1) % 3], c[i]);
                        crate::vec3::dot(crate::vec3::sub(p, c[i]), crate::vec3::cross(n, e)) >= -1e-9
                    })
                }
            })
            .unwrap_or_else(|| panic!("no triangle at {p:?}"));
        f.keys[f.ids[t] as usize]
    }

    /// A 20 mm cube with a 4 mm square hole down its middle, cut under `salt`.
    fn cut(salt: u64, hole_x: f64) -> TriMesh {
        crate::faces::with_key_salt(Some(salt), || {
            let mut a = cube([0.0; 3], 20.0);
            crate::faces::base_keys(&mut a);
            let hole = build::box_mesh([hole_x, 8.0, -1.0], [hole_x + 4.0, 12.0, 21.0]);
            boolean(&[a], &[hole], BoolOp::Difference, &BooleanOptions::default())
                .unwrap()
                .0
        })
    }

    #[test]
    fn face_keys_follow_faces_and_stay_when_an_earlier_number_changes() {
        let m = cut(7, 8.0);
        let top = key_at(&m, [2.0, 2.0, 20.0]);
        let wall = key_at(&m, [8.0, 10.0, 10.0]);
        assert!(top != 0 && wall != 0 && top != wall);
        // Every face has a key, and the cube's top keeps the one it had before the cut.
        let mut a = cube([0.0; 3], 20.0);
        crate::faces::with_key_salt(Some(7), || crate::faces::base_keys(&mut a));
        assert_eq!(key_at(&a, [2.0, 2.0, 20.0]), top);
        // The same cut under the same salt gives the same keys; the hole moved gives the same keys too, so a later
        // step that names the hole's wall still finds it.
        assert_eq!(key_at(&cut(7, 8.0), [8.0, 10.0, 10.0]), wall);
        assert_eq!(key_at(&cut(7, 5.0), [5.0, 10.0, 10.0]), wall);
        // Another step's cut makes other keys for its own faces, and the base keeps its own.
        let other = cut(8, 8.0);
        assert_eq!(key_at(&other, [2.0, 2.0, 20.0]), top);
        assert_ne!(key_at(&other, [8.0, 10.0, 10.0]), wall);
        // Without a salt nothing gets a key.
        let mut plain = cube([0.0; 3], 20.0);
        crate::faces::base_keys(&mut plain);
        assert!(plain.faces.as_ref().is_none_or(|f| f.keys.is_empty()));
    }

    #[test]
    fn a_face_split_in_two_keeps_its_key_on_both_pieces() {
        crate::faces::with_key_salt(Some(3), || {
            let mut a = cube([0.0; 3], 20.0);
            crate::faces::base_keys(&mut a);
            let top = key_at(&a, [2.0, 2.0, 20.0]);
            // A slot right across the top splits it in two.
            let slot = build::box_mesh([8.0, -1.0, 15.0], [12.0, 21.0, 21.0]);
            let (m, _) = boolean(&[a], &[slot], BoolOp::Difference, &BooleanOptions::default()).unwrap();
            assert_eq!(key_at(&m, [2.0, 2.0, 20.0]), top);
            assert_eq!(key_at(&m, [18.0, 2.0, 20.0]), top);
        });
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

    /// copies of a 100 facet cylinder turned about its axis, as solids: their facets miss each other by microns
    fn turned_copies(count: usize) -> Vec<Solid> {
        let m = build::cylinder(&crate::vec3::Frame::WORLD, 9.5, 0.0, 10.0, 100);
        let spec = crate::array::ArraySpec::Circular {
            count,
            center: [0.0; 3],
            axis: None,
            angle_deg: None,
            rotate_copies: None,
        };
        crate::array::transforms(&spec)
            .unwrap()
            .iter()
            .map(|t| Solid::new(&crate::xform::transformed(&m, t)).unwrap())
            .collect()
    }

    #[test]
    fn a_join_past_its_work_budget_stops_with_an_error() {
        let copies = turned_copies(12);
        let o = BooleanOptions::default();
        let e = boolean_within(&copies, &[], BoolOp::Union, o, 3000).unwrap_err();
        assert!(e.to_string().contains("taking too long"), "{e}");
        // a robust step stops partway through once its reports spend the budget
        let t = std::time::Instant::now();
        let robust = BooleanOptions {
            engine: Engine::Robust,
            ..o
        };
        let e = boolean_within(&copies[..2], &[], BoolOp::Union, robust, 900).unwrap_err();
        assert!(e.to_string().contains("taking too long"), "{e}");
        assert!(t.elapsed().as_secs_f64() < 10.0, "{:?}", t.elapsed());
        let (u, r) = boolean_within(&copies[..3], &[], BoolOp::Union, o, WORK_BUDGET).unwrap();
        assert!(r.watertight && r.engine == "exact" && u.volume() > copies[0].volume());
    }

    #[test]
    fn big_real_joins_stay_well_inside_the_budget() {
        let o = BooleanOptions::default();
        // twelve 64 sided tubes with a 2 mm wall, overlapping in a ring
        let ring = |r: f64| crate::poly2d::circle([0.0, 0.0], r, 64);
        let mut hole = ring(8.0);
        hole.reverse();
        let tube = build::extrude(
            &[crate::poly2d::Polygon {
                outer: ring(10.0),
                holes: vec![hole],
            }],
            &crate::vec3::Frame::WORLD,
            0.0,
            20.0,
        )
        .unwrap();
        let spec = crate::array::ArraySpec::Circular {
            count: 12,
            center: [15.0, 0.0, 0.0],
            axis: None,
            angle_deg: None,
            rotate_copies: None,
        };
        let (u, r) = crate::array::merged(&tube, &spec, &o).unwrap();
        let spent = SPENT.get();
        assert!(
            r.watertight && r.shells == 1 && u.volume() > tube.volume(),
            "{r:?}"
        );
        assert!(spent < WORK_BUDGET / 100, "{spent}");
        // two dense spheres and a torus
        let a = build::uv_sphere([0.0; 3], 20.0, 64, 128);
        let b = build::uv_sphere([15.0, 0.0, 0.0], 20.0, 64, 128);
        let t = build::torus([0.0, 0.0, 0.0], 25.0, 6.0, 128, 48);
        let (_, r) = boolean_array(&[a, b, t], &[], BoolOp::Union, o).unwrap();
        let spent = SPENT.get();
        assert!(r.watertight, "{r:?}");
        assert!(spent < WORK_BUDGET / 20, "{spent}");
    }

    #[test]
    fn four_turned_cylinders_join_into_a_body_that_stores() {
        let copies: Vec<TriMesh> = turned_copies(12).iter().take(4).map(Solid::to_mesh).collect();
        let (u, mut r) = boolean(&copies, &[], BoolOp::Union, &BooleanOptions::default()).unwrap();
        let u = tidy(u, &mut r);
        assert!(!Solid::new(&u).unwrap().self_intersects());
        assert!(storage_mesh(&u).is_ok());
    }

    #[test]
    fn a_join_outside_an_array_judges_its_running_result_as_before() {
        // 7 turned 8 sided cylinders cross themselves once joined, so the next step goes robust, with no work budget
        let m = build::cylinder(&crate::vec3::Frame::WORLD, 9.5, 0.0, 10.0, 8);
        let spec = crate::array::ArraySpec::Circular {
            count: 7,
            center: [0.0; 3],
            axis: None,
            angle_deg: None,
            rotate_copies: None,
        };
        let mut parts: Vec<TriMesh> = crate::array::transforms(&spec)
            .unwrap()
            .iter()
            .map(|t| crate::xform::transformed(&m, t))
            .collect();
        parts.push(build::box_mesh([30.0, 30.0, 0.0], [32.0, 32.0, 2.0]));
        let (_, r) = boolean(&parts, &[], BoolOp::Union, &BooleanOptions::default()).unwrap();
        assert!(r.unclean_inputs == 0 && r.engine == "robust", "{r:?}");
        assert_eq!(SPENT.get(), 0);
    }

    #[test]
    fn the_end_pass_stops_at_its_own_budget() {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/array-hub-tooth.json")).unwrap();
        let nums = |k: &str| {
            v[k].as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_f64().unwrap())
                .collect::<Vec<_>>()
        };
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "fixture indices"
        )]
        let idx: Vec<u32> = nums("indices").iter().map(|&i| i as u32).collect();
        let hub = TriMesh::from_flat(&nums("positions"), &idx).unwrap();
        // in 15 copies the teeth meet on the hub's wrap, and the exact join crosses itself
        let spec = crate::array::ArraySpec::Circular {
            count: 15,
            center: [0.0; 3],
            axis: None,
            angle_deg: None,
            rotate_copies: None,
        };
        let exact = BooleanOptions {
            engine: Engine::Exact,
            keep_inverted: false,
        };
        let (m, _) = crate::array::merged(&hub, &spec, &exact).unwrap();
        let s = Solid::new(&m).unwrap();
        assert!(s.self_intersects());
        let o = BooleanOptions::default();
        assert!(cleaned_within(&s, o, 1).is_none());
        assert!(cleaned_within(&s, o, CLEAN_WORK_PER_TRI).is_some());
    }
}
