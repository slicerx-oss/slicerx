// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! JSON entries for the modeling operations

use crate::array::{self, ArraySpec};
use crate::boolean::{self, BoolOp, BooleanOptions};
#[cfg(feature = "cad")]
use crate::build;
#[cfg(feature = "cad")]
use crate::dimension;
#[cfg(feature = "cad")]
use crate::edge;
use crate::error::{Error, Result};
#[cfg(feature = "cad")]
use crate::face::{self, ExtrudeSpec, FaceFrame, Placement, Shape};
use crate::fit::{self, FitOptions};
#[cfg(feature = "holes")]
use crate::hole::{self, Hole, HoleSpec};
use crate::import::auto::{self, AutoOptions};
#[cfg(feature = "cad")]
use crate::json::base64_decode;
use crate::json::{
    FileLoader, MeshOut, field, field_or, field_or_default, mesh_report, mesh_value, parse, read_model,
    to_value,
};
use crate::measure::{self, Feature, Pick};
use crate::mesh::TriMesh;
#[cfg(feature = "cad")]
use crate::outline::{self, TextOptions};
#[cfg(feature = "cad")]
use crate::poly2d::Polygon;
#[cfg(feature = "cad")]
use crate::push;
#[cfg(feature = "shell")]
use crate::shell::{self, OpenFace};
#[cfg(feature = "cad")]
use crate::sketch;
#[cfg(feature = "cad")]
use crate::sketch_corner;
#[cfg(feature = "threads")]
use crate::thread::{self, ThreadSpec, ThreadTarget};
#[cfg(feature = "cad")]
use crate::vec3::V2;
use crate::xform::{self, IDENTITY, Mat4};
use serde_json::{Value, json};
#[cfg(feature = "cad")]
use std::collections::HashMap;

struct Item {
    mesh: TriMesh,
    transform: Mat4,
}

impl Item {
    fn world(&self) -> TriMesh {
        if self.transform == IDENTITY {
            self.mesh.clone()
        } else {
            xform::transformed(&self.mesh, &self.transform)
        }
    }

    fn to_local(&self, m: &TriMesh) -> Result<TriMesh> {
        if self.transform == IDENTITY {
            return Ok(m.clone());
        }
        let inv = xform::invert(&self.transform)
            .ok_or_else(|| Error::invalid("transform", "must not flatten the part (scale 0)"))?;
        Ok(xform::transformed(m, &inv))
    }
}

fn item(v: &Value, key: &str, files: FileLoader<'_>) -> Result<Item> {
    let Some(m) = v.get("mesh") else {
        return Ok(Item {
            mesh: mesh_value(v, key, files)?,
            transform: IDENTITY,
        });
    };
    let mesh = mesh_value(m, key, files)?;
    let transform: Mat4 = field_or(v, "transform", IDENTITY)?;
    if !transform.iter().all(|x| x.is_finite()) {
        return Err(Error::invalid("transform", "16 finite numbers"));
    }
    Ok(Item { mesh, transform })
}

fn item_field(req: &Value, key: &str, files: FileLoader<'_>) -> Result<Item> {
    let v = req
        .get(key)
        .ok_or_else(|| Error::invalid("request", format!("missing \"{key}\"")))?;
    item(v, key, files)
}

fn items(req: &Value, key: &str, files: FileLoader<'_>) -> Result<Vec<Item>> {
    match req.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(list)) => list.iter().map(|v| item(v, key, files)).collect(),
        Some(v) => Ok(vec![item(v, key, files)?]),
    }
}

pub(crate) fn plate_mesh(req: &Value, files: FileLoader<'_>) -> Result<TriMesh> {
    if req.get("meshes").is_some() {
        let list = items(req, "meshes", files)?;
        if list.is_empty() {
            return Err(Error::invalid("meshes", "needs at least one mesh"));
        }
        let mut out = TriMesh::default();
        for it in &list {
            out.append(&it.world());
        }
        return Ok(out);
    }
    Ok(item_field(req, "mesh", files)?.world())
}

#[cfg(feature = "cad")]
fn font(req: &Value) -> Result<Option<Vec<u8>>> {
    let b64: Option<String> = field_or(req, "fontBase64", None)?;
    b64.map(|s| base64_decode(&s).ok_or_else(|| Error::invalid("fontBase64", "bad base64")))
        .transpose()
}

fn insert(v: &mut Value, key: &str, x: Value) {
    if let Some(o) = v.as_object_mut() {
        o.insert(key.to_owned(), x);
    }
}

pub(crate) fn call(op: &str, req: &Value, enc: MeshOut, files: FileLoader<'_>) -> Option<Result<Value>> {
    Some(match op {
        "boolean" => boolean_op(req, enc, files),
        "array" => array_op(req, enc, files),
        "measure" => measure_op(req),
        "measure.feature" => feature_op(req, files),
        #[cfg(feature = "cad")]
        "face.pick" => face_pick_op(req, files),
        #[cfg(feature = "cad")]
        "shape.profile" => profile_op(req),
        #[cfg(feature = "cad")]
        "shape.extrude" => extrude_op(req, enc, files),
        #[cfg(feature = "cad")]
        "text.mesh" => text_op(req, enc),
        "import.auto" => import_auto_op(req, enc, files),
        "fit.check" => fit_op(req, files),
        #[cfg(feature = "cad")]
        "face.push" => push_op(req, enc, files),
        #[cfg(feature = "cad")]
        "face.push.preview" => push_preview_op(req, enc),
        #[cfg(feature = "cad")]
        "sketch.check" => loops(req).and_then(|l| to_value(&sketch::check(&l))),
        #[cfg(feature = "cad")]
        "sketch.revolve" => sketch_revolve_op(req, enc, files),
        #[cfg(feature = "cad")]
        "sketch.snaps" => sketch_snaps_op(req, files),
        #[cfg(feature = "cad")]
        "sketch.offset" => sketch_offset_op(req),
        #[cfg(feature = "cad")]
        "dimension.anchor" => dimension_anchor_op(req, files),
        #[cfg(feature = "cad")]
        "dimension.evaluate" => dimension_evaluate_op(req, files),
        #[cfg(feature = "cad")]
        "edge.pick" => edge_pick_op(req, files),
        #[cfg(feature = "cad")]
        "edge.chamfer" => edge_op(req, enc, files, false),
        #[cfg(feature = "cad")]
        "edge.fillet" => edge_op(req, enc, files, true),
        #[cfg(feature = "cad")]
        "edge.chamfer.preview" => edge_preview_op(req, enc, files, false),
        #[cfg(feature = "cad")]
        "edge.fillet.preview" => edge_preview_op(req, enc, files, true),
        #[cfg(feature = "holes")]
        "hole.find" => hole_find_op(req, files),
        #[cfg(feature = "holes")]
        "hole.apply" => hole_apply_op(req, enc, files),
        #[cfg(feature = "shell")]
        "shell" => shell_op(req, enc, files),
        #[cfg(feature = "threads")]
        "thread.find" => thread_find_op(req, files),
        #[cfg(feature = "threads")]
        "thread.apply" => thread_apply_op(req, enc, files),
        #[cfg(feature = "cad")]
        "sketch.fillet" => sketch_corner_op(req, true),
        #[cfg(feature = "cad")]
        "sketch.chamfer" => sketch_corner_op(req, false),
        _ => return None,
    })
}

