// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! JSON in, JSON out

#[cfg(feature = "calib")]
use crate::calib;
use crate::error::{Error, Result};
#[cfg(feature = "cad")]
use crate::faces::Faces;
#[cfg(feature = "hollow")]
use crate::hollow;
use crate::mesh::TriMesh;
use crate::poly2d::Polygon;
use crate::solids::SolidSpec;
#[cfg(feature = "svg")]
use crate::svg;
use crate::vec3::{self, Plane, V3};
use crate::{
    convex, cut, emboss, import, layers, orient, paint_ops, render, repair, resume, simplify, split,
};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

/// Every operation, with the cargo feature it needs ("" for one every build has).
const ALL_OPERATIONS: &[(&str, &str)] = &[
    ("info", ""),
    ("render", ""),
    ("paint.select", ""),
    ("paint.regions", ""),
    ("paint.texture", "texture"),
    ("section", ""),
    ("cut", ""),
    ("split", ""),
    ("repair", ""),
    ("orient.analyze", ""),
    ("orient.rank", ""),
    ("hollow", "hollow"),
    ("emboss", ""),
    ("emboss.polygons", ""),
    ("calibrate", "calib"),
    ("resume", ""),
    ("layers.plan", ""),
    ("build", ""),
    ("subtract", ""),
    ("import", ""),
    ("simplify", ""),
    ("remesh", ""),
    ("extrude.svg", "svg"),
    ("text.polygons", "text"),
    ("boolean", ""),
    ("array", ""),
    ("measure", ""),
    ("measure.feature", ""),
    ("face.pick", "cad"),
    ("shape.profile", "cad"),
    ("shape.extrude", "cad"),
    ("text.mesh", "cad"),
    ("import.auto", ""),
    ("import.selfIntersections", ""),
    ("fit.check", ""),
    ("interference", ""),
    ("face.push", "cad"),
    ("face.push.preview", "cad"),
    ("sketch.check", "cad"),
    ("sketch.curves", "cad"),
    ("sketch.revolve", "cad"),
    ("sketch.loft", "cad"),
    ("sketch.sweep", "cad"),
    ("sketch.snaps", "cad"),
    ("sketch.offset", "cad"),
    ("sketch.project", "cad"),
    ("dimension.anchor", "cad"),
    ("dimension.evaluate", "cad"),
    ("edge.pick", "cad"),
    ("edge.chamfer", "cad"),
    ("edge.fillet", "cad"),
    ("edge.chamfer.preview", "cad"),
    ("edge.fillet.preview", "cad"),
    ("sketch.fillet", "cad"),
    ("sketch.chamfer", "cad"),
    ("sketch.solve", "cad"),
    ("sketch.svg", "cad"),
    ("sketch.trace", "trace"),
    ("hole.find", "holes"),
    ("hole.apply", "holes"),
    ("thread.find", "threads"),
    ("thread.apply", "threads"),
    ("shell", "shell"),
    ("nest.footprint", "nest"),
    ("nest.arrange", "nest"),
    ("nest.start", "nest"),
    ("nest.step", "nest"),
    ("nest.end", "nest"),
    ("format.read3mf", "formats"),
    ("brep.count", "brep"),
    ("brep.box", "brep"),
    ("brep.cylinder", "brep"),
    ("brep.primitive", "brep"),
    ("brep.extrude", "brep"),
    ("brep.boolean", "brep"),
    ("brep.subtract", "brep"),
    ("brep.cut", "brep"),
    ("brep.fillet", "brep"),
    ("brep.chamfer", "brep"),
    ("brep.push", "brep"),
    ("brep.hole", "brep"),
    ("brep.info", "brep"),
    ("brep.tessellate", "brep"),
    ("brep.save", "brep"),
    ("brep.load", "brep"),
    ("brep.free", "brep"),
    ("exact.ops", "brep"),
];

/// Whether this build has the feature.
#[allow(
    clippy::match_like_matches_macro,
    reason = "each arm reads the build's features"
)]
fn has(feature: &str) -> bool {
    match feature {
        "" => true,
        "cad" => cfg!(feature = "cad"),
        "holes" => cfg!(feature = "holes"),
        "threads" => cfg!(feature = "threads"),
        "shell" => cfg!(feature = "shell"),
        "text" => cfg!(feature = "text"),
        "svg" => cfg!(feature = "svg"),
        "nest" => cfg!(feature = "nest"),
        "calib" => cfg!(feature = "calib"),
        "hollow" => cfg!(feature = "hollow"),
        "formats" => cfg!(feature = "formats"),
        "texture" => cfg!(feature = "texture"),
        "trace" => cfg!(feature = "trace"),
        "brep" => cfg!(feature = "brep"),
        _ => false,
    }
}

/// The operations this build can run.
pub fn operations() -> Vec<&'static str> {
    ALL_OPERATIONS
        .iter()
        .filter(|(_, f)| has(f))
        .map(|(n, _)| *n)
        .collect()
}

/// The error for an operation this build leaves out, or for one that does not exist.
fn unknown(op: &str) -> Error {
    match ALL_OPERATIONS.iter().find(|(n, _)| *n == op) {
        Some((_, f)) => Error::invalid("op", format!("{op} is not in this build; it leaves out {f}")),
        None => Error::UnknownOp(op.to_owned()),
    }
}

pub type FileLoader<'a> = &'a dyn Fn(&str) -> Result<Vec<u8>>;

pub fn call(op: &str, request: &str) -> Result<String> {
    let no_files = |p: &str| -> Result<Vec<u8>> {
        Err(Error::invalid(
            "stlPath",
            format!("{p}: file paths need a host with file access"),
        ))
    };
    call_with_files(op, request, &no_files)
}

/// Runs one operation on a request in JSON, its file paths (`stlPath`, `rawPath`) read through `files`.
pub fn call_with_files(op: &str, request: &str, files: FileLoader<'_>) -> Result<String> {
    take_out_files();
    let v: Value = serde_json::from_str(request).map_err(|e| Error::Json(e.to_string()))?;
    let out = call_value(op, &v, files)?;
    serde_json::to_string(&out).map_err(|e| Error::Json(e.to_string()))
}

/// Runs one operation. A request with `keySalt` (a history step's, the same in every replay of it) gives the faces
/// it makes keys from that salt, and a mesh that comes in without keys the keys of a base (faces.rs).
pub fn call_value(op: &str, req: &Value, files: FileLoader<'_>) -> Result<Value> {
    #[cfg(feature = "cad")]
    {
        let salt = req.get("keySalt").and_then(Value::as_u64);
        crate::faces::with_key_salt(salt, || run(op, req, files))
    }
    #[cfg(not(feature = "cad"))]
    run(op, req, files)
}

#[allow(
    clippy::too_many_lines,
    reason = "one short arm per operation reads best as a table"
)]
fn run(op: &str, req: &Value, files: FileLoader<'_>) -> Result<Value> {
    let enc = MeshOut::from_request(req);
    match op {
        "render" => render_op(req, files),
        "paint.select" => paint_select_op(req, files),
        "paint.regions" => paint_regions_op(req, files),
        #[cfg(feature = "texture")]
        "paint.texture" => crate::json_texture::paint_texture_op(req, files),
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
        #[cfg(feature = "hollow")]
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
        #[cfg(feature = "calib")]
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
            // the part with its transform: cut in bed coordinates, answered in the part's own frame
            let it = crate::json_cad::item_field(req, "mesh", files)?;
            let m = it.world();
            let solids: Vec<SolidSpec> = field(req, "solids")?;
            if solids.is_empty() {
                return Err(Error::invalid("solids", "needs at least one solid"));
            }
            #[allow(unused_mut, reason = "faces are added only in builds with the cad feature")]
            let mut out = cut_out(&it, &solids)?;
            // The faces, found here on the f64 result: the answer rounds the corners to f32, and after that a
            // corner the cut left on a chord of a hole's wall reads as a seam, so the wall no longer fits a cylinder.
            // What the part's own faces knew (a wall an earlier cut found, the keys) carries over.
            #[cfg(feature = "cad")]
            {
                out.faces = Some(crate::faces::faces_after_cut(&m, &out));
            }
            let mut v = mesh_report(&it.to_local(&out)?, enc);
            if let Some(obj) = v.as_object_mut() {
                obj.insert("removedVolumeMm3".to_owned(), json!(m.volume() - out.volume()));
            }
            Ok(v)
        }
        "import" => import_op(req, enc, files),
        "remesh" => {
            let m = mesh_field(req, "mesh", files)?;
            let out = if req.get("coarsen").and_then(Value::as_bool) == Some(true) {
                crate::remesh::coarsen_flat(&m)
            } else {
                crate::remesh::remesh_flat(&m, &crate::remesh::RemeshOptions::default())
            };
            let e = out.stored_edge_report();
            Ok(json!({
                "mesh": enc.mesh(&out),
                "changed": out != m,
                "triangles": out.triangles.len(),
                "volumeMm3": out.volume(),
                "watertight": e.is_watertight(),
            }))
        }
        "simplify" => {
            let m = mesh_field(req, "mesh", files)?;
            let opts: simplify::SimplifyOptions = field_or_default(req, "options")?;
            let (out, report) = simplify::simplify(&m, &opts)?;
            let e = out.stored_edge_report();
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
        #[cfg(feature = "svg")]
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
                    "watertight": p.mesh.stored_edge_report().is_watertight(),
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
        #[cfg(feature = "nest")]
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
            // baseMm: also the first layer, for the brim
            let base: Option<f64> = field_or(req, "baseMm", None)?;
            let s = crate::nest::silhouette(&meshes, transform.as_ref(), &opts);
            let b = crate::nest::poly::ring_bbox(&s.hull);
            let shapes = |r: &crate::nest::poly::Region| {
                r.iter()
                    .map(|s| json!({ "outer": s.first(), "holes": s.iter().skip(1).collect::<Vec<_>>() }))
                    .collect::<Vec<_>>()
            };
            let mut out = json!({
                "polygons": shapes(&s.outline),
                "hull": s.hull,
                "areaMm2": crate::nest::poly::area(&s.outline),
                "bounds": if b.is_empty() { Value::Null } else { json!({ "min": b.min, "max": b.max }) },
            });
            if let Some(h) = base.filter(|h| h.is_finite())
                && let Some(o) = out.as_object_mut()
            {
                o.insert(
                    "base".to_owned(),
                    Value::from(shapes(&crate::nest::base(&meshes, transform.as_ref(), h, &opts))),
                );
            }
            Ok(out)
        }
        #[cfg(feature = "formats")]
        "format.read3mf" => crate::format::json::read(req, files),
        #[cfg(feature = "nest")]
        "nest.arrange" => to_value(&crate::nest::nest(parse(req)?)?),
        #[cfg(feature = "nest")]
        "nest.start" => to_value(&crate::nest::start(parse(req)?)?),
        #[cfg(feature = "nest")]
        "nest.step" => {
            let id: u32 = field(req, "session")?;
            let passes: usize = field_or(req, "passes", 1)?;
            to_value(&crate::nest::step(id, passes)?)
        }
        #[cfg(feature = "nest")]
        "nest.end" => {
            crate::nest::end(field(req, "session")?);
            Ok(json!({}))
        }
        // the operations that make an exact body when asked (`exact`): none in a build without the kernel
        #[cfg(feature = "brep")]
        "exact.ops" => {
            let ops: &[&str] = if sx_brep::KERNEL && cfg!(feature = "cad") {
                &["sketch.loft"]
            } else {
                &[]
            };
            Ok(json!({ "ops": ops }))
        }
        #[cfg(feature = "brep")]
        o if o.starts_with("brep.") && ALL_OPERATIONS.iter().any(|(n, _)| *n == o) => {
            brep_op(&o[5..], req, enc)
        }
        _ => crate::json_cad::call(op, req, enc, files).unwrap_or_else(|| Err(unknown(op))),
    }
}

