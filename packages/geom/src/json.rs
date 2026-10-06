// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! JSON in, JSON out

use crate::error::{Error, Result};
use crate::faces::Faces;
use crate::mesh::TriMesh;
use crate::poly2d::Polygon;
use crate::solids::SolidSpec;
use crate::vec3::{Plane, V3};
use crate::{
    calib, convex, cut, emboss, hollow, import, layers, orient, repair, resume, simplify, split, svg,
};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

pub const OPERATIONS: &[&str] = &[
    "info",
    "section",
    "cut",
    "split",
    "repair",
    "orient.analyze",
    "orient.rank",
    "hollow",
    "emboss",
    "emboss.polygons",
    "calibrate",
    "resume",
    "layers.plan",
    "build",
    "subtract",
    "import",
    "simplify",
    "extrude.svg",
    "text.polygons",
    "boolean",
    "array",
    "measure",
    "measure.feature",
    "face.pick",
    "shape.profile",
    "shape.extrude",
    "text.mesh",
    "import.auto",
    "fit.check",
    "face.push",
    "face.push.preview",
    "sketch.check",
    "sketch.revolve",
    "sketch.snaps",
    "sketch.offset",
    "dimension.anchor",
    "dimension.evaluate",
    "edge.pick",
    "edge.chamfer",
    "edge.fillet",
    "edge.chamfer.preview",
    "edge.fillet.preview",
    "sketch.fillet",
    "sketch.chamfer",
    "hole.find",
    "hole.apply",
    "nest.footprint",
    "nest.arrange",
    "nest.start",
    "nest.step",
    "nest.end",
];

pub type FileLoader<'a> = &'a dyn Fn(&str) -> Result<Vec<u8>>;

pub fn call(op: &str, request: &str) -> Result<String> {
    let v: Value = serde_json::from_str(request).map_err(|e| Error::Json(e.to_string()))?;
    let no_files = |p: &str| -> Result<Vec<u8>> {
        Err(Error::invalid(
            "stlPath",
            format!("{p}: file paths need a host with file access"),
        ))
    };
    let out = call_value(op, &v, &no_files)?;
    serde_json::to_string(&out).map_err(|e| Error::Json(e.to_string()))
}