fn boolean_op(req: &Value, enc: MeshOut, files: FileLoader<'_>) -> Result<Value> {
    let op: BoolOp = field(req, "op")?;
    let a = items(req, "a", files)?;
    let b = items(req, "b", files)?;
    let Some(first) = a.first() else {
        return Err(Error::invalid("a", "needs at least one mesh"));
    };
    if op != BoolOp::Union && b.is_empty() {
        return Err(Error::invalid(
            "b",
            "difference and intersection need a second mesh",
        ));
    }
    let opts: BooleanOptions = field_or_default(req, "options")?;
    let wa: Vec<TriMesh> = a.iter().map(Item::world).collect();
    let wb: Vec<TriMesh> = b.iter().map(Item::world).collect();
    let (m, r) = boolean::boolean(&wa, &wb, op, &opts)?;
    let mut v = mesh_report(&first.to_local(&m)?, enc);
    insert(&mut v, "report", to_value(&r)?);
    Ok(v)
}

fn array_op(req: &Value, enc: MeshOut, files: FileLoader<'_>) -> Result<Value> {
    let it = item_field(req, "mesh", files)?;
    let spec: ArraySpec = field(req, "spec")?;
    let world = it.world();
    let ts = array::transforms_for(&world, &spec)?;
    let transforms: Vec<Mat4> = ts.iter().map(|t| xform::mul(t, &it.transform)).collect();
    let mut v = json!({
        "count": ts.len(),
        "transforms": transforms,
        "overlapping": array::overlapping(&world, &ts),
    });
    if field_or(req, "merge", false)? {
        let opts: BooleanOptions = field_or_default(req, "options")?;
        let (m, r) = array::merged(&world, &ts, &opts)?;
        let merged = mesh_report(&it.to_local(&m)?, enc);
        if let (Some(o), Value::Object(extra)) = (v.as_object_mut(), merged) {
            o.extend(extra);
        }
        insert(&mut v, "report", to_value(&r)?);
    }
    Ok(v)
}

fn measure_op(req: &Value) -> Result<Value> {
    let a: Feature = field(req, "a")?;
    let b: Option<Feature> = field_or(req, "b", None)?;
    to_value(&measure::measure(&a, b.as_ref()))
}

fn feature_op(req: &Value, files: FileLoader<'_>) -> Result<Value> {
    let it = item_field(req, "mesh", files)?;
    let pick: Pick = field(req, "pick")?;
    let snap: f64 = field_or(req, "snapMm", 0.0)?;
    if !(snap.is_finite() && snap >= 0.0) {
        return Err(Error::invalid("snapMm", "must be 0 or more"));
    }
    let f = measure::resolve(&it.world(), pick, snap)?;
    Ok(json!({ "feature": to_value(&f)? }))
}

#[cfg(feature = "cad")]
fn face_pick_op(req: &Value, files: FileLoader<'_>) -> Result<Value> {
    let it = item_field(req, "mesh", files)?;
    let triangle: u32 = field(req, "triangle")?;
    let at = field(req, "at")?;
    to_value(&face::pick_face(&it.world(), triangle, at)?)
}

#[cfg(feature = "cad")]
fn profile_op(req: &Value) -> Result<Value> {
    let shape: Shape = field(req, "shape")?;
    let at: Placement = field_or_default(req, "placement")?;
    let font = font(req)?;
    let polys = face::profile(&shape, &at, font.as_deref())?;
    Ok(json!({ "polygons": to_value(&polys)? }))
}

#[cfg(feature = "cad")]
fn extrude_op(req: &Value, enc: MeshOut, files: FileLoader<'_>) -> Result<Value> {
    let frame: FaceFrame = field_or(req, "frame", FaceFrame::bed([0.0, 0.0]))?;
    let shape: Shape = field(req, "shape")?;
    let at: Placement = field_or_default(req, "placement")?;
    let spec: ExtrudeSpec = field(req, "spec")?;
    let target = match req.get("target") {
        None | Some(Value::Null) => None,
        Some(v) => Some(item(v, "target", files)?),
    };
    let pattern: Option<face::Pattern> = field_or_default(req, "pattern")?;
    let font = font(req)?;
    let world = target.as_ref().map(Item::world);
    let r = face::extrude_pattern(
        &frame,
        &shape,
        &at,
        font.as_deref(),
        &spec,
        world.as_ref(),
        pattern.as_ref(),
    )?;
    tool_reply(r, target.as_ref(), spec.operation, enc)
}

#[cfg(feature = "cad")]
fn tool_reply(
    r: face::ExtrudeResult,
    target: Option<&Item>,
    op: face::Operation,
    enc: MeshOut,
) -> Result<Value> {
    let (mesh, local) = match (target, op) {
        (Some(t), face::Operation::Join | face::Operation::Cut) => (t.to_local(&r.mesh)?, true),
        _ => (r.mesh, false),
    };
    let mut v = mesh_report(&mesh, enc);
    insert(&mut v, "frame", json!(if local { "target" } else { "world" }));
    insert(&mut v, "tool", enc.mesh(&r.tool));
    insert(&mut v, "report", to_value(&r.report)?);
    Ok(v)
}

#[cfg(feature = "cad")]
fn dimension_anchor_op(req: &Value, files: FileLoader<'_>) -> Result<Value> {
    let object: String = field(req, "object")?;
    let it = item_field(req, "mesh", files)?;
    let pick: Pick = field(req, "pick")?;
    let snap: f64 = field_or(req, "snapMm", 0.0)?;
    if !(snap.is_finite() && snap >= 0.0) {
        return Err(Error::invalid("snapMm", "must be 0 or more"));
    }
    let (anchor, feature) = dimension::anchor(&object, &it.mesh, &it.transform, pick, snap)?;
    Ok(json!({ "anchor": to_value(&anchor)?, "feature": to_value(&feature)? }))
}

#[cfg(feature = "cad")]
fn dimension_evaluate_op(req: &Value, files: FileLoader<'_>) -> Result<Value> {
    let dims: Vec<dimension::Dimension> = field(req, "dimensions")?;
    let moves: Vec<dimension::ObjectMove> = field_or_default(req, "moves")?;
    let mut owned = Vec::new();
    if let Some(Value::Object(map)) = req.get("objects") {
        for (id, v) in map {
            owned.push((id.clone(), item(v, "objects", files)?));
        }
    }
    let objects: HashMap<&str, dimension::Object<'_>> = owned
        .iter()
        .map(|(id, it)| {
            (
                id.as_str(),
                dimension::Object {
                    mesh: &it.mesh,
                    transform: it.transform,
                },
            )
        })
        .collect();
    Ok(json!({ "dimensions": to_value(&dimension::evaluate(&dims, &objects, &moves))? }))
}

#[cfg(feature = "cad")]
fn loops(req: &Value) -> Result<Vec<sketch::Loop>> {
    field(req, "loops")
}