#[cfg(feature = "brep")]
static BREP_TEXT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Lets brep.* requests carry bodies as text in this process, as `SX_BREP_DEV=1` does (a developer's tools, tests).
#[cfg(feature = "brep")]
pub fn allow_brep_text(on: bool) {
    BREP_TEXT.store(on, std::sync::atomic::Ordering::Relaxed);
}

/// An exact solid op of sx-brep. A body lasts only as long as the process that made it. Bodies sent back as
/// `{"smb": text}` are a cache the app keeps for itself, not an input: the kernel's reader trusts its text, so a
/// request may carry one only with `SX_BREP_DEV=1` (developers, and tests that run one process per call).
/// The engine holds every body itself and answers from its table (`exact.rs`).
#[cfg(feature = "brep")]
fn brep_op(op: &str, req: &Value, enc: MeshOut) -> Result<Value> {
    let carries_text = req
        .as_object()
        .is_some_and(|o| o.values().any(|v| v.get("smb").is_some()));
    let dev = BREP_TEXT.load(std::sync::atomic::Ordering::Relaxed)
        || std::env::var_os("SX_BREP_DEV").is_some_and(|v| v == "1");
    if carries_text && !dev {
        return Err(Error::invalid(
            "body",
            "takes a body number; a body as text needs SX_BREP_DEV=1",
        ));
    }
    crate::exact::answer(op, req, matches!(enc, MeshOut::Raw))
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
    // An STL the caller has read and welded already (the app shows the model from its own read first): the mesh, in
    // place of the file, so the file is not sent, decoded, read and welded a second time.
    if let Some(v) = req.get("stlMesh") {
        let name: String = field_or(req, "name", "model".to_owned())?;
        let opts: import::ImportOptions = field_or_default(req, "options")?;
        return import::import_stl_read(&mesh_value(v, "stlMesh", files)?, &name, &opts);
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

/// the part with the solids cut out by convex cuts, in bed coordinates; where those leave it open or crossing itself
/// once stored in the part's own frame (a bore that runs along a round the part already has), the boolean engine cuts
/// it instead
fn cut_out(it: &crate::json_cad::Item, solids: &[SolidSpec]) -> Result<TriMesh> {
    let m = it.world();
    let mut out = m.clone();
    let mut cutters = Vec::new();
    for c in &convex_pieces(solids)? {
        // a cutter face flush with a body face goes past it
        let c = convex::overshoot_flush(c, &out, crate::solids::OVERSHOOT_MM);
        out = convex::subtract(&out, &c)?;
        cutters.push(c);
    }
    let mut out = emboss::merge_coplanar_changed(&out, &m)?;
    convex::flip_needles(&mut out);
    let Some(b) = m.bounds() else {
        return Ok(out);
    };
    // the full check only where a cheap look finds something wrong, and only for a part that stored clean before
    if out.triangles.is_empty() {
        return Ok(out);
    }
    let local = it.as_local(&out)?;
    if !suspect(&local) || crate::boolean::stores_clean(&local) || !crate::boolean::stores_clean(it.mesh()) {
        return Ok(out);
    }
    let Some(tools) = cutters.iter().map(|k| k.to_mesh(&b)).collect::<Option<Vec<_>>>() else {
        return Ok(out);
    };
    let opts = crate::boolean::BooleanOptions::default();
    if let Ok((r, mut report)) = crate::boolean::boolean(
        std::slice::from_ref(&m),
        &tools,
        crate::boolean::BoolOp::Difference,
        &opts,
    ) {
        // settled only when it does not store as it is: the weld can close corners the boolean kept apart
        let r = it.to_local(&crate::boolean::tidy(r, &mut report))?;
        if crate::boolean::stores_clean(&r) {
            return Ok(it.to_world(&r));
        }
        let r = settle(r);
        if crate::boolean::stores_clean(&r) {
            return Ok(it.to_world(&r));
        }
    }
    Ok(out)
}

/// true when a cut's result, as stored, is open, pinched where corners meet at f32, or has a triangle a hair from flat
#[allow(
    clippy::cast_possible_truncation,
    reason = "rounding to the f32 the result is stored in"
)]
fn suspect(m: &TriMesh) -> bool {
    if !m.edge_report().is_watertight() || !closed_at_f32(m) {
        return true;
    }
    // one float step, measured, not proven: cuts that fail to store measured from 0 to 0.03 of one, while plate holes,
    // loft channels and stem bores that store measured 1.5 and more. a crossing with no triangle this thin is not
    // caught here and is returned as the convex cut left it
    let tol = f32_step(m);
    m.triangles.iter().any(|&t| {
        let [a, b, c] = m.corners(t).map(|p| p.map(|v| f64::from(v as f32)));
        let long = [vec3::sub(b, a), vec3::sub(c, b), vec3::sub(a, c)]
            .map(vec3::len)
            .into_iter()
            .fold(0.0, f64::max);
        vec3::len(vec3::tri_normal(a, b, c)) <= tol * long
    })
}

/// true when the mesh stays closed once corners at the same f32 point are one, as storage welds them
#[allow(
    clippy::cast_possible_truncation,
    reason = "rounding to the f32 the result is stored in"
)]
fn closed_at_f32(m: &TriMesh) -> bool {
    let mut ids: std::collections::HashMap<[u32; 3], u32> =
        std::collections::HashMap::with_capacity(m.positions.len());
    // + 0.0 keys -0 with 0
    let v: Vec<u32> = m
        .positions
        .iter()
        .map(|p| {
            let n = ids.len() as u32;
            *ids.entry(p.map(|c| (c as f32 + 0.0).to_bits())).or_insert(n)
        })
        .collect();
    // no two corners meet: the mesh is as closed as its indices say
    if ids.len() == m.positions.len() {
        return true;
    }
    let mut sides: std::collections::HashMap<(u32, u32), u32> =
        std::collections::HashMap::with_capacity(m.triangles.len() * 3);
    for t in &m.triangles {
        let [a, b, c] = t.map(|i| v.get(i as usize).copied().unwrap_or(u32::MAX));
        if a == b || b == c || a == c {
            return false;
        }
        for side in [(a, b), (b, c), (c, a)] {
            *sides.entry(side).or_insert(0) += 1;
        }
    }
    sides
        .iter()
        .all(|(&(a, b), &n)| n == 1 && sides.get(&(b, a)) == Some(&1))
}

/// an f32 step at the mesh's largest coordinate
fn f32_step(m: &TriMesh) -> f64 {
    let big = m.positions.iter().flatten().fold(0.0_f64, |s, c| s.max(c.abs()));
    big * f64::from(f32::EPSILON)
}

/// a cut's result, in the frame it is stored in, with the slivers it leaves where its cutter runs along the part
/// settled: needles turned away, corners about two float steps apart made one, and fins of no volume dropped
#[allow(
    clippy::cast_possible_truncation,
    reason = "rounding to the f32 the result is stored in"
)]
fn settle(mut r: TriMesh) -> TriMesh {
    convex::flip_needles(&mut r);
    for p in &mut r.positions {
        *p = p.map(|v| f64::from(v as f32));
    }
    let tol = (f32_step(&r) * 2.5).max(r.bounds().map_or(1e-6, |b| b.diagonal() * 1e-7));
    let mut r = r.weld(tol);
    r.faces = None;
    r.triangles
        .retain(|t| t[0] != t[1] && t[1] != t[2] && t[0] != t[2]);
    r.triangles = drop_fins(&r.triangles);
    convex::flip_needles(&mut r);
    r
}

