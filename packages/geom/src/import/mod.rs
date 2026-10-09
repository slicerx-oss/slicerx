// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! model import
// vertex and slot indices are checked when the files are read
#![allow(
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::assigning_clones,
    clippy::too_many_lines
)]

mod amf;
pub mod auto;
pub(crate) mod container;
mod obj;

pub use amf::import_amf;
pub use obj::import_obj;

use crate::error::{Error, Result};
use crate::mesh::TriMesh;
use crate::vec3::V3;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImportOptions {
    pub max_colors: usize,
    pub split_shells: bool,
}

impl Default for ImportOptions {
    fn default() -> Self {
        Self {
            max_colors: 16,
            split_shells: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    Micron,
    Millimeter,
    Centimeter,
    Meter,
    Inch,
    Foot,
}

impl Unit {
    pub fn mm(self) -> f64 {
        match self {
            Self::Micron => 0.001,
            Self::Millimeter => 1.0,
            Self::Centimeter => 10.0,
            Self::Meter => 1000.0,
            Self::Inch => 25.4,
            Self::Foot => 304.8,
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s.trim().to_ascii_lowercase().as_str() {
            "micrometer" | "micron" | "um" => Self::Micron,
            "millimeter" | "millimetre" | "mm" => Self::Millimeter,
            "centimeter" | "centimetre" | "cm" => Self::Centimeter,
            "meter" | "metre" | "m" => Self::Meter,
            "inch" | "in" => Self::Inch,
            "feet" | "foot" | "ft" => Self::Foot,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    Declared,
    High,
    Low,
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitInfo {
    pub declared: Option<Unit>,
    pub detected: Unit,
    pub suggested_scale: f64,
    pub confidence: Confidence,
    pub reason: String,
}

pub fn detect_unit(max_extent: f64) -> UnitInfo {
    let mk = |detected: Unit, confidence, reason: &str| UnitInfo {
        declared: None,
        detected,
        suggested_scale: detected.mm(),
        confidence,
        reason: reason.to_owned(),
    };
    if !max_extent.is_finite() || max_extent <= 0.0 {
        return mk(Unit::Millimeter, Confidence::None, "the model has no size");
    }
    if max_extent < 0.4 {
        mk(
            Unit::Meter,
            Confidence::High,
            "the largest side is under 0.4 units, which reads as meters",
        )
    } else if max_extent <= 9.0 {
        mk(
            Unit::Inch,
            Confidence::Low,
            "the largest side is under 9 units; small for millimeters, plausible for inches",
        )
    } else {
        mk(Unit::Millimeter, Confidence::None, "the size fits millimeters")
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImportedPart {
    pub name: String,
    pub slot: u8,
    pub color: Option<String>,
    pub mesh: TriMesh,
    pub body: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Body {
    pub name: String,
    pub triangles: usize,
    pub size: V3,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImportedModel {
    pub name: String,
    pub format: &'static str,
    pub unit: UnitInfo,
    pub parts: Vec<ImportedPart>,
    pub slot_colors: Vec<String>,
    pub bodies: Vec<Body>,
    pub warnings: Vec<String>,
}

impl ImportedModel {
    pub fn multi_body(&self) -> bool {
        self.bodies.len() > 1
    }

    #[must_use]
    pub fn scaled(mut self, factor: f64) -> Self {
        for p in &mut self.parts {
            p.mesh.map_positions(|q| q.map(|c| c * factor));
        }
        for b in &mut self.bodies {
            b.size = b.size.map(|c| c * factor);
        }
        self
    }

    pub fn into_objects(self) -> Vec<ImportedModel> {
        if self.bodies.len() < 2 {
            return vec![self];
        }
        self.bodies
            .iter()
            .enumerate()
            .map(|(i, body)| {
                let parts = self
                    .parts
                    .iter()
                    .filter(|p| p.body == i)
                    .cloned()
                    .map(|mut p| {
                        p.body = 0;
                        p
                    })
                    .collect();
                ImportedModel {
                    name: body.name.clone(),
                    format: self.format,
                    unit: self.unit.clone(),
                    parts,
                    slot_colors: self.slot_colors.clone(),
                    bodies: vec![body.clone()],
                    warnings: self.warnings.clone(),
                }
            })
            .collect()
    }

    pub fn merged(&self) -> TriMesh {
        let mut m = TriMesh::default();
        for p in &self.parts {
            m.append(&p.mesh);
        }
        m
    }
}

pub fn import_stl(bytes: &[u8], name: &str, opts: &ImportOptions) -> Result<ImportedModel> {
    import_stl_read(&TriMesh::from_stl(bytes, name)?, name, opts)
}

/// An STL already read with its exactly equal corners welded (`TriMesh::from_stl`, or the app's own read of the
/// file, which `tests/weld_parity.rs` holds to the same mesh), imported as `import_stl` imports the file.
pub fn import_stl_read(mesh: &TriMesh, name: &str, opts: &ImportOptions) -> Result<ImportedModel> {
    let mesh = mesh.welded();
    let mut raw = RawModel::new(name, "stl");
    let shells = if opts.split_shells {
        shell_triangles(&mesh)
    } else {
        vec![mesh.triangles.clone()]
    };
    raw.positions = mesh.positions;
    let many = shells.len() > 1;
    for (i, tris) in shells.into_iter().enumerate() {
        raw.bodies.push(RawBody {
            name: if many {
                format!("{name} {}", i + 1)
            } else {
                name.to_owned()
            },
            groups: vec![RawGroup {
                name: String::new(),
                faces: tris.into_iter().map(|t| (t, None)).collect(),
            }],
        });
    }
    raw.finish(opts)
}

fn shell_triangles(mesh: &TriMesh) -> Vec<Vec<[u32; 3]>> {
    fn find(parent: &mut [u32], mut x: u32) -> u32 {
        while parent[x as usize] != x {
            let up = parent[parent[x as usize] as usize];
            parent[x as usize] = up;
            x = up;
        }
        x
    }
    let n = u32::try_from(mesh.positions.len()).unwrap_or(u32::MAX);
    let mut parent: Vec<u32> = (0..n).collect();
    for t in &mesh.triangles {
        let a = find(&mut parent, t[0]);
        for &i in &t[1..] {
            let b = find(&mut parent, i);
            if a != b {
                parent[b as usize] = a;
            }
        }
    }
    let mut groups: HashMap<u32, Vec<[u32; 3]>> = HashMap::new();
    for t in &mesh.triangles {
        groups.entry(find(&mut parent, t[0])).or_default().push(*t);
    }
    let mut out: Vec<Vec<[u32; 3]>> = groups.into_values().collect();
    out.sort_by_key(|g| (std::cmp::Reverse(g.len()), g.first().copied()));
    out
}

pub(crate) struct RawGroup {
    pub name: String,
    pub faces: Vec<([u32; 3], Option<[u8; 3]>)>,
}

pub(crate) struct RawBody {
    pub name: String,
    pub groups: Vec<RawGroup>,
}

pub(crate) struct RawModel {
    pub name: String,
    pub format: &'static str,
    pub positions: Vec<V3>,
    pub bodies: Vec<RawBody>,
    pub declared: Option<Unit>,
    pub warnings: Vec<String>,
}

impl RawModel {
    pub(crate) fn new(name: &str, format: &'static str) -> Self {
        Self {
            name: name.to_owned(),
            format,
            positions: Vec::new(),
            bodies: Vec::new(),
            declared: None,
            warnings: Vec::new(),
        }
    }

    pub(crate) fn finish(self, opts: &ImportOptions) -> Result<ImportedModel> {
        let max_colors = opts.max_colors.clamp(1, 255);
        let mut counts: Vec<([u8; 3], usize)> = Vec::new();
        let mut index: HashMap<[u8; 3], usize> = HashMap::new();
        let mut any_uncolored = false;
        for f in self.bodies.iter().flat_map(|b| &b.groups).flat_map(|g| &g.faces) {
            match f.1 {
                Some(c) => {
                    let i = *index.entry(c).or_insert_with(|| {
                        counts.push((c, 0));
                        counts.len() - 1
                    });
                    counts[i].1 += 1;
                }
                None => any_uncolored = true,
            }
        }
        let default_color = [128u8, 128, 128];
        if !counts.is_empty() && any_uncolored && !index.contains_key(&default_color) {
            index.insert(default_color, counts.len());
            counts.push((default_color, 0));
        }
        let (palette, slot_of) = build_palette(&counts, max_colors);
        let slot_for = |c: Option<[u8; 3]>| -> u8 {
            if palette.is_empty() {
                return 1;
            }
            let c = c.unwrap_or(default_color);
            let i = index.get(&c).copied().unwrap_or(0);
            u8::try_from(slot_of.get(i).copied().unwrap_or(0) + 1).unwrap_or(1)
        };

        let mut parts = Vec::new();
        let mut bodies = Vec::new();
        for (bi, body) in self.bodies.iter().enumerate() {
            let mut body_tris = 0;
            let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
            let many_groups = body.groups.len() > 1;
            for g in &body.groups {
                let mut by_slot: Vec<(u8, Vec<[u32; 3]>)> = Vec::new();
                for &(t, c) in &g.faces {
                    if t.iter().any(|&i| i as usize >= self.positions.len()) {
                        return Err(Error::mesh(&self.name, "a face points past the vertex list"));
                    }
                    let slot = slot_for(c);
                    match by_slot.iter_mut().find(|(s, _)| *s == slot) {
                        Some((_, v)) => v.push(t),
                        None => by_slot.push((slot, vec![t])),
                    }
                }
                let split = by_slot.len() > 1;
                by_slot.sort_by_key(|(s, _)| *s);
                for (slot, tris) in by_slot {
                    let mesh = self.compact(&tris);
                    if let Some(b) = mesh.bounds() {
                        for k in 0..3 {
                            lo[k] = lo[k].min(b.min[k]);
                            hi[k] = hi[k].max(b.max[k]);
                        }
                    }
                    body_tris += tris.len();
                    let mut name = if g.name.is_empty() || !many_groups && body.name.is_empty() {
                        body.name.clone()
                    } else if body.name.is_empty() || !many_groups {
                        g.name.clone()
                    } else {
                        format!("{} {}", body.name, g.name)
                    };
                    if split {
                        name = format!("{name} (slot {slot})");
                    }
                    parts.push(ImportedPart {
                        name,
                        slot,
                        color: palette.get(usize::from(slot) - 1).map(|c| hex(*c)),
                        mesh,
                        body: bi,
                    });
                }
            }
            bodies.push(Body {
                name: body.name.clone(),
                triangles: body_tris,
                size: if body_tris > 0 {
                    [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]
                } else {
                    [0.0; 3]
                },
            });
        }
        if parts.is_empty() {
            return Err(Error::mesh(&self.name, "the file has no triangles"));
        }
        let max_extent = bodies_extent(&parts);
        let unit = match self.declared {
            Some(u) => UnitInfo {
                declared: Some(u),
                detected: Unit::Millimeter,
                suggested_scale: 1.0,
                confidence: Confidence::Declared,
                reason: format!("the file declares {u:?} and the positions are converted to millimeters"),
            },
            None => detect_unit(max_extent),
        };
        Ok(ImportedModel {
            name: self.name,
            format: self.format,
            unit,
            parts,
            slot_colors: palette.iter().map(|c| hex(*c)).collect(),
            bodies,
            warnings: self.warnings,
        })
    }

    fn compact(&self, tris: &[[u32; 3]]) -> TriMesh {
        let mut remap: HashMap<u32, u32> = HashMap::new();
        let mut m = TriMesh::default();
        for t in tris {
            let mut out = [0u32; 3];
            for (k, &i) in t.iter().enumerate() {
                out[k] = *remap
                    .entry(i)
                    .or_insert_with(|| m.push_vertex(self.positions[i as usize]));
            }
            m.triangles.push(out);
        }
        m
    }
}

fn bodies_extent(parts: &[ImportedPart]) -> f64 {
    let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for b in parts.iter().filter_map(|p| p.mesh.bounds()) {
        for k in 0..3 {
            lo[k] = lo[k].min(b.min[k]);
            hi[k] = hi[k].max(b.max[k]);
        }
    }
    (0..3).map(|k| hi[k] - lo[k]).fold(0.0, f64::max)
}

fn mean_color(a: [u8; 3], b: [u8; 3], c: [u8; 3]) -> [u8; 3] {
    [0, 1, 2].map(|j| ((u16::from(a[j]) + u16::from(b[j]) + u16::from(c[j])) / 3) as u8)
}

pub(crate) fn hex(c: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

pub(crate) fn build_palette(counts: &[([u8; 3], usize)], max: usize) -> (Vec<[u8; 3]>, Vec<usize>) {
    if counts.len() <= max {
        return (counts.iter().map(|c| c.0).collect(), (0..counts.len()).collect());
    }
    let mut boxes: Vec<Vec<usize>> = vec![(0..counts.len()).collect()];
    while boxes.len() < max {
        let pick = boxes
            .iter()
            .enumerate()
            .filter(|(_, b)| b.len() > 1)
            .map(|(i, b)| {
                let range = (0..3)
                    .map(|k| {
                        let (lo, hi) = b.iter().fold((255u8, 0u8), |(lo, hi), &j| {
                            (lo.min(counts[j].0[k]), hi.max(counts[j].0[k]))
                        });
                        (hi - lo, k)
                    })
                    .max()
                    .unwrap_or((0, 0));
                (range, i)
            })
            .max();
        let Some(((_, ch), bi)) = pick else { break };
        let mut b = boxes.swap_remove(bi);
        b.sort_by_key(|&j| counts[j].0[ch]);
        let total: usize = b.iter().map(|&j| counts[j].1.max(1)).sum();
        let (mut acc, mut cut) = (0, 1);
        for (n, &j) in b.iter().enumerate() {
            acc += counts[j].1.max(1);
            if acc * 2 >= total {
                cut = (n + 1).clamp(1, b.len() - 1);
                break;
            }
        }
        let right = b.split_off(cut);
        boxes.push(b);
        boxes.push(right);
    }
    boxes.sort_by_key(|b| b.iter().copied().min().unwrap_or(0));
    let mut palette = Vec::new();
    let mut slot_of = vec![0; counts.len()];
    for (pi, b) in boxes.iter().enumerate() {
        let w: usize = b.iter().map(|&j| counts[j].1.max(1)).sum();
        let mut c = [0u8; 3];
        for (k, out) in c.iter_mut().enumerate() {
            let s: usize = b
                .iter()
                .map(|&j| usize::from(counts[j].0[k]) * counts[j].1.max(1))
                .sum();
            *out = u8::try_from(s / w.max(1)).unwrap_or(255);
        }
        palette.push(c);
        for &j in b {
            slot_of[j] = pi;
        }
    }
    (palette, slot_of)
}

#[cfg(test)]
mod tests;