#[cfg(feature = "cad")]
fn sketch_revolve_op(req: &Value, enc: MeshOut, files: FileLoader<'_>) -> Result<Value> {
    #[derive(serde::Deserialize)]
    struct Axis {
        point: V2,
        direction: V2,
    }
    let frame: FaceFrame = field_or(req, "frame", FaceFrame::bed([0.0, 0.0]))?;
    let axis: Axis = field(req, "axis")?;
    let angle: f64 = field_or(req, "angleDeg", 360.0)?;
    let op: face::Operation = field_or_default(req, "operation")?;
    let target = match req.get("target") {
        None | Some(Value::Null) => None,
        Some(v) => Some(item(v, "target", files)?),
    };
    let polys = sketch::polygons(&loops(req)?)?;
    let tool = sketch::revolve(&frame.checked()?, &polys, axis.point, axis.direction, angle)?;
    let world = target.as_ref().map(Item::world);
    let r = face::apply(tool, op, world.as_ref())?;
    tool_reply(r, target.as_ref(), op, enc)
}

#[cfg(feature = "cad")]
fn sketch_snaps_op(req: &Value, files: FileLoader<'_>) -> Result<Value> {
    let frame: FaceFrame = field(req, "frame")?;
    let outline: Vec<Polygon> = field_or_default(req, "outline")?;
    let meshes: Vec<TriMesh> = items(req, "meshes", files)?.iter().map(Item::world).collect();
    let near: f64 = field_or(req, "nearMm", 0.01)?;
    to_value(&sketch::snaps(&frame.checked()?, &outline, &meshes, near))
}

#[cfg(feature = "cad")]
fn sketch_offset_op(req: &Value) -> Result<Value> {
    let polys: Vec<Polygon> = if req.get("loops").is_some() {
        sketch::polygons(&loops(req)?)?
    } else {
        field(req, "polygons")?
    };
    let d: f64 = field(req, "distanceMm")?;
    let join: sketch::Join = field_or_default(req, "join")?;
    let out = sketch::offset(&polys, d, join)?;
    let area: f64 = out.iter().map(Polygon::area).sum();
    Ok(json!({ "polygons": to_value(&out)?, "areaMm2": area }))
}

#[cfg(feature = "cad")]
fn text_op(req: &Value, enc: MeshOut) -> Result<Value> {
    let text: String = field(req, "text")?;
    let height: f64 = field(req, "heightMm")?;
    if !(height.is_finite() && height > 0.0 && height <= 10_000.0) {
        return Err(Error::invalid("heightMm", "between 0 and 10000 mm"));
    }
    let opts: TextOptions = field_or_default(req, "options")?;
    let frame: FaceFrame = field_or(req, "frame", FaceFrame::bed([0.0, 0.0]))?;
    let font = font(req)?;
    let shape = outline::text_shape(&text, font.as_deref(), &opts)?;
    if shape.polygons.is_empty() {
        return Err(Error::invalid("text", "no visible characters"));
    }
    let m = build::extrude(&shape.polygons, &frame.checked()?, 0.0, height)?;
    let mut v = mesh_report(&m, enc);
    insert(&mut v, "min", json!(shape.min));
    insert(&mut v, "max", json!(shape.max));
    insert(&mut v, "missing", json!(shape.missing));
    Ok(v)
}

fn import_auto_op(req: &Value, enc: MeshOut, files: FileLoader<'_>) -> Result<Value> {
    let model = read_model(req, files)?;
    let opts: AutoOptions = field_or_default(req, "auto")?;
    let r = auto::auto_import(auto::objects_of(&model), &model.unit, &opts)?;
    let mut objects = Vec::with_capacity(r.objects.len());
    for o in &r.objects {
        let parts: Vec<Value> = o
            .parts
            .iter()
            .map(|p| {
                json!({
                    "name": p.name, "slot": p.slot, "color": p.color, "mesh": enc.mesh(&p.mesh),
                    "watertight": p.mesh.edge_report().is_watertight(),
                })
            })
            .collect();
        objects.push(json!({ "name": o.name, "parts": parts, "repair": to_value(&o.repair)? }));
    }
    let mut warnings = model.warnings.clone();
    warnings.extend(r.warnings.iter().cloned());
    Ok(json!({
        "name": model.name,
        "format": model.format,
        "objects": objects,
        "unit": to_value(&r.unit)?,
        "summary": r.summary,
        "warnings": warnings,
        "slotColors": model.slot_colors,
    }))
}

fn fit_op(req: &Value, files: FileLoader<'_>) -> Result<Value> {
    let m = plate_mesh(req, files)?;
    let opts: FitOptions = parse(req)?;
    to_value(&fit::fit_check(&m, &opts)?)
}

#[cfg(feature = "cad")]
fn push_op(req: &Value, enc: MeshOut, files: FileLoader<'_>) -> Result<Value> {
    let it = item_field(req, "mesh", files)?;
    let triangle: u32 = field(req, "triangle")?;
    let at = field(req, "at")?;
    let d: f64 = field(req, "distanceMm")?;
    let opts: BooleanOptions = field_or_default(req, "options")?;
    let r = push::push_face(&it.world(), triangle, at, d, &opts)?;
    let mut v = mesh_report(&it.to_local(&r.mesh)?, enc);
    insert(&mut v, "tool", enc.mesh(&r.tool));
    insert(&mut v, "operation", json!(r.operation));
    insert(&mut v, "report", to_value(&r.report)?);
    insert(&mut v, "moved", to_value(&r.moved)?);
    Ok(v)
}

#[cfg(feature = "cad")]
fn push_preview_op(req: &Value, enc: MeshOut) -> Result<Value> {
    let frame: FaceFrame = field(req, "frame")?;
    let outline: Vec<Polygon> = field(req, "outline")?;
    let d: f64 = field(req, "distanceMm")?;
    let (tool, op) = push::preview(&frame, &outline, d)?;
    Ok(json!({ "tool": enc.mesh(&tool), "operation": op }))
}

#[cfg(feature = "cad")]
fn edge_pick_op(req: &Value, files: FileLoader<'_>) -> Result<Value> {
    let it = item_field(req, "mesh", files)?;
    let triangle: u32 = field(req, "triangle")?;
    let at = field(req, "at")?;
    let world = it.world();
    let mut p = edge::pick_edge(&world, triangle, at)?;
    // Every reference names its two faces by key too, so a history step finds it after an earlier step changes.
    p.edge = edge::keyed(&world, &p.edge);
    for e in &mut p.chain {
        *e = edge::keyed(&world, e);
    }
    for l in &mut p.ring {
        l.edge = edge::keyed(&world, &l.edge);
    }
    to_value(&p)
}

#[cfg(feature = "holes")]
fn hole_find_op(req: &Value, files: FileLoader<'_>) -> Result<Value> {
    let it = item_field(req, "mesh", files)?;
    let triangle: u32 = field(req, "triangle")?;
    let at = field(req, "at")?;
    to_value(&hole::find(&it.world(), triangle, at)?)
}