/// the triangles with each pair on the same corners facing apart (a fin of no volume) dropped, and one kept of any
/// copies that face the same way
fn drop_fins(tris: &[[u32; 3]]) -> Vec<[u32; 3]> {
    // a triangle turned to start at its lowest corner; the same corners facing apart give the other two in turn
    let turned = |[a, b, c]: [u32; 3]| {
        if a <= b && a <= c {
            [a, b, c]
        } else if b <= c {
            [b, c, a]
        } else {
            [c, a, b]
        }
    };
    let key = |u: [u32; 3]| [u[0], u[1].min(u[2]), u[1].max(u[2])];
    // per corner set: copies facing one way less those facing the other, and whether one is kept yet
    let mut ways: std::collections::HashMap<[u32; 3], (i64, bool)> = std::collections::HashMap::new();
    for &t in tris {
        let u = turned(t);
        ways.entry(key(u)).or_insert((0, false)).0 += if u[1] < u[2] { 1 } else { -1 };
    }
    let mut out = Vec::with_capacity(tris.len());
    for &t in tris {
        let u = turned(t);
        let Some(e) = ways.get_mut(&key(u)) else {
            continue;
        };
        // the way with more copies keeps one; a tie cancels
        if !e.1 && e.0 != 0 && (e.0 > 0) == (u[1] < u[2]) {
            e.1 = true;
            out.push(t);
        }
    }
    out
}

fn convex_pieces(specs: &[SolidSpec]) -> Result<Vec<convex::ConvexSolid>> {
    let mut out = Vec::new();
    for s in specs {
        out.extend(s.to_convex()?);
    }
    Ok(out)
}

pub(crate) fn mesh_report(m: &TriMesh, enc: MeshOut) -> Value {
    let e = m.stored_edge_report();
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
    let e = m.stored_edge_report();
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
    /// Flat, with the faces when the mesh has them (the request's `withFaces`; builds with the cad feature).
    #[cfg(feature = "cad")]
    FlatFaces,
    StlBase64,
    /// Each mesh in the raw form (`TriMesh::to_raw`) as an output buffer of the call (`take_out_files`), named in the
    /// answer by its number (`rawOut`), with its faces beside it when it has them. A big mesh then leaves the engine
    /// without JSON.
    Raw,
}

/// an output buffer of a call: bytes, or a mesh's positions or triangles kept as they are, so a big mesh leaves
/// without being written out again
pub enum OutFile {
    Bytes(Vec<u8>),
    Positions(Vec<[f32; 3]>),
    Triangles(Vec<[u32; 3]>),
}

impl OutFile {
    /// where the buffer's bytes start in memory, and how many there are
    pub fn ptr_len(&self) -> (usize, usize) {
        match self {
            Self::Bytes(b) => (b.as_ptr() as usize, b.len()),
            Self::Positions(p) => (p.as_ptr() as usize, p.len() * 12),
            Self::Triangles(t) => (t.as_ptr() as usize, t.len() * 12),
        }
    }

    /// the bytes, little-endian
    pub fn to_bytes(&self) -> Vec<u8> {
        match self {
            Self::Bytes(b) => b.clone(),
            Self::Positions(p) => p.iter().flatten().flat_map(|c| c.to_le_bytes()).collect(),
            Self::Triangles(t) => t.iter().flatten().flat_map(|i| i.to_le_bytes()).collect(),
        }
    }
}