#[allow(
    clippy::too_many_lines,
    reason = "one short arm per operation reads best as a table"
)]
pub fn call_value(op: &str, req: &Value, files: FileLoader<'_>) -> Result<Value> {
    let enc = MeshOut::from_request(req);
    match op {
        "info" => {
            let m = mesh_field(req, "mesh", files)?;
            Ok(info(&m))
        }
        "section" => {
            let m = mesh_field(req, "mesh", files)?;
            let plane = plane_field(req)?;
            let s = cut::section(&m, &plane);
            Ok(json!({
                "areaMm2": s.area(),
                "seamLengthMm": s.perimeter(),
                "islands": s.islands(),
                "openChains": s.open_chains,
                "frame": { "origin": s.frame.origin, "u": s.frame.u, "v": s.frame.v, "w": s.frame.w },
                "polygons": s.polygons,
            }))
        }
        "cut" => {
            let m = mesh_field(req, "mesh", files)?;
            let plane = plane_field(req)?;
            let opts: cut::CutOptions = field_or_default(req, "options")?;
            let r = cut::plane_cut(&m, &plane, &opts)?;
            Ok(json!({
                "below": enc.mesh(&r.below),
                "above": enc.mesh(&r.above),
                "extras": r.extras.iter().map(|e| enc.mesh(e)).collect::<Vec<_>>(),
                "report": to_value(&r.report)?,
            }))
        }
        "split" => {
            let m = mesh_field(req, "mesh", files)?;
            let opts: split::SplitOptions = field_or_default(req, "options")?;
            let r = split::split_to_fit(&m, &opts)?;
            Ok(json!({
                "parts": r.parts.iter().map(|p| json!({
                    "mesh": enc.mesh(&p.mesh),
                    "sizeMm": p.size_mm,
                    "rotateZ90": p.rotate_z_90,
                })).collect::<Vec<_>>(),
                "cuts": to_value(&r.cuts)?,
                "extras": r.extras.iter().map(|e| enc.mesh(e)).collect::<Vec<_>>(),
                "warnings": r.warnings,
            }))
        }
        "repair" => {
            let m = mesh_field(req, "mesh", files)?;
            let opts: repair::RepairOptions = field_or_default(req, "options")?;
            let (out, report) = repair::repair(&m, &opts)?;
            Ok(json!({ "mesh": enc.mesh(&out), "report": to_value(&report)? }))
        }
        "orient.analyze" => {
            let m = mesh_field(req, "mesh", files)?;
            let o: orient::Orientation = field(req, "orientation")?;
            let opts: orient::OrientOptions = field_or_default(req, "options")?;
            to_value(&orient::analyze(&m, &o, &opts))
        }
        "orient.rank" => {
            let m = mesh_field(req, "mesh", files)?;
            let opts: orient::OrientOptions = field_or_default(req, "options")?;
            let max: usize = field_or(req, "maxCandidates", 12)?;
            Ok(json!({ "ranked": to_value(&orient::rank(&m, &opts, max))? }))
        }
        "hollow" => {
            let m = mesh_field(req, "mesh", files)?;
            let opts: hollow::HollowOptions = field_or_default(req, "options")?;
            let (out, report) = hollow::hollow(&m, &opts)?;
            Ok(json!({ "mesh": enc.mesh(&out), "report": to_value(&report)? }))
        }
        "emboss" => {
            let m = mesh_field(req, "mesh", files)?;
            let spec: emboss::EmbossSpec = field(req, "spec")?;
            let out = emboss::emboss_text(&m, &spec)?;
            Ok(json!({ "mesh": enc.mesh(&out) }))
        }
        "emboss.polygons" => {
            let m = mesh_field(req, "mesh", files)?;
            let polys: Vec<Polygon> = field(req, "polygons")?;
            let point: V3 = field(req, "point")?;
            let normal: Option<V3> = field_or(req, "normal", None)?;
            let up: Option<V3> = field_or(req, "up", None)?;
            let depth: f64 = field(req, "depthMm")?;
            let mode: emboss::EmbossMode = field(req, "mode")?;
            let out = emboss::emboss_polygons(&m, &polys, point, normal, up, depth, mode)?;
            Ok(json!({ "mesh": enc.mesh(&out) }))
        }
        "calibrate" => {
            let r: calib::CalibRequest = parse(req.get("request").unwrap_or(req))?;
            let model = calib::generate(&r)?;
            Ok(json!({
                "name": model.name,
                "objects": model.objects.iter().map(|o| json!({
                    "name": o.name,
                    "mesh": enc.mesh(&o.mesh),
                    "offsetMm": o.offset_mm,
                    "settings": o.settings,
                })).collect::<Vec<_>>(),
                "ranges": to_value(&model.ranges)?,
                "instructions": model.instructions,
                "expected": model.expected,
            }))
        }
        "resume" => {
            let m = crate::json_cad::plate_mesh(req, files)?;
            let r: resume::ResumeRequest = parse(req)?;
            let plan = resume::plan(&m, &r)?;
            let mut v = to_value(&plan)?;
            if let (Some(obj), Some(rest)) = (v.as_object_mut(), plan.remaining.as_ref()) {
                obj.insert("remaining".to_owned(), enc.mesh(rest));
            }
            Ok(v)
        }
        "build" => {
            let solids: Vec<SolidSpec> = field(req, "solids")?;
            let cutters: Vec<SolidSpec> = field_or_default(req, "subtract")?;
            if solids.is_empty() {
                return Err(Error::invalid("solids", "needs at least one solid"));
            }
            let pieces = convex_pieces(&cutters)?;
            let mut parts = Vec::with_capacity(solids.len());
            for s in &solids {
                let mut m = s.to_mesh()?;
                for c in &pieces {
                    m = convex::subtract(&m, c)?;
                }
                parts.push(m);
            }
            let out = if parts.len() > 1 {
                crate::boolean::boolean(
                    &parts,
                    &[],
                    crate::boolean::BoolOp::Union,
                    &crate::boolean::BooleanOptions::default(),
                )?
                .0
            } else {
                parts.pop().unwrap_or_default()
            };
            Ok(mesh_report(&emboss::merge_coplanar(&out)?, enc))
        }
        "subtract" => {
            let m = mesh_field(req, "mesh", files)?;
            let solids: Vec<SolidSpec> = field(req, "solids")?;
            if solids.is_empty() {
                return Err(Error::invalid("solids", "needs at least one solid"));
            }
            let mut out = m.clone();
            for c in &convex_pieces(&solids)? {
                out = convex::subtract(&out, c)?;
            }
            let out = emboss::merge_coplanar(&out)?;
            let mut v = mesh_report(&out, enc);
            if let Some(obj) = v.as_object_mut() {
                obj.insert("removedVolumeMm3".to_owned(), json!(m.volume() - out.volume()));
            }
            Ok(v)
        }
        "import" => import_op(req, enc, files),
        "simplify" => {
            let m = mesh_field(req, "mesh", files)?;
            let opts: simplify::SimplifyOptions = field_or_default(req, "options")?;
            let (out, report) = simplify::simplify(&m, &opts)?;
            let e = out.edge_report();
            Ok(json!({
                "mesh": enc.mesh(&out),
                "report": to_value(&report)?,
                "watertight": e.is_watertight(),
                "edges": e,
                "volumeMm3": out.volume(),
            }))
        }
        "text.polygons" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Req {
                text: String,
                size_mm: f64,
                #[serde(default)]
                origin: Option<[f64; 2]>,
                #[serde(default)]
                align: Option<String>,
                #[serde(default)]
                stroke_mm: Option<f64>,
            }
            let r: Req = parse(req)?;
            if r.text.chars().count() > 80 {
                return Err(Error::invalid("text", "at most 80 characters"));
            }
            if !(r.size_mm.is_finite() && r.size_mm > 0.0) {
                return Err(Error::invalid("sizeMm", "must be above 0"));
            }
            let stroke = r.stroke_mm.unwrap_or(r.size_mm * 0.16);
            if !(stroke.is_finite() && stroke > 0.0) {
                return Err(Error::invalid("strokeMm", "must be above 0"));
            }
            let mut polys = crate::font::text_polygons(&r.text, r.size_mm, stroke);
            if polys.is_empty() {
                return Err(Error::invalid("text", "no visible characters"));
            }
            let size = crate::font::text_size(&r.text, r.size_mm, stroke);
            let o = r.origin.unwrap_or([0.0, 0.0]);
            let dx = o[0]
                + match r.align.as_deref() {
                    None | Some("center") => 0.0,
                    Some("left") => size[0] / 2.0,
                    Some(_) => return Err(Error::invalid("align", "left or center")),
                };
            for v in polys
                .iter_mut()
                .flat_map(|p| p.outer.iter_mut().chain(p.holes.iter_mut().flatten()))
            {
                *v = [v[0] + dx, v[1] + o[1]];
            }
            let (lo, hi) = polys.iter().flat_map(|p| p.outer.iter()).fold(
                ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]),
                |(lo, hi), v| {
                    (
                        [lo[0].min(v[0]), lo[1].min(v[1])],
                        [hi[0].max(v[0]), hi[1].max(v[1])],
                    )
                },
            );
            Ok(json!({
                "polygons": polys.iter().map(|p| json!({ "points": p.outer, "holes": p.holes })).collect::<Vec<_>>(),
                "bounds": { "min": lo, "max": hi },
            }))
        }
        "extrude.svg" => {
            #[derive(Deserialize)]
            #[serde(untagged)]
            enum Src {
                Text(String),
                Base64 { base64: String },
                Path { path: String },
            }
            let bytes = match field::<Src>(req, "svg")? {
                Src::Text(t) => t.into_bytes(),
                Src::Base64 { base64 } => {
                    base64_decode(&base64).ok_or_else(|| Error::invalid("svg", "bad base64"))?
                }
                Src::Path { path } => files(&path)?,
            };
            let text = String::from_utf8(bytes).map_err(|_| Error::invalid("svg", "not UTF-8 text"))?;
            let opts: svg::SvgOptions = field_or_default(req, "options")?;
            let m = svg::extrude_svg(&text, &opts)?;
            Ok(json!({
                "parts": m.parts.iter().map(|p| json!({
                    "name": p.name, "color": p.color, "slot": p.slot,
                    "areaMm2": p.area_mm2, "mesh": enc.mesh(&p.mesh),
                    "watertight": p.mesh.edge_report().is_watertight(),
                })).collect::<Vec<_>>(),
                "slotColors": m.slot_colors,
                "sizeMm": m.size_mm,
                "mmPerUnit": m.mm_per_unit,
                "warnings": m.warnings,
            }))
        }
        "layers.plan" => {
            let m = mesh_field(req, "mesh", files)?;
            let nozzle: f64 = field(req, "nozzleMm")?;
            let mode: layers::LayerMode = field(req, "mode")?;
            let opts: layers::LayerOptions = field_or_default(req, "options")?;
            to_value(&layers::plan_layers(&m, nozzle, mode, &opts)?)
        }
        "nest.footprint" => {
            let meshes = match req.get("meshes") {
                Some(Value::Array(list)) => list
                    .iter()
                    .map(|v| mesh_value(v, "meshes", files))
                    .collect::<Result<Vec<_>>>()?,
                _ => vec![mesh_field(req, "mesh", files)?],
            };
            let transform: Option<crate::nest::Mat4> = field_or(req, "transform", None)?;
            let mut opts = crate::nest::SilhouetteOptions::default();
            opts.tolerance_mm = field_or(req, "toleranceMm", opts.tolerance_mm)?;
            opts.min_hole_mm2 = field_or(req, "minHoleMm2", opts.min_hole_mm2)?;
            let s = crate::nest::silhouette(&meshes, transform.as_ref(), &opts);
            let b = crate::nest::poly::ring_bbox(&s.hull);
            Ok(json!({
                "polygons": s.outline.iter().map(|r| json!({
                    "outer": r.first(),
                    "holes": r.iter().skip(1).collect::<Vec<_>>(),
                })).collect::<Vec<_>>(),
                "hull": s.hull,
                "areaMm2": crate::nest::poly::area(&s.outline),
                "bounds": if b.is_empty() { Value::Null } else { json!({ "min": b.min, "max": b.max }) },
            }))
        }
        "nest.arrange" => to_value(&crate::nest::nest(parse(req)?)?),
        "nest.start" => to_value(&crate::nest::start(parse(req)?)?),
        "nest.step" => {
            let id: u32 = field(req, "session")?;
            let passes: usize = field_or(req, "passes", 1)?;
            to_value(&crate::nest::step(id, passes)?)
        }
        "nest.end" => {
            crate::nest::end(field(req, "session")?);
            Ok(json!({}))
        }
        _ => {
            crate::json_cad::call(op, req, enc, files).unwrap_or_else(|| Err(Error::UnknownOp(op.to_owned())))
        }
    }
}