#[cfg(feature = "holes")]
fn hole_apply_op(req: &Value, enc: MeshOut, files: FileLoader<'_>) -> Result<Value> {
    let it = item_field(req, "mesh", files)?;
    let h: Hole = field(req, "hole")?;
    let spec: HoleSpec = field(req, "spec")?;
    let opts: BooleanOptions = field_or_default(req, "options")?;
    let (m, r) = hole::apply(&it.world(), &h, &spec, &opts)?;
    let mut v = mesh_report(&it.to_local(&m)?, enc);
    insert(&mut v, "report", to_value(&r)?);
    Ok(v)
}

/// The body hollowed to `wallMm` with the faces at `open` (world points and normals) left open.
#[cfg(feature = "shell")]
fn shell_op(req: &Value, enc: MeshOut, files: FileLoader<'_>) -> Result<Value> {
    let it = item_field(req, "mesh", files)?;
    let open: Vec<OpenFace> = field_or_default(req, "open")?;
    let wall: f64 = field(req, "wallMm")?;
    let opts: BooleanOptions = field_or_default(req, "options")?;
    let (m, r) = shell::shell(&it.world(), &open, wall, &opts)?;
    let mut v = mesh_report(&it.to_local(&m)?, enc);
    insert(&mut v, "report", to_value(&r)?);
    Ok(v)
}

/// The round surface under a pick, with the size that suits it and every size there is.
#[cfg(feature = "threads")]
fn thread_find_op(req: &Value, files: FileLoader<'_>) -> Result<Value> {
    let it = item_field(req, "mesh", files)?;
    let triangle: u32 = field(req, "triangle")?;
    let at = field(req, "at")?;
    let t = thread::find(&it.world(), triangle, at)?;
    let mut v = to_value(&t)?;
    insert(&mut v, "suggested", json!(thread::suggest(&t)));
    let sizes: Vec<Value> = thread::ISO_COARSE
        .iter()
        .map(|(name, major, pitch)| json!({ "name": name, "majorMm": major, "pitchMm": pitch }))
        .collect();
    insert(&mut v, "sizes", Value::Array(sizes));
    Ok(v)
}

#[cfg(feature = "threads")]
fn thread_apply_op(req: &Value, enc: MeshOut, files: FileLoader<'_>) -> Result<Value> {
    let it = item_field(req, "mesh", files)?;
    let target: ThreadTarget = field(req, "thread")?;
    let spec: ThreadSpec = field(req, "spec")?;
    let opts: BooleanOptions = field_or_default(req, "options")?;
    let (m, r) = thread::apply(&it.world(), &target, &spec, &opts)?;
    let mut v = mesh_report(&it.to_local(&m)?, enc);
    insert(&mut v, "report", to_value(&r)?);
    Ok(v)
}

#[cfg(feature = "cad")]
fn edge_profile(req: &Value, fillet: bool) -> Result<edge::Profile> {
    if fillet {
        let radius: f64 = field(req, "radiusMm")?;
        let tolerance: f64 = field_or(req, "toleranceMm", edge::DEFAULT_TOLERANCE_MM)?;
        Ok(edge::Profile::Fillet { radius, tolerance })
    } else {
        let d1: f64 = field(req, "distanceMm")?;
        let d2: f64 = field_or(req, "distance2Mm", d1)?;
        Ok(edge::Profile::Chamfer { d1, d2 })
    }
}

#[cfg(feature = "cad")]
fn edge_op(req: &Value, enc: MeshOut, files: FileLoader<'_>, fillet: bool) -> Result<Value> {
    let it = item_field(req, "mesh", files)?;
    let edges: Vec<edge::EdgeRef> = field(req, "edges")?;
    let profile = edge_profile(req, fillet)?;
    let opts: BooleanOptions = field_or_default(req, "options")?;
    let r = edge::apply(&it.world(), &edges, profile, &opts)?;
    let mut v = mesh_report(&it.to_local(&r.mesh)?, enc);
    insert(&mut v, "report", to_value(&r.report)?);
    insert(&mut v, "edges", to_value(&r.edges)?);
    insert(&mut v, "corners", to_value(&r.corners)?);
    insert(&mut v, "refs", to_value(&r.refs)?);
    insert(&mut v, "notes", to_value(&r.notes)?);
    Ok(v)
}

#[cfg(feature = "cad")]
fn edge_preview_op(req: &Value, enc: MeshOut, files: FileLoader<'_>, fillet: bool) -> Result<Value> {
    let it = item_field(req, "mesh", files)?;
    let edges: Vec<edge::EdgeRef> = field(req, "edges")?;
    let profile = edge_profile(req, fillet)?;
    let (cut, join) = edge::preview(&it.world(), &edges, profile)?;
    Ok(json!({ "cut": enc.mesh(&cut), "join": enc.mesh(&join) }))
}

#[cfg(feature = "cad")]
fn sketch_corner_op(req: &Value, fillet: bool) -> Result<Value> {
    let lps = loops(req)?;
    let corners: Vec<sketch_corner::CornerRef> = field(req, "corners")?;
    let cut = if fillet {
        sketch_corner::CornerCut::Fillet(field(req, "radiusMm")?)
    } else {
        let d1: f64 = field(req, "distanceMm")?;
        sketch_corner::CornerCut::Chamfer(d1, field_or(req, "distance2Mm", d1)?)
    };
    to_value(&sketch_corner::corners(&lps, &corners, cut)?)
}

#[cfg(all(test, feature = "cad", feature = "holes"))]
mod tests {
    use crate::build;
    use crate::fm::Fm as _;
    use crate::json::{MeshOut, base64_encode, call};
    use serde_json::{Value, json};

    fn run(op: &str, req: &Value) -> Value {
        serde_json::from_str(&call(op, &req.to_string()).unwrap_or_else(|e| panic!("{op}: {e}"))).unwrap()
    }

    fn cube(min: [f64; 3], s: f64) -> Value {
        MeshOut::Flat.mesh(&build::box_mesh(min, [min[0] + s, min[1] + s, min[2] + s]))
    }

    fn translate(d: [f64; 3]) -> Value {
        json!([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, d[0], d[1], d[2], 1])
    }

    #[test]
    fn boolean_in_the_first_items_frame() {
        let req = json!({
            "op": "difference",
            "a": [{ "mesh": cube([0.0; 3], 10.0), "transform": translate([100.0, 0.0, 0.0]) }],
            "b": { "mesh": cube([0.0; 3], 10.0), "transform": translate([105.0, 5.0, 5.0]) },
        });
        let out = run("boolean", &req);
        assert!(
            (out["volumeMm3"].as_f64().unwrap() - 875.0).abs() < 1e-6,
            "{}",
            out["volumeMm3"]
        );
        assert_eq!(out["watertight"], true);
        assert!(out["bounds"]["min"][0].as_f64().unwrap().abs() < 1e-6);
        assert_eq!(out["report"]["shells"], 1);
        let err = call(
            "boolean",
            &json!({ "op": "difference", "a": [cube([0.0; 3], 1.0)] }).to_string(),
        );
        assert!(err.is_err());
    }