thread_local! {
    /// The output buffers of the current call (`MeshOut::Raw`).
    static OUT_FILES: std::cell::RefCell<Vec<OutFile>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// adds an output buffer to the current call and returns its number
#[cfg(any(feature = "formats", feature = "brep"))]
pub(crate) fn push_out_file(file: OutFile) -> usize {
    OUT_FILES.with(|f| {
        let mut f = f.borrow_mut();
        f.push(file);
        f.len() - 1
    })
}

/// The output buffers the last call wrote (`meshOutput: "raw"`), in the order its answer numbers them; taken once.
pub fn take_out_files() -> Vec<OutFile> {
    OUT_FILES.with(|f| std::mem::take(&mut *f.borrow_mut()))
}

impl MeshOut {
    fn from_request(req: &Value) -> Self {
        match req.get("meshOutput").and_then(Value::as_str) {
            Some("stlBase64") => Self::StlBase64,
            Some("raw") => Self::Raw,
            #[cfg(feature = "cad")]
            _ if req.get("withFaces").and_then(Value::as_bool) == Some(true) => Self::FlatFaces,
            _ => Self::Flat,
        }
    }

    #[allow(
        clippy::cast_possible_truncation,
        reason = "output positions are f32 like the contracts"
    )]
    pub(crate) fn mesh(self, m: &TriMesh) -> Value {
        let flat = || {
            let positions: Vec<f64> = m
                .positions
                .iter()
                .flatten()
                .map(|&c| f64::from(c as f32))
                .collect();
            let indices: Vec<u32> = m.triangles.iter().flatten().copied().collect();
            json!({ "positions": positions, "indices": indices })
        };
        match self {
            Self::Flat => flat(),
            #[cfg(feature = "cad")]
            Self::FlatFaces => {
                let mut v = flat();
                if let (Some(f), Some(o)) = (&m.faces, v.as_object_mut()) {
                    o.insert("faces".to_owned(), json!(f));
                }
                v
            }
            Self::StlBase64 => json!({ "stlBase64": base64_encode(&m.to_stl("sx-geom")) }),
            Self::Raw => {
                let n = OUT_FILES.with(|f| {
                    let mut f = f.borrow_mut();
                    f.push(OutFile::Bytes(m.to_raw()));
                    f.len() - 1
                });
                #[allow(unused_mut, reason = "faces are written only in builds with the cad feature")]
                let mut v = json!({ "rawOut": n });
                #[cfg(feature = "cad")]
                if let (Some(f), Some(o)) = (&m.faces, v.as_object_mut()) {
                    o.insert("faces".to_owned(), json!(f));
                }
                v
            }
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
    /// A mesh in the raw binary form (`TriMesh::from_raw`), read through the host's files.
    #[serde(rename_all = "camelCase")]
    Raw { raw_path: String },
    Flat {
        positions: Vec<f64>,
        indices: Vec<u32>,
        #[cfg(feature = "cad")]
        #[serde(default)]
        faces: Option<Faces>,
    },
    Nested {
        positions: Vec<V3>,
        triangles: Vec<[u32; 3]>,
        #[cfg(feature = "cad")]
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
    #[allow(
        unused_mut,
        reason = "face keys are added only in builds with the cad feature"
    )]
    let mut m = match parse::<MeshIn>(v)? {
        MeshIn::Stl { stl_base64 } => {
            let bytes = base64_decode(&stl_base64).ok_or_else(|| Error::mesh(key, "bad base64"))?;
            TriMesh::from_stl(&bytes, key)?
        }
        MeshIn::Path { stl_path } => TriMesh::from_stl(&files(&stl_path)?, &stl_path)?,
        MeshIn::Raw { raw_path } => TriMesh::from_raw(&files(&raw_path)?, &raw_path)?,
        MeshIn::Flat {
            positions,
            indices,
            #[cfg(feature = "cad")]
            faces,
        } => {
            #[allow(unused_mut, reason = "faces are read only in builds with the cad feature")]
            let mut m = TriMesh::from_flat(&positions, &indices)?;
            #[cfg(feature = "cad")]
            {
                m.faces = faces.filter(|f| f.fit(&m));
            }
            m
        }
        MeshIn::Nested {
            positions,
            triangles,
            #[cfg(feature = "cad")]
            faces,
        } => {
            #[allow(unused_mut, reason = "faces are read only in builds with the cad feature")]
            let mut m = TriMesh::new(positions, triangles);
            m.validate(key)?;
            #[cfg(feature = "cad")]
            {
                m.faces = faces.filter(|f| f.fit(&m));
            }
            m
        }
    };
    #[cfg(feature = "cad")]
    crate::faces::base_keys(&mut m);
    Ok(m)
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

/// The mesh of a paint request (`mesh`, placed by `transform` when given) and its layer's texts (`paint`).
fn paint_input(
    req: &Value,
    files: FileLoader<'_>,
) -> Result<(TriMesh, std::collections::BTreeMap<u32, String>)> {
    let mut m = mesh_field(req, "mesh", files)?;
    let transform: Option<Vec<f64>> = field_or(req, "transform", None)?;
    if let Some(t) = transform {
        let t = <[f64; 16]>::try_from(t)
            .map_err(|_| Error::invalid("transform", "needs 16 numbers, column-major"))?;
        m = crate::xform::transformed(&m, &t);
    }
    let paint: std::collections::BTreeMap<String, String> = field_or_default(req, "paint")?;
    let paint = paint
        .into_iter()
        .map(|(k, t)| {
            k.parse::<u32>()
                .map(|i| (i, t))
                .map_err(|_| Error::invalid("paint", format!("{k} is not a triangle index")))
        })
        .collect::<Result<_>>()?;
    Ok((m, paint))
}

/// The largest regions as JSON (at most 20), so a reply stays small.
fn regions_json(r: &[paint_ops::Region]) -> Value {
    Value::from(
        r.iter()
            .take(20)
            .map(|g| {
                json!({
                    "areaMm2": (g.area_mm2 * 100.0).round() / 100.0,
                    "triangles": g.triangles.len(),
                    "boundsMm": { "min": g.bounds.min, "max": g.bounds.max },
                })
            })
            .collect::<Vec<_>>(),
    )
}

/// A paint target from JSON: `{ "kind": "part" }`, `{ "kind": "direction", "direction": "bottom" | [x, y, z],
/// "angleDeg": 30, "pick": "all" | "largest" | { "nearest": [x, y, z] } }`, `{ "kind": "height", "below": z }` (or
/// `above`, or `from` and `to`), `{ "kind": "seed", "point": [x, y, z], "angleDeg": 30, "mode": "smart" | "bucket" }`
/// or `{ "kind": "replace", "from": state }`.
fn paint_target(v: &Value) -> Result<paint_ops::Target> {
    let kind: String = field(v, "kind")?;
    Ok(match kind.as_str() {
        "part" => paint_ops::Target::Part,
        "direction" => {
            let dir = match v.get("direction") {
                Some(Value::String(name)) => paint_ops::Target::named_direction(name).ok_or_else(|| {
                    Error::invalid(
                        "direction",
                        format!("{name} is not bottom, top, front, back, left or right"),
                    )
                })?,
                Some(d) => parse::<V3>(d)?,
                None => return Err(Error::invalid("direction", "missing")),
            };
            let pick = match v.get("pick") {
                None => paint_ops::Pick::All,
                Some(Value::String(p)) if p == "all" => paint_ops::Pick::All,
                Some(Value::String(p)) if p == "largest" => paint_ops::Pick::Largest,
                Some(p) => {
                    paint_ops::Pick::Nearest(p.get("nearest").map(parse::<V3>).transpose()?.ok_or_else(
                        || Error::invalid("pick", "all, largest or { \"nearest\": [x, y, z] }"),
                    )?)
                }
            };
            paint_ops::Target::Direction {
                dir,
                angle_deg: field_or(v, "angleDeg", 30.0)?,
                pick,
            }
        }
        "height" => {
            let below: Option<f64> = field_or(v, "below", None)?;
            let above: Option<f64> = field_or(v, "above", None)?;
            let from: Option<f64> = field_or(v, "from", None)?;
            let to: Option<f64> = field_or(v, "to", None)?;
            let (lo, hi) = match (below, above, from, to) {
                (Some(b), None, None, None) => (f64::NEG_INFINITY, b),
                (None, Some(a), None, None) => (a, f64::INFINITY),
                (None, None, Some(f), Some(t)) => (f, t),
                _ => return Err(Error::invalid("height", "give below, above, or from and to (mm)")),
            };
            paint_ops::Target::Height { lo, hi }
        }
        "seed" => {
            let mode: String = field_or(v, "mode", "smart".to_owned())?;
            if mode != "smart" && mode != "bucket" {
                return Err(Error::invalid("mode", format!("{mode} is not smart or bucket")));
            }
            paint_ops::Target::Seed {
                point: field(v, "point")?,
                angle_deg: field_or(v, "angleDeg", 30.0)?,
                bucket: mode == "bucket",
            }
        }
        "replace" => paint_ops::Target::Replace {
            from: field(v, "from")?,
        },
        other => {
            return Err(Error::invalid(
                "kind",
                format!("{other} is not part, direction, height, seed or replace"),
            ));
        }
    })
}

/// `paint.select`: what `target` paints with `state` (0 clears) on `mesh`, whose layer holds `paint`. The reply gives
/// the new text of each triangle it changes (an empty text leaves it unpainted), the area it picked and its regions.
fn paint_select_op(req: &Value, files: FileLoader<'_>) -> Result<Value> {
    let (m, paint) = paint_input(req, files)?;
    let target = paint_target(
        req.get("target")
            .ok_or_else(|| Error::invalid("target", "missing"))?,
    )?;
    let state: u8 = field(req, "state")?;
    if state > crate::paint_tree::MAX_STATE {
        return Err(Error::invalid(
            "state",
            format!("paint names states 0 to {}", crate::paint_tree::MAX_STATE),
        ));
    }
    let depth: u32 = field_or(req, "maxDepth", paint_ops::DEFAULT_DEPTH)?;
    let sel = paint_ops::select(&m, &paint, &target, state, depth.min(10))?;
    Ok(json!({
        "changed": sel.changed.iter().map(|(k, v)| (k.to_string(), Value::from(v.clone()))).collect::<serde_json::Map<_, _>>(),
        "changedTriangles": sel.changed.len(),
        "selectedAreaMm2": (sel.area_mm2 * 100.0).round() / 100.0,
        "regionCount": sel.regions.len(),
        "regions": regions_json(&sel.regions),
    }))
}

/// `paint.regions`: the layer's `paint` on `mesh` read back, per painted state: area, triangles and connected regions.
fn paint_regions_op(req: &Value, files: FileLoader<'_>) -> Result<Value> {
    let (m, paint) = paint_input(req, files)?;
    let (states, bad) = paint_ops::regions(&m, &paint);
    Ok(json!({
        "states": states.iter().map(|s| json!({
            "state": s.state,
            "areaMm2": (s.area_mm2 * 100.0).round() / 100.0,
            "triangles": s.triangles,
            "regionCount": s.regions.len(),
            "regions": regions_json(&s.regions),
        })).collect::<Vec<_>>(),
        "badPaint": bad,
    }))
}

/// `#rrggbb` as a color.
fn hex_color(s: &str) -> Option<[u8; 3]> {
    let h = s.trim().strip_prefix('#')?;
    if h.len() != 6 {
        return None;
    }
    let byte = |i: usize| h.get(i..i + 2).and_then(|b| u8::from_str_radix(b, 16).ok());
    Some([byte(0)?, byte(2)?, byte(4)?])
}

/// One object of a render request: `mesh` (any mesh form), and optionally `transform` (16 numbers, column-major),
/// `slot` (its filament, 1-based), `color` (`#rrggbb`) and `paint` (paint texts by triangle index).
fn render_object(v: &Value, files: FileLoader<'_>) -> Result<render::Object> {
    let mesh = mesh_field(v, "mesh", files)?;
    let transform: Option<Vec<f64>> = field_or(v, "transform", None)?;
    let transform = match transform {
        Some(t) => Some(
            <[f64; 16]>::try_from(t)
                .map_err(|_| Error::invalid("transform", "needs 16 numbers, column-major"))?,
        ),
        None => None,
    };
    let color: Option<String> = field_or(v, "color", None)?;
    let color = match color {
        Some(c) => Some(hex_color(&c).ok_or_else(|| Error::invalid("color", format!("{c} is not #rrggbb")))?),
        None => None,
    };
    let paint: std::collections::BTreeMap<String, String> = field_or_default(v, "paint")?;
    let paint = paint
        .into_iter()
        .map(|(k, t)| {
            k.parse::<u32>()
                .map(|i| (i, t))
                .map_err(|_| Error::invalid("paint", format!("{k} is not a triangle index")))
        })
        .collect::<Result<_>>()?;
    Ok(render::Object {
        mesh,
        transform,
        slot: field_or(v, "slot", 1)?,
        color,
        paint,
    })
}

/// `render`: a picture of `objects` (or of one `mesh` with its `paint`), from `view` (`iso`, `top`, `front` or `fit`,
/// framed on `focus` or on the paint), `size` px on the long side (384 by default), filaments colored from `colors`.
/// The reply says what is in the picture; the PNG comes with it only when `image` is true.
fn render_op(req: &Value, files: FileLoader<'_>) -> Result<Value> {
    let objects: Vec<render::Object> = match req.get("objects").and_then(Value::as_array) {
        Some(list) => list
            .iter()
            .map(|o| render_object(o, files))
            .collect::<Result<_>>()?,
        None => vec![render_object(req, files)?],
    };
    let view: String = field_or(req, "view", "iso".to_owned())?;
    let view = render::View::parse(&view)
        .ok_or_else(|| Error::invalid("view", format!("{view} is not iso, top, front or fit")))?;
    let colors: Vec<String> = field_or_default(req, "colors")?;
    let colors = colors
        .iter()
        .map(|c| hex_color(c).ok_or_else(|| Error::invalid("colors", format!("{c} is not #rrggbb"))))
        .collect::<Result<Vec<_>>>()?;
    let opts = render::Options {
        view,
        size: field_or(req, "size", render::DEFAULT_SIZE)?,
        colors,
        focus: field_or(req, "focus", None)?,
    };
    let (img, s) = render::render(&objects, &opts)?;
    let mut out = json!({
        "view": s.view.name(),
        "widthPx": s.width,
        "heightPx": s.height,
        "boundsMm": { "min": s.bounds.min, "max": s.bounds.max },
        "framedMm": { "min": s.framed.min, "max": s.framed.max },
        "objects": s.objects,
        "triangles": s.triangles,
        "paintedAreaMm2": s.painted_mm2.iter().map(|(k, v)| (k.to_string(), json!((v * 100.0).round() / 100.0))).collect::<serde_json::Map<_, _>>(),
        "badPaint": s.bad_paint,
    });
    if field_or(req, "image", false)?
        && let Some(o) = out.as_object_mut()
    {
        o.insert(
            "pngBase64".to_owned(),
            Value::from(base64_encode(&render::png(&img))),
        );
    }
    Ok(out)
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
        let here = operations();
        for (op, req) in cases {
            let out = call(op, &req.to_string());
            if here.contains(&op) {
                assert!(out.is_ok(), "{op}: {:?}", out.err());
            } else {
                // A build that leaves the tool out says so.
                let why = out.err().map(|e| e.to_string()).unwrap_or_default();
                assert!(why.contains("not in this build"), "{op}: {why}");
            }
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
    fn subtract_flush_with_the_body_stays_closed() {
        let cube = build::box_mesh([0.0; 3], [20.0, 20.0, 20.0]);
        let mesh = json!({ "positions": cube.positions.iter().flatten().collect::<Vec<_>>(),
                           "indices": cube.triangles.iter().flatten().collect::<Vec<_>>() });
        let pi = std::f64::consts::PI;
        // full depth hole: the cutter's floor lies on the cube's bottom; a box flush at both caps; a notch flush
        // with a side
        for (solid, expect) in [
            (
                json!({ "type": "cylinder", "origin": [10, 10, 0], "diameterMm": 8, "heightMm": 20.5 }),
                pi * 16.0 * 20.0,
            ),
            (
                json!({ "type": "box", "min": [5, 5, 0], "max": [15, 15, 20] }),
                10.0 * 10.0 * 20.0,
            ),
            (
                json!({ "type": "box", "min": [15, 5, 10], "max": [20, 15, 20] }),
                5.0 * 10.0 * 10.0,
            ),
        ] {
            let out = run("subtract", &json!({ "mesh": mesh, "solids": [solid] }));
            assert_eq!(out["watertight"], true, "{solid}: {}", out["edges"]);
            let removed = out["removedVolumeMm3"].as_f64().unwrap();
            assert!(
                (removed - expect).abs() < 0.01 * expect,
                "{solid}: {removed} vs {expect}"
            );
        }
    }

    /// A mesh as the app keeps it and sends it: corners rounded to f32.
    #[cfg(feature = "cad")]
    #[allow(clippy::cast_possible_truncation, reason = "rounding to f32 on purpose")]
    fn stored(m: &TriMesh) -> Value {
        json!({ "positions": m.positions.iter().flatten().map(|&c| f64::from(c as f32)).collect::<Vec<_>>(),
                "indices": m.triangles.iter().flatten().collect::<Vec<_>>() })
    }

    /// A triangle of a hole's wall in `m` (upright, `r` from the vertical line through `c`).
    #[cfg(feature = "holes")]
    fn hole_wall(m: &TriMesh, c: [f64; 2], r: f64) -> Option<usize> {
        (0..m.triangles.len()).find(|&t| {
            let [a, b, d] = m.corners(m.triangles[t]);
            let mid = crate::vec3::scale(crate::vec3::add(crate::vec3::add(a, b), d), 1.0 / 3.0);
            crate::vec3::normalize(m.normal(m.triangles[t])).is_some_and(|n| n[2].abs() < 1e-3)
                && (crate::fm::Fm::m_hypot(mid[0] - c[0], mid[1] - c[1]) - r).abs() < 0.05
        })
    }

    #[cfg(feature = "holes")]
    #[test]
    fn the_hole_and_thread_tools_find_a_subtract_hole_on_the_answer() {
        // As the app cuts it: a 20 mm box on f32 corners, sent in bed coordinates or in its own frame with its
        // transform, a cylinder from the top, through or blind. The answer's corners are f32 too.
        let at = [34.1, 16.1];
        let mut moved = crate::xform::IDENTITY;
        moved[12..14].copy_from_slice(&at);
        let bed = stored(&build::box_mesh([24.1, 6.1, 0.0], [44.1, 26.1, 20.0]));
        let own = json!({ "mesh": stored(&build::box_mesh([-10.0, -10.0, 0.0], [10.0, 10.0, 20.0])),
                          "transform": moved });
        let (mut found, mut tried) = (0, 0);
        let mut missed = Vec::new();
        for (part, transform, local) in [(bed, crate::xform::IDENTITY, at), (own, moved, [0.0; 2])] {
            for (depth, through) in [(25.0_f64, true), (12.0, false)] {
                for (d, size) in [(6.8_f64, "M8"), (5.0, "M6")] {
                    let solid = json!({ "type": "cylinder", "origin": [at[0], at[1], 20.5 - depth - 0.5],
                                        "axis": [0, 0, 1], "diameterMm": d, "heightMm": depth + 0.5 });
                    let case = format!(
                        "d {d}, depth {depth}, transform {}",
                        transform != crate::xform::IDENTITY
                    );
                    tried += if cfg!(feature = "threads") { 2 } else { 1 };
                    let req = json!({ "mesh": part, "solids": [solid], "withFaces": true });
                    let out: Value = match call("subtract", &req.to_string()) {
                        Ok(out) => serde_json::from_str(&out).unwrap(),
                        Err(e) => {
                            missed.push(format!("subtract, {case}: {e}"));
                            continue;
                        }
                    };
                    let m = mesh_value(&out["mesh"], "mesh", &|_| unreachable!()).unwrap();
                    let t = hole_wall(&m, local, d / 2.0).expect("a wall triangle");
                    let pick = json!({ "mesh": { "mesh": out["mesh"], "transform": transform }, "triangle": t,
                                       "at": [at[0], at[1], 19.9] });
                    match call("hole.find", &pick.to_string()) {
                        Ok(h) => {
                            let h: Value = serde_json::from_str(&h).unwrap();
                            assert_eq!(h["through"], through, "{case}: {h}");
                            assert!(
                                (h["diameterMm"].as_f64().unwrap() - d).abs() < 1e-3,
                                "{case}: {h}"
                            );
                            assert!(
                                (h["depthMm"].as_f64().unwrap() - depth.min(20.0)).abs() < 1e-3,
                                "{case}: {h}"
                            );
                            found += 1;
                        }
                        Err(e) => missed.push(format!("hole, {case}: {e}")),
                    }
                    #[cfg(feature = "threads")]
                    {
                        match call("thread.find", &pick.to_string()) {
                            Ok(th) => {
                                let th: Value = serde_json::from_str(&th).unwrap();
                                assert_eq!(th["internal"], true, "{case}: {th}");
                                assert_eq!(th["suggested"], size, "{case}: {th}");
                                found += 1;
                            }
                            Err(e) => missed.push(format!("thread, {case}: {e}")),
                        }
                    }
                    #[cfg(not(feature = "threads"))]
                    let _ = size;
                }
            }
        }
        assert_eq!(found, tried, "found {found} of {tried}: {missed:#?}");
    }

    #[cfg(feature = "holes")]
    #[test]
    fn a_subtract_hole_made_another_size_is_found_again() {
        // The answer's f32 corners cross nowhere, so the hole tool's boolean keeps the faces, and the hole it made
        // is found again (by its axis, as a client reads it back).
        let out = run(
            "subtract",
            &json!({ "mesh": stored(&build::box_mesh([0.0; 3], [20.0; 3])), "withFaces": true, "keySalt": 5,
                     "solids": [{ "type": "cylinder", "origin": [10, 10, -1], "axis": [0, 0, 1],
                                  "diameterMm": 6.8, "heightMm": 22 }] }),
        );
        let m = mesh_value(&out["mesh"], "mesh", &|_| unreachable!()).unwrap();
        assert!(!crate::boolean::Solid::new(&m).unwrap().unclean());
        let t = hole_wall(&m, [10.0, 10.0], 3.4).expect("a wall triangle");
        let h = run(
            "hole.find",
            &json!({ "mesh": out["mesh"], "triangle": t, "at": [10, 10, 19] }),
        );
        let made = run(
            "hole.apply",
            &json!({ "mesh": out["mesh"], "hole": h, "spec": { "diameterMm": 5.0 }, "withFaces": true, "keySalt": 6 }),
        );
        assert!(
            made["mesh"]["faces"]["table"]
                .as_array()
                .unwrap()
                .iter()
                .all(|s| s["kind"] != "other"),
            "{}",
            made["mesh"]["faces"]["table"]
        );
        let again = run(
            "hole.find",
            &json!({ "mesh": made["mesh"], "at": [10, 10, 20], "axis": [0, 0, 1] }),
        );
        assert!(
            (again["diameterMm"].as_f64().unwrap() - 5.0).abs() < 1e-3,
            "{again}"
        );
        assert_eq!(again["through"], true);
    }

    #[cfg(feature = "cad")]
    #[test]
    fn subtract_keeps_the_keys_of_the_faces_it_leaves_whole() {
        use crate::faces::{Faces, Surface};
        // the answer's faces and the key of each that `pick` matches
        let keys = |out: &Value, pick: &dyn Fn(&Surface) -> bool| -> Vec<u64> {
            let f: Faces = serde_json::from_value(out["mesh"]["faces"].clone()).unwrap();
            assert_eq!(f.keys.len(), f.table.len(), "every face has a key slot");
            f.table
                .iter()
                .zip(&f.keys)
                .filter(|(s, _)| pick(s))
                .map(|(_, &k)| k)
                .collect()
        };
        let top = |s: &Surface| matches!(s, Surface::Plane { normal, offset } if normal[2] > 0.999 && (offset - 20.0).abs() < 1e-3);
        let wall = |x: f64| move |s: &Surface| matches!(s, Surface::Cylinder { origin, radius, .. } if (radius - 3.4).abs() < 1e-3 && (origin[0] - x).abs() < 1e-3);
        let hole = |x: f64| json!({ "type": "cylinder", "origin": [x, 10, -1], "axis": [0, 0, 1], "diameterMm": 6.8, "heightMm": 22 });
        let cut = |mesh: Value, solid: Value, salt: u64| {
            run(
                "subtract",
                &json!({ "mesh": mesh, "solids": [solid], "withFaces": true, "keySalt": salt }),
            )
        };
        // a first hole: the box's faces are keyed as a base, and its wall gets a key of the step
        let one = cut(
            stored(&build::box_mesh([0.0; 3], [40.0, 20.0, 20.0])),
            hole(10.0),
            5,
        );
        let [top1] = keys(&one, &top)[..] else {
            panic!(
                "one top face: {} {}",
                one["mesh"]["faces"]["table"], one["mesh"]["faces"]["keys"]
            )
        };
        let [wall1] = keys(&one, &wall(10.0))[..] else {
            panic!("one wall")
        };
        assert!(top1 != 0 && wall1 != 0 && top1 != wall1);
        // a second hole on the first's answer, rounded to f32 as the app stores it: what it leaves whole keeps its key
        let two = cut(one["mesh"].clone(), hole(30.0), 6);
        assert_eq!(keys(&two, &top), [top1]);
        assert_eq!(keys(&two, &wall(10.0)), [wall1]);
        let [wall2] = keys(&two, &wall(30.0))[..] else {
            panic!("one new wall")
        };
        assert!(wall2 != 0 && wall2 != wall1 && wall2 != top1);
        // and the hole tool still finds the first hole after the second cut
        #[cfg(feature = "holes")]
        {
            let m = mesh_value(&two["mesh"], "mesh", &|_| unreachable!()).unwrap();
            let t = hole_wall(&m, [10.0, 10.0], 3.4).expect("a wall triangle");
            let h = run(
                "hole.find",
                &json!({ "mesh": two["mesh"], "triangle": t, "at": [10, 10, 19.9] }),
            );
            assert!((h["diameterMm"].as_f64().unwrap() - 6.8).abs() < 1e-3, "{h}");
        }
        // a slot across the top splits it in two: neither piece keeps its key, the walls still do
        let slot = json!({ "type": "box", "min": [19, -1, 15], "max": [21, 21, 21] });
        let three = cut(two["mesh"].clone(), slot, 7);
        assert_eq!(keys(&three, &top), [0, 0]);
        assert_eq!(keys(&three, &wall(10.0)), [wall1]);
        assert_eq!(keys(&three, &wall(30.0)), [wall2]);
        // without a step's salt, the faces still come back, keyless
        let plain = run(
            "subtract",
            &json!({ "mesh": stored(&build::box_mesh([0.0; 3], [40.0, 20.0, 20.0])),
                                             "solids": [hole(10.0)], "withFaces": true }),
        );
        assert!(
            plain["mesh"]["faces"]["keys"].is_null(),
            "{}",
            plain["mesh"]["faces"]
        );
        assert!(!plain["mesh"]["faces"]["table"].as_array().unwrap().is_empty());
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

    #[cfg(feature = "svg")]
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

    #[cfg(feature = "cad")]
    #[test]
    fn sketch_svg_returns_loops_and_their_check() {
        let svg = "<svg viewBox=\"0 0 50 50\" width=\"50mm\"><rect width=\"20\" height=\"10\"/></svg>";
        let out = run(
            "sketch.svg",
            &json!({ "svg": svg, "options": { "fitWidthMm": 40, "center": [5, 5] } }),
        );
        assert_eq!(out["loops"][0]["start"], json!([-15.0, 15.0]));
        assert_eq!(out["counts"]["lines"], 4);
        assert_eq!(out["sizeMm"], json!([40.0, 20.0]));
        assert_eq!(out["check"]["ok"], true);
        assert!(call("sketch.svg", &json!({ "svg": "<svg/>" }).to_string()).is_err());
    }

    #[cfg(feature = "trace")]
    #[test]
    fn sketch_trace_pixels_carry_their_file_size_and_take_a_path_and_every_mode() {
        // a 40 px black square on clear, 60 px across, and the same at half size
        let px = |n: usize, lo: usize, hi: usize, out: [u8; 4]| -> Vec<u8> {
            (0..n * n)
                .flat_map(|i| {
                    let (x, y) = (i % n, i / n);
                    if (lo..hi).contains(&x) && (lo..hi).contains(&y) {
                        [0, 0, 0, 255]
                    } else {
                        out
                    }
                })
                .collect()
        };
        let (big, small) = (
            px(60, 10, 50, [255, 255, 255, 255]),
            px(30, 5, 25, [255, 255, 255, 255]),
        );
        let png = crate::raster::tests::png(60, 60, 4, &big, None);
        let options = json!({ "mmPerPx": 0.5, "center": [0, 0] });
        let size = |out: &Value, want: f64| {
            for v in out["sizeMm"].as_array().unwrap() {
                assert!((v.as_f64().unwrap() - want).abs() < 0.05, "{out}");
            }
        };
        let file = run(
            "sketch.trace",
            &json!({ "image": { "base64": base64_encode(&png) }, "options": options }),
        );
        size(&file, 20.0);
        // pixels shrunk from the file give the file's size in mm when they say how big the file was
        let shrunk = run(
            "sketch.trace",
            &json!({ "image": { "rgba": base64_encode(&small), "width": 30, "height": 30, "fileWidth": 60, "fileHeight": 60 }, "options": options }),
        );
        size(&shrunk, 20.0);
        assert_eq!(shrunk["imagePx"], json!([60, 60]));
        assert_eq!(shrunk["mmPerPx"], json!(0.5));
        // without it the pixels are the file
        let own = run(
            "sketch.trace",
            &json!({ "image": { "rgba": base64_encode(&small), "width": 30, "height": 30 }, "options": options }),
        );
        size(&own, 10.0);
        // a path is read through the host's files
        let files = |p: &str| -> Result<Vec<u8>> {
            if p == "art/square.png" {
                Ok(png.clone())
            } else {
                Err(Error::invalid("path", format!("{p}: not found")))
            }
        };
        let req = json!({ "image": { "path": "art/square.png" }, "options": options });
        let by_path: Value =
            serde_json::from_str(&call_with_files("sketch.trace", &req.to_string(), &files).unwrap())
                .unwrap();
        assert_eq!(by_path["loops"], file["loops"]);
        assert!(call("sketch.trace", &req.to_string()).is_err());
        // alpha on a transparent image traces the opaque part, and on an opaque one the whole image
        let clear = px(60, 10, 50, [255, 255, 255, 0]);
        let alpha = json!({ "mode": "alpha", "mmPerPx": 0.5 });
        let opaque_part = run(
            "sketch.trace",
            &json!({ "image": { "rgba": base64_encode(&clear), "width": 60, "height": 60 }, "options": alpha }),
        );
        assert_eq!(opaque_part["mode"], "alpha");
        size(&opaque_part, 20.0);
        let whole = run(
            "sketch.trace",
            &json!({ "image": { "rgba": base64_encode(&big), "width": 60, "height": 60 }, "options": alpha }),
        );
        size(&whole, 30.0);
        let too_wide = vec![0u8; 4097 * 4];
        for bad in [
            json!({ "image": { "rgba": base64_encode(&too_wide), "width": 4097, "height": 1 } }),
            json!({ "image": { "rgba": base64_encode(&small[..small.len() - 4]), "width": 30, "height": 30 } }),
            json!({ "image": { "rgba": base64_encode(&small), "width": 30, "height": 30, "fileWidth": 0, "fileHeight": 60 } }),
            json!({ "image": { "rgba": base64_encode(&small), "width": 30, "height": 30, "fileWidth": 60 } }),
        ] {
            assert!(call("sketch.trace", &bad.to_string()).is_err(), "{bad}");
        }
    }

    #[cfg(feature = "trace")]
    #[test]
    fn sketch_trace_takes_a_file_or_pixels_and_its_loops_extrude() {
        // a 40 px black square on white, 60 px across
        let mut rgba = Vec::new();
        for y in 0..60 {
            for x in 0..60 {
                let inside = (10..50).contains(&x) && (10..50).contains(&y);
                rgba.extend(if inside {
                    [0, 0, 0, 255]
                } else {
                    [255, 255, 255, 255]
                });
            }
        }
        let png = crate::raster::tests::png(60, 60, 4, &rgba, None);
        let options = json!({ "widthMm": 20, "center": [100, 100], "fit": "curves" });
        let file = run(
            "sketch.trace",
            &json!({ "image": { "base64": base64_encode(&png) }, "options": options }),
        );
        let pixels = run(
            "sketch.trace",
            &json!({ "image": { "rgba": base64_encode(&rgba), "width": 60, "height": 60 }, "options": options }),
        );
        assert_eq!(file["loops"], pixels["loops"]);
        assert_eq!(file["counts"]["lines"], 4);
        assert_eq!(file["sizeMm"], json!([20.0, 20.0]));
        assert_eq!(file["imagePx"], json!([60, 60]));
        assert_eq!(file["mode"], "dark");
        assert_eq!(file["check"]["ok"], true);
        assert!(file.get("previewPng").is_none());
        let solid = run(
            "shape.extrude",
            &json!({ "shape": { "type": "sketch", "loops": file["loops"] }, "spec": { "distanceMm": 2.0 } }),
        );
        let v = solid["volumeMm3"].as_f64().unwrap();
        assert!((v - 800.0).abs() < 4.0, "{v}");
        for bad in [
            json!({ "image": { "base64": "AAAA" } }),
            json!({ "image": { "rgba": "AAAA", "width": 2, "height": 2 } }),
            json!({ "image": {} }),
            json!({ "image": { "base64": base64_encode(&png) }, "options": { "fit": "blobs" } }),
        ] {
            assert!(call("sketch.trace", &bad.to_string()).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_pinch_where_corners_meet_at_f32_is_suspect() {
        // two boxes closed by their indices whose touching faces meet only once rounded to f32: fat triangles only
        let a = build::box_mesh([120.0, 0.0, 0.0], [130.0, 10.0, 10.0]);
        assert!(!suspect(&a));
        let b = build::box_mesh([130.000_002, 0.0, 0.0], [140.0, 10.0, 10.0]);
        let mut m = a.clone();
        m.append(&b);
        assert!(m.edge_report().is_watertight());
        assert!(suspect(&m));
        assert!(!crate::boolean::stores_clean(&m));
    }

    /// the curved drawer handle a build eval made: two posts, a bar swept from one to the other and joined, then a
    /// screw hole up each post, all in plate millimeters on a part that landed by `off`
    #[cfg(feature = "cad")]
    mod landed {
        use super::*;
        use crate::fm::Fm as _;

        fn mesh(v: &Value) -> TriMesh {
            let p: Vec<f64> = serde_json::from_value(v["positions"].clone()).unwrap();
            let i: Vec<u32> = serde_json::from_value(v["indices"].clone()).unwrap();
            TriMesh::from_flat(&p, &i).unwrap()
        }

        /// closed once corners at the same f32 point are one, as the slicer welds the part
        fn closed(v: &Value) -> bool {
            let m = mesh(v);
            m.edge_report().is_watertight() && closed_at_f32(&m)
        }

        fn frame(off: [f64; 2]) -> Value {
            json!([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, off[0], off[1], 0, 1])
        }

        /// the swept post A and post B in the part's own frame, as the app keeps them
        fn posts(off: [f64; 2]) -> (Value, Value) {
            let post = |x: f64| {
                let mut m = run(
                    "build",
                    &json!({ "solids": [{ "type": "cylinder", "origin": [x, 0, 8], "axis": [0, 1, 0],
                    "diameterMm": 16, "heightMm": 10 }], "withFaces": true }),
                )["mesh"]
                    .clone();
                let p: Vec<f64> = serde_json::from_value(m["positions"].clone()).unwrap();
                let p: Vec<f64> = p
                    .iter()
                    .enumerate()
                    .map(|(i, v)| v - [off[0], off[1], 0.0][i % 3])
                    .collect();
                m["positions"] = json!(p);
                m
            };
            let n = 0.822_f64.m_hypot(0.569);
            let swept = run(
                "sketch.sweep",
                &json!({ "profile": { "frame": { "origin": [8, 10, 8], "normal": [0.822 / n, 0.569 / n, 0], "u": [0, 0, 1],
                        "v": [0.569 / n, -0.822 / n, 0] }, "loops": [{ "type": "circle", "center": [0, 0], "diameterMm": 12 }] },
                    "path": { "frame": { "origin": [0, 0, 0], "normal": [0, 0, 1], "u": [1, 0, 0], "v": [0, 1, 0] },
                        "loops": [{ "start": [8, 10], "segments": [{ "type": "arc", "to": [136, 10], "through": [72, 30] }] }] },
                    "operation": "join", "target": { "mesh": post(8.0), "transform": frame(off) }, "withFaces": true }),
            );
            (swept["mesh"].clone(), post(136.0))
        }

        fn joined(off: [f64; 2]) -> std::result::Result<Value, String> {
            let (a, b) = posts(off);
            call(
                "boolean",
                &json!({ "op": "union", "a": [{ "mesh": a, "transform": frame(off) }, { "mesh": b, "transform": frame(off) }],
                    "withFaces": true, "keySalt": 5 })
                .to_string(),
            )
            .map(|s| serde_json::from_str(&s).unwrap())
            .map_err(|e| e.to_string())
        }

        fn drilled(body: &Value, off: [f64; 2], xs: &[f64]) -> Value {
            let solids: Vec<Value> = xs
                .iter()
                .map(|x| json!({ "type": "cylinder", "origin": [x, -1, 8], "axis": [0, 1, 0], "diameterMm": 4.5, "heightMm": 9 }))
                .collect();
            run(
                "subtract",
                &json!({ "mesh": { "mesh": body, "transform": frame(off) }, "solids": solids, "withFaces": true }),
            )
        }

        #[test]
        fn the_drawer_handle_s_screw_holes_leave_it_closed_where_it_landed() {
            // landed by (128, 123), the bar's end face corners sit near y -113, where a float step is 7.6e-6: cuts
            // that left two corners 2.75e-6 apart there stored them as one, and five edges took four triangles each
            let off = [128.0, 123.0];
            let body = joined(off).unwrap();
            let a = drilled(&body["mesh"], off, &[8.0]);
            let b = drilled(&a["mesh"], off, &[136.0]);
            assert!(closed(&b["mesh"]));
            assert!(closed(&drilled(&body["mesh"], off, &[8.0, 136.0])["mesh"]));
        }

        #[test]
        fn the_drawer_handle_s_bar_joins_its_post_wherever_it_landed() {
            // the bar ends square on post B's end face, at its center: the join leaves needles along that seam, and
            // at these landings one lay flat once stored, so the join was refused for collapsed triangles
            let keys = |u: &Value| {
                let mut k: Vec<u64> = serde_json::from_value(u["mesh"]["faces"]["keys"].clone()).unwrap();
                k.sort_unstable();
                k.dedup();
                k
            };
            // the needle is turned only within its face, so every keyed face is there as where nothing needed turning
            let kept = keys(&joined([128.0, 123.0]).unwrap());
            assert!(kept.len() > 3, "{kept:?}");
            for off in [
                [64.0, 128.0],
                [9.599, 111.013],
                [31.693, 57.149],
                [219.768, 74.14],
            ] {
                let u = joined(off).unwrap_or_else(|e| panic!("landed at {off:?}: {e}"));
                assert!(closed(&u["mesh"]), "landed at {off:?}");
                assert_eq!(keys(&u), kept, "landed at {off:?}");
            }
        }

        #[test]
        fn drain_holes_up_a_planter_s_floor_and_axis_leave_it_closed_where_it_landed() {
            let body = run(
                "sketch.revolve",
                &json!({ "frame": { "origin": [0, 0, 0], "normal": [0, -1, 0], "u": [1, 0, 0], "v": [0, 0, 1] },
                    "loops": [{ "points": [[0, 0], [60, 0], [60, 100], [57, 100], [57, 3], [0, 3]] }],
                    "axis": { "point": [0, 0], "direction": [0, 1] }, "angleDeg": 360, "operation": "new" }),
            );
            for off in [[128.0, 128.0], [0.0, 0.0]] {
                // five d6 holes through the 3 mm floor, one along the axis the planter was turned about
                let solids: Vec<Value> = [[0.0, 0.0], [30.0, 0.0], [-30.0, 0.0], [0.0, 30.0], [0.0, -30.0]]
                    .iter()
                    .map(|c| json!({ "type": "cylinder", "origin": [c[0] + off[0], c[1] + off[1], -1], "axis": [0, 0, 1],
                        "diameterMm": 6, "heightMm": 6 }))
                    .collect();
                let cut = run(
                    "subtract",
                    &json!({ "mesh": { "mesh": body["mesh"], "transform": frame(off) }, "solids": solids, "withFaces": true }),
                );
                assert!(closed(&cut["mesh"]), "landed at {off:?}");
                // 110038 with four edges of four triangles before the bore fallback, 3260 landed now
                let n = cut["triangles"].as_u64().unwrap();
                assert!(
                    n <= 5400 && (off[0] == 0.0 || n <= 3400),
                    "landed at {off:?}: {n}"
                );
                let removed = cut["removedVolumeMm3"].as_f64().unwrap();
                assert!((removed - 420.5646).abs() < 1e-3, "landed at {off:?}: {removed}");
            }
        }
    }

    /// a bore or channel cut by the subtract tool into a turned or lofted part, then a rod joined after it
    #[cfg(feature = "cad")]
    mod turned {
        use super::*;
        use crate::fm::Fm as _;

        fn faced(op: &str, req: &Value) -> std::result::Result<Value, String> {
            let mut r = req.clone();
            r["withFaces"] = json!(true);
            call(op, &r.to_string())
                .map(|s| serde_json::from_str(&s).unwrap())
                .map_err(|e| e.to_string())
        }

        fn part(out: &Value) -> Value {
            json!({ "mesh": out["mesh"] })
        }

        /// a d110 disc with a stem revolved up from it, as a stand is drawn: `profile` in the stem's own (radius, height)
        fn turned_stem(profile: &[[f64; 2]]) -> Value {
            let base = faced(
                "shape.extrude",
                &json!({ "frame": { "origin": [150, 0, 0], "normal": [0, 0, 1], "u": [1, 0, 0], "v": [0, 1, 0] },
                    "shape": { "type": "circle", "diameterMm": 110 }, "spec": { "distanceMm": 6 } }),
            )
            .unwrap();
            faced(
                "sketch.revolve",
                &json!({ "frame": { "origin": [150, 0, 0], "normal": [0, -1, 0], "u": [1, 0, 0], "v": [0, 0, 1] },
                    "loops": [{ "points": profile }], "axis": { "point": [0, 0], "direction": [0, 1] },
                    "operation": "join", "target": part(&base) }),
            )
            .unwrap()
        }

        /// a d24.4 bore down the stem from its top at 160 mm to 20 mm, as the subtract tool cuts it
        fn bored(stem: &Value) -> Value {
            faced(
                "subtract",
                &json!({ "mesh": part(stem), "solids": [{ "type": "cylinder", "origin": [150, 0, 20], "axis": [0, 0, 1],
                    "diameterMm": 24.4, "heightMm": 145 }] }),
            )
            .unwrap()
        }

        /// a d12 rod along x from `x`, `len` long, 100 mm up: joined as an extrude, and as a union with a built rod
        fn rods_join(body: &Value, x: f64, len: f64) {
            let ex = faced(
                "shape.extrude",
                &json!({ "frame": { "origin": [x, 0, 100], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1] },
                    "shape": { "type": "circle", "diameterMm": 12 }, "spec": { "distanceMm": len, "operation": "join" },
                    "target": part(body) }),
            )
            .unwrap_or_else(|e| panic!("rod at x {x}: {e}"));
            assert_eq!(ex["watertight"], true, "rod at x {x}");
            let rod = run(
                "build",
                &json!({ "solids": [{ "type": "cylinder", "origin": [x, 0, 100], "axis": [1, 0, 0], "diameterMm": 12, "heightMm": len }] }),
            );
            let un = faced(
                "boolean",
                &json!({ "op": "union", "a": [part(body)], "b": [part(&rod)] }),
            )
            .unwrap_or_else(|e| panic!("union at x {x}: {e}"));
            assert_eq!(un["watertight"], true, "union at x {x}");
        }

        #[test]
        fn a_bore_down_a_flared_turned_stem_stays_light_and_joins_after_it_store() {
            // a tube whose wall flares out at the foot, its hole the bore's own size: before the cut lines were kept to
            // their faces, the bore split every long facet of the stem and the disc (14776 became 64180 triangles), and
            // each rod after it was refused for collapsed triangles
            let mut profile = vec![[12.2, 5.99]];
            profile.extend((0..=16).map(|i| {
                let z = 5.99 + 154.01 * f64::from(i) / 16.0;
                [14.0 + 8.0 * (-(z - 6.0) / 30.0).m_exp(), z]
            }));
            profile.push([12.2, 160.0]);
            let stem = turned_stem(&profile);
            let b = bored(&stem);
            let (before, after) = (
                stem["triangles"].as_u64().unwrap(),
                b["triangles"].as_u64().unwrap(),
            );
            // 15898 now, kept as the boolean left it when that already stores
            assert!(after < 16_000, "{before} became {after}");
            assert_eq!(b["watertight"], true);
            // through the outer wall into the bore, and from inside the wall
            rods_join(&b, 124.0, 20.0);
            rods_join(&b, 138.0, 10.0);
        }

        #[test]
        fn a_bore_down_a_solid_turned_stem_takes_the_cutter_s_volume() {
            let stem = turned_stem(&[[0.0, 5.99], [16.0, 5.99], [16.0, 160.0], [0.0, 160.0]]);
            let b = bored(&stem);
            // the cutter is a 48 sided prism, 140 mm of it inside the stem
            let r = 12.2f64;
            let want = 0.5 * 48.0 * r * r * (std::f64::consts::TAU / 48.0).m_sin() * 140.0;
            let removed = b["removedVolumeMm3"].as_f64().unwrap();
            assert!((removed - want).abs() < 1e-3, "{removed} vs {want}");
            rods_join(&b, 124.0, 20.0);
        }

        #[test]
        fn a_notch_leaves_the_faces_it_never_reached_as_they_were() {
            // a d110 disc's top and bottom are filled finely; a notch in its rim reaches neither
            let disc = faced(
                "shape.extrude",
                &json!({ "frame": { "origin": [150, 0, 0], "normal": [0, 0, 1], "u": [1, 0, 0], "v": [0, 1, 0] },
                    "shape": { "type": "circle", "diameterMm": 110 }, "spec": { "distanceMm": 6 } }),
            )
            .unwrap();
            let cut = faced(
                "subtract",
                &json!({ "mesh": part(&disc), "solids": [{ "type": "box", "min": [200, -3, 2], "max": [210, 3, 4] }] }),
            )
            .unwrap();
            assert_eq!(cut["watertight"], true);
            assert!(cut["removedVolumeMm3"].as_f64().unwrap() > 0.0);
            let caps = |v: &Value| {
                let p: Vec<f64> = serde_json::from_value(v["mesh"]["positions"].clone()).unwrap();
                let i: Vec<u32> = serde_json::from_value(v["mesh"]["indices"].clone()).unwrap();
                let at = |k: u32| [0, 1, 2].map(|c| p[k as usize * 3 + c].to_bits());
                let mut out: Vec<[[u64; 3]; 3]> = i
                    .as_chunks::<3>()
                    .0
                    .iter()
                    .map(|t| {
                        let mut c = t.map(at);
                        c.sort_unstable();
                        c
                    })
                    .filter(|c| {
                        c.iter().all(|q| [0.0, 6.0].contains(&f64::from_bits(q[2]))) && c[0][2] == c[2][2]
                    })
                    .collect();
                out.sort_unstable();
                out
            };
            let (before, after) = (caps(&disc), caps(&cut));
            assert!(before.len() > 100, "{}", before.len());
            assert_eq!(before, after);
        }

        /// a 12 mm thick d110 disc at (128, 128) with a stem turned up from it, then a bore of `d` from below
        fn stand_bore(profile: &[[f64; 2]], d: f64) -> (Value, Value) {
            placed_stand_bore(profile, d, 1.0, None)
        }

        /// `stand_bore` at `k` times the size; with `place`, the bore is cut with the part turned by that angle (degrees)
        /// about its center and its center moved to that point, as a part moved on the plate is
        fn placed_stand_bore(
            profile: &[[f64; 2]],
            d: f64,
            k: f64,
            place: Option<(f64, [f64; 2])>,
        ) -> (Value, Value) {
            let at = [128.0, 128.0];
            let base = faced(
                "shape.extrude",
                &json!({ "frame": { "origin": [at[0], at[1], 0], "normal": [0, 0, 1], "u": [1, 0, 0], "v": [0, 1, 0] },
                    "shape": { "type": "circle", "diameterMm": 110.0 * k }, "spec": { "distanceMm": 12.0 * k } }),
            )
            .unwrap();
            let loops: Vec<[f64; 2]> = profile.iter().map(|p| [p[0] * k, p[1] * k]).collect();
            let stem = faced(
                "sketch.revolve",
                &json!({ "frame": { "origin": [at[0], at[1], 0], "normal": [0, -1, 0], "u": [1, 0, 0], "v": [0, 0, 1] },
                    "loops": [{ "points": loops }], "axis": { "point": [0, 0], "direction": [0, 1] },
                    "operation": "join", "target": part(&base) }),
            )
            .unwrap();
            let (item, center) = match place {
                None => (part(&stem), at),
                Some((deg, to)) => {
                    let (s, c) = crate::fm::Fm::m_sin_cos(deg.to_radians());
                    let shift = [to[0] - (c * at[0] - s * at[1]), to[1] - (s * at[0] + c * at[1])];
                    let t = json!([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, shift[0], shift[1], 0, 1]);
                    (json!({ "mesh": stem["mesh"], "transform": t }), to)
                }
            };
            let bore = faced(
                "subtract",
                &json!({ "mesh": item, "solids": [{ "type": "cylinder", "origin": [center[0], center[1], -k],
                    "axis": [0, 0, 1], "diameterMm": d * k, "heightMm": 14.0 * k }] }),
            )
            .unwrap();
            (stem, bore)
        }

        /// true when the reply's mesh stores as it is, in the part's own frame
        fn stores(v: &Value) -> bool {
            let p: Vec<f64> = serde_json::from_value(v["mesh"]["positions"].clone()).unwrap();
            let i: Vec<u32> = serde_json::from_value(v["mesh"]["indices"].clone()).unwrap();
            crate::boolean::stores_clean(&TriMesh::from_flat(&p, &i).unwrap())
        }

        const HOLE_AT_BORE: [[f64; 2]; 6] = [
            [12.5, 6.0],
            [15.0, 6.0],
            [15.0, 12.0],
            [11.0, 162.0],
            [8.5, 162.0],
            [12.5, 12.0],
        ];

        #[test]
        fn a_bore_along_a_turned_hole_closes_on_a_turned_and_moved_part() {
            // checked and settled where the part is stored, in its own frame, not on the bed
            let (_, bore) =
                placed_stand_bore(&HOLE_AT_BORE, 25.0, 1.0, Some((90.0, [250.987_654, 249.012_345])));
            assert_eq!(bore["watertight"], true, "{}", bore["edges"]);
            assert!(stores(&bore));
            let fixed = run("repair", &json!({ "mesh": bore["mesh"] }));
            assert_eq!(fixed["report"]["watertight"], true, "{}", fixed["report"]);
        }

        #[test]
        fn a_bore_along_a_turned_hole_closes_at_a_quarter_size() {
            // corners a float step or two apart at bed positions are welded however small the part is
            let (_, bore) = placed_stand_bore(&HOLE_AT_BORE, 25.0, 0.25, None);
            assert_eq!(bore["watertight"], true, "{}", bore["edges"]);
            assert!(stores(&bore));
        }

        #[test]
        fn a_fin_goes_and_one_copy_of_a_doubled_face_stays() {
            let t = [0, 1, 2];
            assert_eq!(drop_fins(&[t, [3, 1, 0]]), vec![t, [3, 1, 0]]);
            // facing apart: both go, whatever corner each starts at
            assert!(drop_fins(&[t, [2, 1, 0]]).is_empty());
            assert!(drop_fins(&[[1, 2, 0], [0, 2, 1]]).is_empty());
            // the same way twice: one stays; three one way and one the other: one of the three stays
            assert_eq!(drop_fins(&[t, [1, 2, 0]]), vec![t]);
            assert_eq!(drop_fins(&[t, [2, 1, 0], [1, 2, 0], [2, 0, 1]]), vec![t]);
        }

        #[test]
        fn a_bore_along_a_turned_hole_of_its_own_size_stays_closed() {
            // the stem's hole is 25 mm where it meets the disc, as the bore is: the bore's edges run along the hole's
            // rim and the convex cut left the part open (21 open edges), which repair could not always close
            let (_, bore) = stand_bore(
                &[
                    [12.5, 6.0],
                    [15.0, 6.0],
                    [15.0, 12.0],
                    [11.0, 162.0],
                    [8.5, 162.0],
                    [12.5, 12.0],
                ],
                25.0,
            );
            assert_eq!(bore["watertight"], true, "{}", bore["edges"]);
            let fixed = run("repair", &json!({ "mesh": bore["mesh"] }));
            assert_eq!(fixed["report"]["watertight"], true, "{}", fixed["report"]);
        }

        #[test]
        fn a_rod_joins_a_stem_whose_bore_crosses_its_hole_at_a_shallow_angle() {
            // a 24.4 mm bore meets a hole that closes in from 25 mm at a shallow angle: the convex cut crosses itself
            // once stored, so the boolean engine cuts it, and a rod joined after it still stores
            let (_, bore) = stand_bore(
                &[
                    [12.0, 6.0],
                    [15.0, 6.0],
                    [15.0, 14.0],
                    [11.0, 162.0],
                    [8.5, 162.0],
                    [12.5, 14.0],
                ],
                24.4,
            );
            assert_eq!(bore["watertight"], true);
            let ex = faced(
                "shape.extrude",
                &json!({ "frame": { "origin": [138, 131, 155], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1] },
                    "shape": { "type": "circle", "diameterMm": 12 }, "spec": { "distanceMm": 50, "operation": "join" },
                    "target": part(&bore) }),
            );
            assert!(ex.is_ok(), "{ex:?}");
        }

        #[test]
        fn a_channel_cut_up_into_a_lofted_cavity_floor_stays_light() {
            let ring = |z: f64, d: f64| {
                json!({ "frame": { "origin": [150, 0, z], "normal": [0, 0, 1], "u": [1, 0, 0], "v": [0, 1, 0] },
                    "loops": [{ "type": "circle", "center": [0, 0], "diameterMm": d }] })
            };
            let body = faced(
                "sketch.loft",
                &json!({ "profiles": [ring(0.0, 90.0), ring(30.0, 70.0), ring(70.0, 60.0), ring(100.0, 80.0)] }),
            )
            .unwrap();
            let cavity = faced(
                "sketch.loft",
                &json!({ "profiles": [ring(8.0, 70.0), ring(30.0, 60.0), ring(70.0, 50.0), ring(100.01, 70.0)],
                    "operation": "cut", "target": part(&body) }),
            )
            .unwrap();
            let ch = faced(
                "subtract",
                &json!({ "mesh": part(&cavity), "solids": [{ "type": "cylinder", "origin": [150, 0, -1], "axis": [0, 0, 1],
                    "diameterMm": 12, "heightMm": 9.5 }] }),
            )
            .unwrap();
            let (before, after) = (
                cavity["triangles"].as_u64().unwrap(),
                ch["triangles"].as_u64().unwrap(),
            );
            // 27644 before the cut lines were kept to their faces, 4608 now
            assert!(after * 20 < before * 21, "{before} became {after}");
            assert_eq!(ch["watertight"], true);
            rods_join(&ch, 100.0, 30.0);
        }
    }
}