fn import_op(req: &Value, enc: MeshOut, files: FileLoader<'_>) -> Result<Value> {
    let mut model = read_model(req, files)?;
    let unit = to_value(&model.unit)?;
    if field_or(req, "applyUnitGuess", false)? && model.unit.declared.is_none() {
        let k = model.unit.suggested_scale;
        model = model.scaled(k);
    }
    let multi = model.multi_body();
    let describe = |m: &import::ImportedModel| {
        json!({
            "name": m.name,
            "parts": m.parts.iter().map(|p| json!({
                "name": p.name, "slot": p.slot, "color": p.color, "body": p.body, "mesh": enc.mesh(&p.mesh),
            })).collect::<Vec<_>>(),
        })
    };
    let mut out = json!({
        "name": model.name,
        "format": model.format,
        "unit": unit,
        "multiBody": multi,
        "bodies": to_value(&model.bodies)?,
        "slotColors": model.slot_colors,
        "warnings": model.warnings,
    });
    let objects = if field_or(req, "separateObjects", false)? {
        model.clone().into_objects()
    } else {
        vec![model]
    };
    if let Some(o) = out.as_object_mut() {
        o.insert(
            "objects".to_owned(),
            Value::Array(objects.iter().map(describe).collect()),
        );
    }
    Ok(out)
}