    #[test]
    fn faces_go_in_and_come_out_when_asked() {
        let tagged = |min: [f64; 3], s: f64| {
            MeshOut::FlatFaces.mesh(&build::box_mesh(min, [min[0] + s, min[1] + s, min[2] + s]))
        };
        assert_eq!(
            tagged([0.0; 3], 1.0)["faces"]["table"].as_array().unwrap().len(),
            6
        );
        let req = |with: bool| {
            json!({
                "op": "difference",
                "a": [{ "mesh": tagged([0.0; 3], 10.0), "transform": translate([100.0, 0.0, 0.0]) }],
                "b": { "mesh": tagged([3.0, 3.0, 2.0], 4.0), "transform": translate([100.0, 0.0, 5.0]) },
                "withFaces": with,
            })
        };
        let out = run("boolean", &req(true));
        // The block's six sides, the pocket's four walls and its floor, in the first item's frame.
        let faces = &out["mesh"]["faces"];
        assert_eq!(faces["table"].as_array().unwrap().len(), 11, "{faces}");
        assert_eq!(
            faces["ids"].as_array().unwrap().len() * 3,
            out["mesh"]["indices"].as_array().unwrap().len()
        );
        let floor = faces["table"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| {
                s["kind"] == "plane"
                    && s["normal"][2].as_f64().unwrap() > 0.5
                    && s["offset"].as_f64().unwrap() < 9.0
            })
            .unwrap();
        assert!((floor["offset"].as_f64().unwrap() - 7.0).abs() < 1e-6, "{floor}");
        assert!(run("boolean", &req(false))["mesh"].get("faces").is_none());
    }