pub(crate) fn read_model(req: &Value, files: FileLoader<'_>) -> Result<import::ImportedModel> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Data {
        Base64 { base64: String },
        Path { path: String },
    }
    let data: Data = field(req, "data")?;
    let (bytes, path) = match data {
        Data::Base64 { base64 } => (
            base64_decode(&base64).ok_or_else(|| Error::invalid("data", "bad base64"))?,
            None,
        ),
        Data::Path { path } => (files(&path)?, Some(path)),
    };
    let name: String = field_or(req, "name", path.clone().unwrap_or_else(|| "model".to_owned()))?;
    let lower = name.to_ascii_lowercase();
    let format = req.get("format").and_then(Value::as_str).map_or_else(
        || lower.rsplit('.').next().unwrap_or("").to_owned(),
        str::to_ascii_lowercase,
    );
    let opts: import::ImportOptions = field_or_default(req, "options")?;
    Ok(match format.as_str() {
        "obj" => {
            let inline: Option<String> = field_or(req, "mtl", None)?;
            let dir = path
                .as_deref()
                .and_then(|p| p.rsplit_once('/'))
                .map(|(d, _)| d.to_owned());
            let loader = |n: &str| -> Option<Vec<u8>> {
                inline.as_ref().map(|t| t.clone().into_bytes()).or_else(|| {
                    let full = dir.as_ref().map_or_else(|| n.to_owned(), |d| format!("{d}/{n}"));
                    files(&full).ok()
                })
            };
            import::import_obj(&bytes, &name, Some(&loader), &opts)?
        }
        "amf" => import::import_amf(&bytes, &name, &opts)?,
        "stl" => import::import_stl(&bytes, &name, &opts)?,
        other => {
            return Err(Error::invalid(
                "format",
                format!("import reads obj, amf and stl, not \"{other}\""),
            ));
        }
    })
}

fn convex_pieces(specs: &[SolidSpec]) -> Result<Vec<convex::ConvexSolid>> {
    let mut out = Vec::new();
    for s in specs {
        out.extend(s.to_convex()?);
    }
    Ok(out)
}

pub(crate) fn mesh_report(m: &TriMesh, enc: MeshOut) -> Value {
    let e = m.edge_report();
    json!({
        "mesh": enc.mesh(m),
        "shells": m.components().len(),
        "triangles": m.triangles.len(),
        "bounds": m.bounds(),
        "volumeMm3": m.volume(),
        "edges": e,
        "watertight": e.is_watertight(),
    })
}

fn info(m: &TriMesh) -> Value {
    let e = m.edge_report();
    json!({
        "vertices": m.positions.len(),
        "triangles": m.triangles.len(),
        "bounds": m.bounds(),
        "volumeMm3": m.volume(),
        "areaMm2": m.area(),
        "edges": e,
        "watertight": e.is_watertight(),
        "components": m.components().len(),
    })
}

#[derive(Clone, Copy)]
pub(crate) enum MeshOut {
    Flat,
    /// Flat, with the faces when the mesh has them (the request's `withFaces`).
    FlatFaces,
    StlBase64,
}

impl MeshOut {
    fn from_request(req: &Value) -> Self {
        match req.get("meshOutput").and_then(Value::as_str) {
            Some("stlBase64") => Self::StlBase64,
            _ if req.get("withFaces").and_then(Value::as_bool) == Some(true) => Self::FlatFaces,
            _ => Self::Flat,
        }
    }

    #[allow(
        clippy::cast_possible_truncation,
        reason = "output positions are f32 like the contracts"
    )]
    pub(crate) fn mesh(self, m: &TriMesh) -> Value {
        match self {
            Self::Flat | Self::FlatFaces => {
                let positions: Vec<f64> = m
                    .positions
                    .iter()
                    .flatten()
                    .map(|&c| f64::from(c as f32))
                    .collect();
                let indices: Vec<u32> = m.triangles.iter().flatten().copied().collect();
                match (&m.faces, self) {
                    (Some(f), Self::FlatFaces) => {
                        json!({ "positions": positions, "indices": indices, "faces": f })
                    }
                    _ => json!({ "positions": positions, "indices": indices }),
                }
            }
            Self::StlBase64 => json!({ "stlBase64": base64_encode(&m.to_stl("sx-geom")) }),
        }
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
pub(crate) enum MeshIn {
    #[serde(rename_all = "camelCase")]
    Stl { stl_base64: String },
    #[serde(rename_all = "camelCase")]
    Path { stl_path: String },
    Flat {
        positions: Vec<f64>,
        indices: Vec<u32>,
        #[serde(default)]
        faces: Option<Faces>,
    },
    Nested {
        positions: Vec<V3>,
        triangles: Vec<[u32; 3]>,
        #[serde(default)]
        faces: Option<Faces>,
    },
}

pub(crate) fn mesh_field(req: &Value, key: &str, files: FileLoader<'_>) -> Result<TriMesh> {
    let v = req
        .get(key)
        .ok_or_else(|| Error::invalid("request", format!("missing \"{key}\"")))?;
    mesh_value(v, key, files)
}

pub(crate) fn mesh_value(v: &Value, key: &str, files: FileLoader<'_>) -> Result<TriMesh> {
    Ok(match parse::<MeshIn>(v)? {
        MeshIn::Stl { stl_base64 } => {
            let bytes = base64_decode(&stl_base64).ok_or_else(|| Error::mesh(key, "bad base64"))?;
            TriMesh::from_stl(&bytes, key)?
        }
        MeshIn::Path { stl_path } => TriMesh::from_stl(&files(&stl_path)?, &stl_path)?,
        MeshIn::Flat {
            positions,
            indices,
            faces,
        } => {
            let mut m = TriMesh::from_flat(&positions, &indices)?;
            m.faces = faces.filter(|f| f.fit(&m));
            m
        }
        MeshIn::Nested {
            positions,
            triangles,
            faces,
        } => {
            let mut m = TriMesh::new(positions, triangles);
            m.validate(key)?;
            m.faces = faces.filter(|f| f.fit(&m));
            m
        }
    })
}

#[derive(Deserialize)]
#[serde(untagged)]
enum PlaneIn {
    Axis { axis: String, at: f64 },
    Point { point: V3, normal: V3 },
    Offset { normal: V3, offset: f64 },
}

fn plane_field(req: &Value) -> Result<Plane> {
    let v = req
        .get("plane")
        .ok_or_else(|| Error::invalid("request", "missing \"plane\""))?;
    let bad = || Error::invalid("plane", "the normal must be a non-zero vector");
    match parse::<PlaneIn>(v)? {
        PlaneIn::Axis { axis, at } => {
            let n = match axis.to_ascii_lowercase().as_str() {
                "x" => [1.0, 0.0, 0.0],
                "y" => [0.0, 1.0, 0.0],
                "z" => [0.0, 0.0, 1.0],
                _ => return Err(Error::invalid("plane", "axis must be x, y or z")),
            };
            Ok(Plane {
                normal: n,
                offset: at,
            })
        }
        PlaneIn::Point { point, normal } => Plane::new(point, normal).ok_or_else(bad),
        PlaneIn::Offset { normal, offset } => {
            let p = Plane::new([0.0; 3], normal).ok_or_else(bad)?;
            Ok(Plane {
                normal: p.normal,
                offset: offset / crate::vec3::len(normal),
            })
        }
    }
}

pub(crate) fn parse<T: DeserializeOwned>(v: &Value) -> Result<T> {
    T::deserialize(v).map_err(|e| Error::Json(e.to_string()))
}

pub(crate) fn field<T: DeserializeOwned>(req: &Value, key: &str) -> Result<T> {
    let v = req
        .get(key)
        .ok_or_else(|| Error::invalid("request", format!("missing \"{key}\"")))?;
    parse(v).map_err(|e| Error::Json(format!("{key}: {e}")))
}

pub(crate) fn field_or<T: DeserializeOwned>(req: &Value, key: &str, default: T) -> Result<T> {
    match req.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(v) => parse(v).map_err(|e| Error::Json(format!("{key}: {e}"))),
    }
}