    #[test]
    fn faces_that_do_not_fit_their_mesh_are_found_again() {
        let mut stale = MeshOut::FlatFaces.mesh(&build::box_mesh([0.0; 3], [10.0; 3]));
        // The caller moved the box without its faces.
        let moved: Vec<f64> = stale["positions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap() + 3.0)
            .collect();
        stale["positions"] = json!(moved);
        let mut short = MeshOut::FlatFaces.mesh(&build::box_mesh([0.0; 3], [10.0; 3]));
        short["faces"]["ids"].as_array_mut().unwrap().pop();
        for (mesh, right) in [(stale, 13.0), (short, 10.0)] {
            let out = run(
                "boolean",
                &json!({ "op": "union", "a": [mesh], "withFaces": true }),
            );
            let table = out["mesh"]["faces"]["table"].as_array().unwrap().clone();
            assert_eq!(table.len(), 6, "{table:?}");
            let side = table
                .iter()
                .find(|s| s["normal"][0].as_f64().unwrap() > 0.5)
                .unwrap();
            assert!((side["offset"].as_f64().unwrap() - right).abs() < 1e-6, "{side}");
        }
    }

    #[cfg(feature = "shell")]
    #[test]
    fn a_box_shelled_open_at_the_top_through_the_worker() {
        let m = build::box_mesh([0.0; 3], [40.0, 30.0, 20.0]);
        let item = json!({ "mesh": MeshOut::Flat.mesh(&m), "transform": translate([100.0, 0.0, 0.0]) });
        let out = run(
            "shell",
            &json!({ "mesh": item, "open": [{ "at": [105.0, 5.0, 20.0], "normal": [0, 0, 1] }], "wallMm": 2 }),
        );
        assert_eq!(out["watertight"], true);
        assert_eq!(out["report"]["exact"], true);
        assert_eq!(out["report"]["openFaces"], 1);
        let want = 40.0 * 30.0 * 20.0 - 36.0 * 26.0 * 18.0;
        assert!(
            (out["volumeMm3"].as_f64().unwrap() - want).abs() < 1e-3,
            "{}",
            out["volumeMm3"]
        );
        // In the item's own frame, as other ops reply.
        assert!(out["bounds"]["min"][0].as_f64().unwrap().abs() < 1e-6);
    }

    #[cfg(feature = "threads")]
    #[test]
    fn a_rod_found_and_threaded_through_the_worker() {
        let f = crate::vec3::Frame::WORLD;
        let m = build::cylinder(&f, 4.0, 0.0, 20.0, 64);
        let t = m
            .triangles
            .iter()
            .position(|&t| m.normal(t)[2].abs() < 1e-6)
            .unwrap();
        let c = m.corners(m.triangles[t]);
        let item = json!({ "mesh": MeshOut::Flat.mesh(&m), "transform": translate([100.0, 0.0, 0.0]) });
        let at = [c[0][0] + 100.0, c[0][1], 19.0];
        let found = run("thread.find", &json!({ "mesh": item, "triangle": t, "at": at }));
        assert_eq!(found["internal"], false);
        assert_eq!(found["suggested"], "M8");
        assert_eq!(found["sizes"].as_array().unwrap().len(), 11);
        assert_eq!(
            found["sizes"][4],
            json!({ "name": "M8", "majorMm": 8.0, "pitchMm": 1.25 })
        );
        assert!(
            (found["start"][0].as_f64().unwrap() - 100.0).abs() < 1e-6,
            "{found}"
        );
        let out = run(
            "thread.apply",
            &json!({ "mesh": item, "thread": found, "spec": { "size": "M8", "clearanceMm": 0.1 } }),
        );
        assert_eq!(out["watertight"], true);
        assert_eq!(out["report"]["size"], "M8");
        assert!((out["report"]["maxLayerMm"].as_f64().unwrap() - 0.3125).abs() < 1e-9);
        // In the item's own frame, as other ops reply.
        assert!(
            (out["bounds"]["min"][0].as_f64().unwrap() + 3.9).abs() < 0.01,
            "{}",
            out["bounds"]
        );
    }

    #[test]
    fn a_pattern_of_holes_in_one_extrude_call() {
        let m = build::box_mesh([0.0; 3], [60.0, 40.0, 5.0]);
        let item = json!({ "mesh": MeshOut::Flat.mesh(&m), "transform": translate([100.0, 0.0, 0.0]) });
        let frame =
            json!({ "origin": [130.0, 20.0, 5.0], "normal": [0, 0, 1], "u": [1, 0, 0], "v": [0, 1, 0] });
        let req = |pattern: Value| {
            json!({ "frame": frame, "shape": { "type": "circle", "diameterMm": 4 }, "placement": { "center": [-20, -10] },
                "spec": { "distanceMm": 5, "operation": "cut" }, "target": item, "pattern": pattern })
        };
        let one = 12_000.0
            - run("shape.extrude", &req(Value::Null))["volumeMm3"]
                .as_f64()
                .unwrap();
        let out = run(
            "shape.extrude",
            &req(json!({ "kind": "linear", "count": 3, "stepMm": [20, 0], "count2": 2, "step2Mm": [0, 20] })),
        );
        assert_eq!(out["watertight"], true);
        let removed = 12_000.0 - out["volumeMm3"].as_f64().unwrap();
        assert!((removed - 6.0 * one).abs() < 1e-3, "{removed} vs {}", 6.0 * one);
        let bad = call(
            "shape.extrude",
            &req(json!({ "kind": "spiral", "count": 3 })).to_string(),
        )
        .unwrap_err()
        .to_string();
        assert!(bad.contains("pattern"), "{bad}");
    }

    #[test]
    fn a_hole_found_and_made_smaller_through_the_worker() {
        let plate = build::box_mesh([0.0; 3], [30.0, 20.0, 5.0]);
        let f = crate::vec3::Frame {
            origin: [15.0, 10.0, 0.0],
            ..crate::vec3::Frame::WORLD
        };
        let bore = build::cylinder(&f, 3.0, -1.0, 6.0, 48);
        let m = crate::boolean::boolean(
            &[plate],
            &[bore],
            crate::boolean::BoolOp::Difference,
            &crate::boolean::BooleanOptions::default(),
        )
        .unwrap()
        .0;
        let t = m
            .triangles
            .iter()
            .position(|&t| {
                let c = m.corners(t);
                m.normal(t)[2].abs() < 1e-6 && c.iter().all(|p| (p[0] - 15.0).m_hypot(p[1] - 10.0) < 3.5)
            })
            .unwrap();
        let c = m.corners(m.triangles[t]);
        let at = [c[0][0], c[0][1], 4.9];
        let item = json!({ "mesh": MeshOut::Flat.mesh(&m), "transform": translate([100.0, 0.0, 0.0]) });
        let world_at = [at[0] + 100.0, at[1], at[2]];
        let found = run(
            "hole.find",
            &json!({ "mesh": item, "triangle": t, "at": world_at }),
        );
        assert_eq!(found["through"], true);
        assert!(
            (found["diameterMm"].as_f64().unwrap() - 6.0).abs() < 1e-6,
            "{found}"
        );
        assert!(
            (found["entry"][0].as_f64().unwrap() - 115.0).abs() < 1e-6,
            "{found}"
        );
        let out = run(
            "hole.apply",
            &json!({ "mesh": item, "hole": found, "spec": { "diameterMm": 3.4 } }),
        );
        assert_eq!(out["watertight"], true);
        let hole = std::f64::consts::PI * 1.7 * 1.7 * 5.0;
        assert!(
            (out["volumeMm3"].as_f64().unwrap() - (3000.0 - hole)).abs() < 0.02 * hole,
            "{}",
            out["volumeMm3"]
        );
        // In the item's own frame, as other ops reply.
        assert!(out["bounds"]["min"][0].as_f64().unwrap().abs() < 1e-6);
    }

    #[test]
    fn array_transforms_and_merge() {
        let req = json!({
            "mesh": { "mesh": cube([0.0; 3], 10.0), "transform": translate([0.0, 0.0, 0.0]) },
            "spec": { "kind": "linear", "count": 3, "step": [8, 0, 0] },
            "merge": true,
        });
        let out = run("array", &req);
        assert_eq!(out["count"], 3);
        assert_eq!(out["overlapping"], true);
        assert_eq!(out["transforms"][2][12], 16.0);
        assert!((out["volumeMm3"].as_f64().unwrap() - 2600.0).abs() < 1e-6);
        assert_eq!(out["shells"], 1);
    }

    #[test]
    fn measure_a_moved_part() {
        let mesh = json!({ "mesh": cube([0.0; 3], 10.0), "transform": translate([20.0, 0.0, 0.0]) });
        let top = run(
            "measure.feature",
            &json!({ "mesh": mesh, "pick": { "triangle": 2, "at": [25.0, 5.0, 10.0] } }),
        );
        assert_eq!(top["feature"]["kind"], "plane", "{top}");
        let bottom = run(
            "measure.feature",
            &json!({ "mesh": mesh, "pick": { "triangle": 0, "at": [25.0, 5.0, 0.0] } }),
        );
        let m = run("measure", &json!({ "a": top["feature"], "b": bottom["feature"] }));
        assert!((m["distanceMm"].as_f64().unwrap() - 10.0).abs() < 1e-9, "{m}");
    }

    #[test]
    fn face_pick_and_cut_a_hole() {
        let mesh = json!({ "mesh": cube([0.0; 3], 20.0), "transform": translate([50.0, 0.0, 0.0]) });
        let pick = run(
            "face.pick",
            &json!({ "mesh": mesh, "triangle": 2, "at": [60.0, 10.0, 20.0] }),
        );
        assert!((pick["areaMm2"].as_f64().unwrap() - 400.0).abs() < 1e-9);
        let out = run(
            "shape.extrude",
            &json!({
                "frame": pick["frame"],
                "shape": { "type": "circle", "diameterMm": 6.0 },
                "spec": { "distanceMm": 5.0, "operation": "cut" },
                "target": mesh,
            }),
        );
        assert_eq!(out["frame"], "target");
        assert_eq!(out["watertight"], true);
        let removed = 8000.0 - out["volumeMm3"].as_f64().unwrap();
        assert!(
            (removed - std::f64::consts::PI * 9.0 * 5.0).abs() < 1.0,
            "{removed}"
        );
        assert!(out["bounds"]["max"][0].as_f64().unwrap() < 20.0 + 1e-6);
        let prof = run(
            "shape.profile",
            &json!({ "shape": { "type": "slot", "lengthMm": 20.0, "widthMm": 6.0 } }),
        );
        assert_eq!(prof["polygons"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn push_a_moved_face_and_preview() {
        let mesh = json!({ "mesh": cube([0.0; 3], 20.0), "transform": translate([50.0, 0.0, 0.0]) });
        let pick = run(
            "face.pick",
            &json!({ "mesh": mesh, "triangle": 2, "at": [60.0, 10.0, 20.0] }),
        );
        let pre = run(
            "face.push.preview",
            &json!({ "frame": pick["frame"], "outline": pick["outline"], "distanceMm": 5.0 }),
        );
        assert_eq!(pre["operation"], "join");
        let out = run(
            "face.push",
            &json!({ "mesh": mesh, "triangle": 2, "at": [60.0, 10.0, 20.0], "distanceMm": 5.0 }),
        );
        assert_eq!(out["watertight"], true);
        assert!((out["volumeMm3"].as_f64().unwrap() - 10_000.0).abs() < 1e-6);
        assert!(out["bounds"]["min"][0].as_f64().unwrap().abs() < 1e-6);
        assert!((out["bounds"]["max"][2].as_f64().unwrap() - 25.0).abs() < 1e-6);
        assert!((out["moved"]["distanceMm"].as_f64().unwrap() - 5.0).abs() < 1e-12);
        let err = call(
            "face.push",
            &json!({ "mesh": mesh, "triangle": 2, "at": [60.0, 10.0, 20.0], "distanceMm": 0 }).to_string(),
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("must not be zero"), "{err}");
    }

    #[test]
    fn sketch_check_extrude_revolve_offset_and_snaps() {
        let l = json!([
            { "start": [-10, -5], "segments": [
                { "type": "line", "lengthMm": 20, "angleDeg": 0 },
                { "type": "arc", "radiusMm": 5, "sweepDeg": 180 },
                { "type": "line", "lengthMm": 20, "angleDeg": 180 },
                { "type": "arc", "radiusMm": 5, "sweepDeg": 180 },
            ]},
            { "type": "circle", "center": [0, 0], "diameterMm": 4 },
        ]);
        let c = run("sketch.check", &json!({ "loops": l }));
        assert_eq!(c["ok"], true, "{c}");
        assert_eq!(c["loops"][1]["role"], "hole");
        let mesh = json!({ "mesh": cube([0.0; 3], 40.0), "transform": translate([0.0, 0.0, 0.0]) });
        let pick = run(
            "face.pick",
            &json!({ "mesh": mesh, "triangle": 2, "at": [20.0, 20.0, 40.0] }),
        );
        let out = run(
            "shape.extrude",
            &json!({
                "frame": pick["frame"], "shape": { "type": "sketch", "loops": l },
                "spec": { "distanceMm": 3.0, "operation": "cut", "taperDeg": 5.0 }, "target": mesh,
            }),
        );
        assert_eq!(out["watertight"], true);
        assert!(
            out["report"]["volumeChangeMm3"].as_f64().unwrap() < -100.0,
            "{}",
            out["report"]
        );
        let bad = json!([{ "points": [[0, 0], [10, 10], [10, 0], [0, 10]] }]);
        let err = call(
            "shape.extrude",
            &json!({ "shape": { "type": "sketch", "loops": bad }, "spec": { "distanceMm": 2.0 } })
                .to_string(),
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("segment 3 crosses segment 1"), "{err}");
        let rect = json!([{ "points": [[5, 0], [10, 0], [10, 2], [5, 2]] }]);
        let rev = run(
            "sketch.revolve",
            &json!({ "loops": rect, "axis": { "point": [0, 0], "direction": [0, 1] } }),
        );
        assert_eq!(rev["watertight"], true);
        let v = std::f64::consts::PI * 75.0 * 2.0;
        assert!((rev["volumeMm3"].as_f64().unwrap() - v).abs() < 0.01 * v);
        let off = run(
            "sketch.offset",
            &json!({ "loops": rect, "distanceMm": 1.0, "join": "miter" }),
        );
        assert!((off["areaMm2"].as_f64().unwrap() - 28.0).abs() < 1e-3, "{off}");
        let snaps = run(
            "sketch.snaps",
            &json!({ "frame": pick["frame"], "outline": pick["outline"] }),
        );
        assert_eq!(
            snaps["points"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|p| p["kind"] == "vertex")
                .count(),
            4
        );
    }

    #[test]
    fn dimension_anchor_push_and_evaluate() {
        let mesh = json!({ "mesh": cube([0.0; 3], 20.0), "transform": translate([50.0, 0.0, 0.0]) });
        let top = run(
            "dimension.anchor",
            &json!({ "object": "c", "mesh": mesh, "pick": { "triangle": 2, "at": [60.0, 10.0, 20.0] } }),
        );
        let bottom = run(
            "dimension.anchor",
            &json!({ "object": "c", "mesh": mesh, "pick": { "triangle": 0, "at": [60.0, 10.0, 0.0] } }),
        );
        assert!((top["anchor"]["pick"]["at"][0].as_f64().unwrap() - 10.0).abs() < 1e-9);
        let dims = json!([{ "id": "h", "kind": "distance", "a": top["anchor"], "b": bottom["anchor"], "value": 20.0 }]);
        let pushed = run(
            "face.push",
            &json!({ "mesh": mesh, "triangle": 2, "at": [60.0, 10.0, 20.0], "distanceMm": -4.0 }),
        );
        let mut mv = pushed["moved"].clone();
        mv["object"] = json!("c");
        let objects = json!({ "c": { "mesh": pushed["mesh"], "transform": translate([50.0, 0.0, 0.0]) } });
        let r = run(
            "dimension.evaluate",
            &json!({ "dimensions": dims, "objects": objects, "moves": [mv] }),
        );
        let d = &r["dimensions"][0];
        assert_eq!(d["status"], "ok", "{d}");
        assert!((d["value"].as_f64().unwrap() - 16.0).abs() < 1e-6, "{d}");
        assert_eq!(d["changed"], true);
        assert!(d["measurement"]["from"].is_array());
    }

    #[test]
    fn fit_check_finds_a_tight_gap() {
        let out = run(
            "fit.check",
            &json!({
                "meshes": [cube([0.0; 3], 10.0), { "mesh": cube([0.0; 3], 10.0), "transform": translate([10.1, 0.0, 0.0]) }],
                "minGapMm": 0.2, "layerHeightMm": 0.2,
            }),
        );
        assert_eq!(out["gaps"].as_array().unwrap().len(), 1, "{out}");
        assert_eq!(out["gaps"][0]["kind"], "horizontal");
    }

    #[test]
    fn text_body_and_auto_import() {
        let t = run(
            "text.mesh",
            &json!({ "text": "Hi", "heightMm": 2.0, "options": { "sizeMm": 10.0 } }),
        );
        assert_eq!(t["watertight"], true);
        assert!(t["volumeMm3"].as_f64().unwrap() > 0.0);
        let mut m = build::box_mesh([0.0; 3], [10.0, 10.0, 10.0]);
        m.triangles.pop();
        m.append(&build::box_mesh([40.0, 0.0, 0.0], [50.0, 10.0, 10.0]));
        let data = base64_encode(&m.to_stl("test"));
        let out = run(
            "import.auto",
            &json!({ "data": { "base64": data }, "name": "two.stl" }),
        );
        assert_eq!(out["objects"].as_array().unwrap().len(), 2, "{}", out["summary"]);
        assert!(
            out["objects"]
                .as_array()
                .unwrap()
                .iter()
                .all(|o| o["parts"][0]["watertight"] == true)
        );
        assert_eq!(out["unit"]["unit"], "millimeter");
    }

    #[test]
    fn edge_pick_fillet_and_preview_on_a_moved_part() {
        let mesh = json!({ "mesh": cube([0.0; 3], 20.0), "transform": translate([50.0, 0.0, 0.0]) });
        let pick = run(
            "edge.pick",
            &json!({ "mesh": mesh, "triangle": 2, "at": [60.0, 0.5, 20.0] }),
        );
        assert_eq!(pick["supported"], true, "{pick}");
        assert_eq!(pick["convex"], true);
        assert_eq!(pick["loop"].as_array().unwrap().len(), 4);
        let edges = json!([pick["edge"]]);
        let prev = run(
            "edge.fillet.preview",
            &json!({ "mesh": mesh, "edges": edges, "radiusMm": 2 }),
        );
        assert!(prev["join"]["indices"].as_array().unwrap().is_empty());
        assert!(!prev["cut"]["indices"].as_array().unwrap().is_empty());
        let out = run(
            "edge.fillet",
            &json!({ "mesh": mesh, "edges": edges, "radiusMm": 2 }),
        );
        assert_eq!(out["watertight"], true);
        assert_eq!(out["edges"][0]["convex"], true);
        assert!(out["bounds"]["min"][0].as_f64().unwrap().abs() < 1e-9);
        let out = run(
            "edge.chamfer",
            &json!({ "mesh": mesh, "edges": edges, "distanceMm": 2, "distance2Mm": 1 }),
        );
        assert!((out["volumeMm3"].as_f64().unwrap() - 7980.0).abs() < 1e-6);
        let err = call(
            "edge.fillet",
            &json!({ "mesh": mesh, "edges": edges, "radiusMm": 30 }).to_string(),
        )
        .unwrap_err()
        .to_string();
        assert_eq!(
            err,
            "radiusMm: 30 mm does not fit on this face; at most 20.000 mm"
        );
    }

    /// `T * Rz(z) * Rx(x) * S`, column-major, as three.js composes a position, a rotation and a scale
    fn compose(t: [f64; 3], z_deg: f64, x_deg: f64, s: [f64; 3]) -> [f64; 16] {
        use crate::fm::Fm;
        let (sz, cz) = z_deg.to_radians().m_sin_cos();
        let (sx, cx) = x_deg.to_radians().m_sin_cos();
        let c0 = [cz, sz, 0.0];
        let c1 = [-sz * cx, cz * cx, sx];
        let c2 = [sz * sx, -cz * sx, cx];
        [
            c0[0] * s[0],
            c0[1] * s[0],
            c0[2] * s[0],
            0.0,
            c1[0] * s[1],
            c1[1] * s[1],
            c1[2] * s[1],
            0.0,
            c2[0] * s[2],
            c2[1] * s[2],
            c2[2] * s[2],
            0.0,
            t[0],
            t[1],
            t[2],
            1.0,
        ]
    }

    #[test]
    fn edge_refs_survive_the_json_round_trip_at_any_placement() {
        // a 20 mm box as the app holds it: f32 positions, local frame
        #[allow(clippy::cast_possible_truncation, reason = "the app holds f32 positions")]
        let f = |v: f64| f64::from(v as f32);
        let lo = [f(-13.333_333), f(-6.666_667), 0.0];
        let local = build::box_mesh(lo, [lo[0] + 20.0, lo[1] + 20.0, 20.0]);
        let mesh = MeshOut::Flat.mesh(&local);
        let moves = [
            [37.433_333_3, 12.766_666_7, 0.0],
            [27.43, 2.77, 0.0],
            [37.43, 16.1, 0.0],
            [100.0, 100.0, 0.0],
            [37.433_333_3, 12.766_666_666_666_666, 0.0],
            [1.0 / 3.0, -2.0 / 3.0, 0.1],
            [155.55, 211.17, 7.7],
            [-0.1, 0.3, 0.2],
        ];
        let turns = [
            (0.0, 0.0),
            (45.0, 0.0),
            (17.3, 0.0),
            (45.0, 30.0),
            (-123.456, 71.7),
        ];
        let scales = [[1.0, 1.0, 1.0], [0.7, 0.7, 0.7], [2.54, 1.3, 0.6]];
        let mut checked = 0;
        for t in moves {
            for (z, x) in turns {
                for s in scales {
                    let m = compose(t, z, x, s);
                    let item = json!({ "mesh": mesh, "transform": m });
                    let world = crate::xform::transformed(&local, &m);
                    for (i, tri) in world.triangles.iter().enumerate() {
                        let c = tri.map(|v| world.positions[v as usize]);
                        let at: Vec<f64> = (0..3).map(|k| f64::midpoint(c[0][k], c[1][k])).collect();
                        let pick = run("edge.pick", &json!({ "mesh": item, "triangle": i, "at": at }));
                        assert_eq!(pick["supported"], true, "{t:?} {z} {x} {s:?} {i}: {pick}");
                        let req = json!({ "mesh": item, "edges": [pick["edge"]], "radiusMm": 2 });
                        let r = call("edge.fillet.preview", &req.to_string());
                        assert!(r.is_ok(), "{t:?} {z} {x} {s:?} tri {i}: {}", r.unwrap_err());
                        checked += 1;
                        if i == 2 {
                            let out = run("edge.fillet", &req);
                            assert_eq!(out["watertight"], true, "{t:?} {z} {x} {s:?}");
                            let req = json!({ "mesh": item, "edges": pick["loop"].as_array().unwrap().iter().map(|l| l["edge"].clone()).collect::<Vec<_>>(), "distanceMm": 1 });
                            let r = call("edge.chamfer.preview", &req.to_string());
                            assert!(r.is_ok(), "{t:?} {z} {x} {s:?} loop: {}", r.unwrap_err());
                        }
                    }
                }
            }
        }
        assert_eq!(checked, 8 * 5 * 3 * 12);
    }

    #[test]
    fn stale_edge_refs_fail_in_words() {
        let m = compose([37.433_333_3, 12.766_666_7, 0.0], 45.0, 0.0, [1.0; 3]);
        let item = json!({ "mesh": cube([0.0; 3], 20.0), "transform": m });
        let pick = run(
            "edge.pick",
            &json!({ "mesh": item, "triangle": 2, "at": crate::xform::apply(&m, [10.0, 0.5, 20.0]) }),
        );
        let e: crate::edge::EdgeRef = serde_json::from_value(pick["edge"].clone()).unwrap();
        let fail = |edge: crate::edge::EdgeRef| {
            call(
                "edge.fillet.preview",
                &json!({ "mesh": item, "edges": [edge], "radiusMm": 2 }).to_string(),
            )
            .unwrap_err()
            .to_string()
        };
        let gone = "edges: edge 1: no sharp edge between two flat faces there";
        let off = crate::vec3::add(e.a, [0.0, 0.0, -0.01]);
        assert_eq!(fail(crate::edge::EdgeRef { a: off, ..e }), gone);
        let mid = crate::vec3::lerp(e.a, e.b, 0.5);
        assert_eq!(fail(crate::edge::EdgeRef { b: mid, ..e }), gone);
        let past = crate::vec3::lerp(e.a, e.b, 1.1);
        assert_eq!(fail(crate::edge::EdgeRef { b: past, ..e }), gone);
        let near = crate::vec3::add(e.b, [0.0, 0.0, 0.000_5]);
        let ok = call(
            "edge.fillet.preview",
            &json!({ "mesh": item, "edges": [crate::edge::EdgeRef { b: near, ..e }], "radiusMm": 2 })
                .to_string(),
        );
        assert!(ok.is_ok(), "{}", ok.unwrap_err());
    }

    #[test]
    fn sketch_corner_ops() {
        let sq = json!([{ "points": [[0, 0], [10, 0], [10, 10], [0, 10]] }]);
        let out = run(
            "sketch.fillet",
            &json!({ "loops": sq, "corners": [{ "loop": 0, "vertex": 1 }], "radiusMm": 2 }),
        );
        assert_eq!(out["added"][0], json!({ "loop": 0, "segment": 1 }));
        assert_eq!(out["loops"][0]["segments"][1]["type"], "arc");
        let c = run("sketch.check", &json!({ "loops": out["loops"] }));
        assert_eq!(c["ok"], true);
        let out = run(
            "sketch.chamfer",
            &json!({ "loops": sq, "corners": [{ "loop": 0, "vertex": 0 }], "distanceMm": 1 }),
        );
        let c = run("sketch.check", &json!({ "loops": out["loops"] }));
        assert!((c["areaMm2"].as_f64().unwrap() - 99.5).abs() < 1e-9);
    }
}