pub(crate) fn field_or_default<T: DeserializeOwned + Default>(req: &Value, key: &str) -> Result<T> {
    field_or(req, key, T::default())
}

pub(crate) fn to_value<T: serde::Serialize>(v: &T) -> Result<Value> {
    serde_json::to_value(v).map_err(|e| Error::Json(e.to_string()))
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk.first().copied().unwrap_or(0),
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for k in 0..4 {
            if k <= chunk.len() {
                let sextet = (n >> (18 - 6 * k)) & 63;
                out.push(char::from(B64.get(sextet as usize).copied().unwrap_or(b'=')));
            } else {
                out.push('=');
            }
        }
    }
    out
}

pub fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            c if c.is_ascii_whitespace() => continue,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            #[allow(clippy::cast_possible_truncation, reason = "masked to one byte")]
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}

pub fn error_value(e: &Error) -> Value {
    json!({ "error": e.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build;

    fn cube_json() -> Value {
        let c = build::box_mesh([0.0; 3], [20.0, 20.0, 20.0]);
        MeshOut::Flat.mesh(&c)
    }

    #[test]
    fn base64_round_trip() {
        for s in [&b""[..], b"a", b"ab", b"abc", b"abcd", &[0, 255, 128, 7, 9]] {
            assert_eq!(base64_decode(&base64_encode(s)).unwrap(), s);
        }
    }

    #[test]
    fn cut_request_round_trip() {
        let req = json!({ "mesh": cube_json(), "plane": { "axis": "z", "at": 5.0 },
            "options": { "connector": { "kind": "pin", "diameterMm": 4.0 } } });
        let out: Value = serde_json::from_str(&call("cut", &req.to_string()).unwrap()).unwrap();
        assert_eq!(out["report"]["connectors"].as_array().unwrap().len(), 1);
        assert_eq!(out["report"]["belowEdges"]["boundaryEdges"], 0);
        assert!(out["below"]["positions"].as_array().unwrap().len() > 24);
    }

    #[test]
    fn every_operation_answers() {
        let mesh = cube_json();
        let cases = [
            ("info", json!({ "mesh": mesh })),
            (
                "section",
                json!({ "mesh": mesh, "plane": { "point": [0, 0, 3], "normal": [0, 0, 1] } }),
            ),
            (
                "split",
                json!({ "mesh": mesh, "options": { "buildVolumeMm": [15, 30, 30], "marginMm": 0 } }),
            ),
            ("repair", json!({ "mesh": mesh })),
            (
                "orient.analyze",
                json!({ "mesh": mesh, "orientation": { "down": [0, 0, -1] } }),
            ),
            ("orient.rank", json!({ "mesh": mesh, "maxCandidates": 6 })),
            ("hollow", json!({ "mesh": mesh, "options": { "wallMm": 2.0 } })),
            (
                "emboss",
                json!({ "mesh": mesh, "spec": { "text": "A1", "point": [10, 10, 20], "sizeMm": 5, "depthMm": 0.6, "mode": "deboss" } }),
            ),
            ("calibrate", json!({ "test": "flow" })),
            (
                "build",
                json!({ "solids": [{ "type": "box", "min": [0, 0, 0], "max": [20, 20, 10] }],
                        "subtract": [{ "type": "countersink", "origin": [10, 10, 10], "axis": [0, 0, -1],
                                       "shaftDiameterMm": 3.4, "headDiameterMm": 6.5, "depthMm": 12 }] }),
            ),
            (
                "subtract",
                json!({ "mesh": mesh, "solids": [{ "type": "cylinder", "origin": [5, 5, -1], "diameterMm": 2, "heightMm": 20 }] }),
            ),
            (
                "layers.plan",
                json!({ "mesh": mesh, "nozzleMm": 0.4, "mode": "quality" }),
            ),
            (
                "resume",
                json!({ "mesh": mesh, "measuredHeightMm": 6.1, "meshOutput": "stlBase64" }),
            ),
        ];
        for (op, req) in cases {
            let out = call(op, &req.to_string());
            assert!(out.is_ok(), "{op}: {:?}", out.err());
        }
        assert!(matches!(call("nope", "{}"), Err(Error::UnknownOp(_))));
    }

    #[test]
    fn stl_path_needs_a_loader() {
        let req = json!({ "mesh": { "stlPath": "/tmp/x.stl" } });
        assert!(call("info", &req.to_string()).is_err());
    }

    fn run(op: &str, req: &Value) -> Value {
        serde_json::from_str(&call(op, &req.to_string()).unwrap()).unwrap()
    }

    #[test]
    fn build_subtracts_a_countersunk_hole() {
        let out = run(
            "build",
            &json!({
                "solids": [{ "type": "box", "min": [0, 0, 0], "max": [20, 20, 10] }],
                "subtract": [{ "type": "countersink", "origin": [10, 10, 10], "axis": [0, 0, -1],
                               "shaftDiameterMm": 3.4, "headDiameterMm": 6.6, "depthMm": 12 }],
            }),
        );
        assert_eq!(out["watertight"], true, "{}", out["edges"]);
        assert_eq!(out["shells"], 1);
        let pi = std::f64::consts::PI;
        let shaft = pi * 1.7 * 1.7 * 10.0;
        let cone = pi * 1.6 / 3.0 * (3.3 * 3.3 + 3.3 * 1.7 + 1.7 * 1.7) - pi * 1.7 * 1.7 * 1.6;
        let expect = 4000.0 - shaft - cone;
        let got = out["volumeMm3"].as_f64().unwrap();
        assert!(
            (got - expect).abs() < 0.03 * (4000.0 - expect),
            "{got} vs {expect}"
        );
    }

    #[test]
    fn build_reports_overlapping_solids_as_shells() {
        let out = run(
            "build",
            &json!({ "solids": [
                { "type": "box", "min": [0, 0, 0], "max": [10, 10, 10] },
                { "type": "cylinder", "origin": [20, 0, 0], "diameterMm": 6, "heightMm": 8 },
                { "type": "extrude", "points": [[0, 0], [8, 0], [8, 3], [3, 3], [3, 8], [0, 8]],
                  "origin": [40, 0, 0], "heightMm": 5 },
            ] }),
        );
        assert_eq!(out["shells"], 3);
        assert_eq!(out["watertight"], true);
        assert!((out["volumeMm3"].as_f64().unwrap() - (1000.0 + 8.0 * 28.2 + 5.0 * 39.0)).abs() < 10.0);
    }

    #[test]
    fn build_unions_touching_solids() {
        let out = run(
            "build",
            &json!({
                "solids": [
                    { "type": "box", "min": [0, 0, 0], "max": [30, 20, 4] },
                    { "type": "box", "min": [0, 0, 4], "max": [4, 20, 25] },
                ],
                "subtract": [
                    { "type": "cylinder", "origin": [18, 10, -1], "diameterMm": 5, "heightMm": 6 },
                    { "type": "cylinder", "origin": [-1, 10, 15], "axis": [1, 0, 0], "diameterMm": 5, "heightMm": 6 },
                ],
            }),
        );
        assert_eq!(out["watertight"], true, "{}", out["edges"]);
        assert_eq!(out["edges"]["nonManifoldEdges"], 0);
        assert_eq!(out["shells"], 1);
        let plain = run(
            "build",
            &json!({ "solids": [
                { "type": "box", "min": [0, 0, 0], "max": [30, 20, 4] },
                { "type": "box", "min": [0, 0, 4], "max": [4, 20, 25] },
            ] }),
        );
        assert_eq!(plain["edges"]["nonManifoldEdges"], 0);
        assert_eq!(plain["shells"], 1);
        assert!((plain["volumeMm3"].as_f64().unwrap() - (2400.0 + 1680.0)).abs() < 1e-6);
    }

    #[test]
    fn subtract_drills_a_mesh_and_rejects_concave_cutters() {
        let cube = build::box_mesh([0.0; 3], [10.0, 10.0, 10.0]);
        let mesh = json!({ "positions": cube.positions.iter().flatten().collect::<Vec<_>>(),
                           "indices": cube.triangles.iter().flatten().collect::<Vec<_>>() });
        let out = run(
            "subtract",
            &json!({ "mesh": mesh, "solids": [
                { "type": "cylinder", "origin": [5, 5, -1], "diameterMm": 4, "heightMm": 12 },
                { "type": "box", "min": [8, 8, 8], "max": [11, 11, 11] },
            ] }),
        );
        assert_eq!(out["watertight"], true, "{}", out["edges"]);
        let removed = out["removedVolumeMm3"].as_f64().unwrap();
        let expect = std::f64::consts::PI * 4.0 * 10.0 + 2.0 * 2.0 * 2.0;
        assert!((removed - expect).abs() < 0.04 * expect, "{removed} vs {expect}");
        let bad = json!({ "mesh": mesh, "solids": [
            { "type": "prism", "points": [[0, 0], [4, 0], [4, 4], [2, 1], [0, 4]], "heightMm": 3 }] });
        assert!(call("subtract", &bad.to_string()).is_err());
    }

    #[test]
    #[allow(clippy::format_push_string)]
    fn import_reads_obj_with_colors_and_units() {
        let mut obj = String::from("mtllib m.mtl\nusemtl red\n");
        for (x, y, z) in [
            (0, 0, 0),
            (2, 0, 0),
            (2, 2, 0),
            (0, 2, 0),
            (0, 0, 2),
            (2, 0, 2),
            (2, 2, 2),
            (0, 2, 2),
        ] {
            obj += &format!("v {x} {y} {z}\n");
        }
        obj += "f 1 3 2\nf 1 4 3\nf 5 6 7\nf 5 7 8\nf 1 2 6\nf 1 6 5\nf 2 3 7\nf 2 7 6\nf 3 4 8\nf 3 8 7\nf 4 1 5\nf 4 5 8\n";
        let out = run(
            "import",
            &json!({
                "name": "cube.obj",
                "data": { "base64": base64_encode(obj.as_bytes()) },
                "mtl": "newmtl red\nKd 1 0 0\n",
                "applyUnitGuess": true,
            }),
        );
        assert_eq!(out["slotColors"], json!(["#ff0000"]));
        assert_eq!(out["unit"]["detected"], "inch");
        assert_eq!(out["multiBody"], false);
        let part = &out["objects"][0]["parts"][0];
        assert_eq!(part["slot"], 1);
        let xs: Vec<f64> = part["mesh"]["positions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect();
        assert!((xs.iter().copied().fold(0.0, f64::max) - 50.8).abs() < 1e-3);
        let bad = call(
            "import",
            &json!({ "name": "x.ply", "data": { "base64": "AA==" } }).to_string(),
        );
        assert!(bad.is_err());
    }

    #[test]
    fn simplify_op_reports_and_keeps_watertight() {
        let s = build::uv_sphere([0.0; 3], 10.0, 40, 60);
        let out = run(
            "simplify",
            &json!({ "mesh": MeshOut::Flat.mesh(&s), "options": { "targetRatio": 0.25 } }),
        );
        assert_eq!(out["watertight"], true);
        assert!(out["report"]["trianglesAfter"].as_u64().unwrap() <= 1200);
    }

    #[test]
    fn text_polygons_feed_build_extrude() {
        let out = run("text.polygons", &json!({ "text": "AB 7", "sizeMm": 6.0 }));
        let b = &out["bounds"];
        let (lo, hi) = (b["min"].as_array().unwrap(), b["max"].as_array().unwrap());
        assert!((lo[0].as_f64().unwrap() + hi[0].as_f64().unwrap()).abs() < 1e-9);
        let left = run(
            "text.polygons",
            &json!({ "text": "AB 7", "sizeMm": 6.0, "origin": [10, 5], "align": "left" }),
        );
        assert!((left["bounds"]["min"][0].as_f64().unwrap() - 10.0).abs() < 1e-9);
        let mid = f64::midpoint(
            left["bounds"]["min"][1].as_f64().unwrap(),
            left["bounds"]["max"][1].as_f64().unwrap(),
        );
        assert!((mid - 5.0).abs() < 1e-9);
        let solids: Vec<Value> = out["polygons"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                json!({ "type": "extrude", "points": p["points"], "holes": p["holes"],
                        "origin": [0, 0, 2], "heightMm": 1.5 })
            })
            .collect();
        let built = run("build", &json!({ "solids": solids }));
        assert_eq!(built["watertight"], true);
        assert!(built["volumeMm3"].as_f64().unwrap() > 0.0);
        for bad in [
            json!({ "text": "x".repeat(81), "sizeMm": 5 }),
            json!({ "text": "  ", "sizeMm": 5 }),
            json!({ "text": "A", "sizeMm": 0 }),
            json!({ "text": "A", "sizeMm": 5, "align": "right" }),
        ] {
            assert!(call("text.polygons", &bad.to_string()).is_err(), "{bad}");
        }
    }

    #[test]
    fn extrude_svg_returns_colored_parts() {
        let svg = "<svg viewBox=\"0 0 50 50\"><rect width=\"20\" height=\"20\" fill=\"#f00\"/>\
                   <circle cx=\"35\" cy=\"35\" r=\"10\" fill=\"#00f\"/></svg>";
        let out = run(
            "extrude.svg",
            &json!({ "svg": svg, "options": { "scale": 1.0, "heightMm": 3.0, "baseMm": 1.0 } }),
        );
        let parts = out["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0]["name"], "base plate");
        assert!(parts.iter().all(|p| p["watertight"] == true));
        assert_eq!(out["slotColors"], json!(["#ff0000", "#0000ff"]));
        assert!(call("extrude.svg", &json!({ "svg": "<svg/>" }).to_string()).is_err());
    }
}
