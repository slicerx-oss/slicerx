// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! 3MF loading: the core specification plus what Bambu Studio and `OrcaSlicer`
//! write (objects split into component files through the production
//! extension, and per-part filament slots in `Metadata/model_settings.config`).
//!
//! The container is read with a small ZIP reader (stored and deflate entries,
//! through `miniz_oxide`) and the XML with a tag scanner that reads element
//! names and attributes, which is all the 3MF model format needs. Every build
//! item becomes one or more parts with its transform applied, so positions are
//! in the file's build space. Painted multi-material (per-triangle colors) is
//! not read yet.

use crate::error::{Error, Result};
use crate::mesh::{Mesh, MeshPart};
use std::collections::HashMap;

/// Largest uncompressed entry accepted (a guard against ZIP bombs).
const MAX_ENTRY: usize = 1 << 30;
/// Deepest component nesting followed.
const MAX_DEPTH: u32 = 16;
/// Work one file may ask of the component resolver: one unit per object visited, plus its vertices and
/// triangles for every copy placed. Components can repeat a mesh at every level, so a few lines of XML can
/// otherwise ask for billions of copies. The 1.2 million triangle benchmark mesh costs about 1.8 million.
const MAX_WORK: u64 = 40_000_000;

/// Loads the first plate of a Bambu or Orca project, or every build item of
/// a plain 3MF.
pub(crate) fn load(bytes: &[u8], name: &str) -> Result<Mesh> {
    load_plates(bytes, name)?
        .into_iter()
        .next()
        .map(|(_, m)| m)
        .ok_or_else(|| Error::mesh(name, "the 3MF file has no printable objects"))
}

/// Every plate as its own mesh, `(plate number, mesh)` in plate order. A
/// plain 3MF (no plate metadata) is one plate numbered 1.
pub(crate) fn load_plates(bytes: &[u8], name: &str) -> Result<Vec<(u32, Mesh)>> {
    Ok(load_plate_objects(bytes, name)?
        .into_iter()
        .map(|(plate, objects)| {
            (
                plate,
                Mesh {
                    name: name.to_owned(),
                    parts: objects.into_iter().flat_map(|o| o.parts).collect(),
                },
            )
        })
        .collect())
}

/// Every plate with each build item as a mesh of its own, named after its object, in plate order.
/// Positions are in the file's build space, like [`load_plates`].
pub(crate) fn load_plate_objects(bytes: &[u8], name: &str) -> Result<Vec<(u32, Vec<Mesh>)>> {
    let zip = Zip::open(bytes).map_err(|e| Error::mesh(name, e))?;
    let root = zip
        .read("_rels/.rels")
        .ok()
        .and_then(|rels| {
            tags(&rels)
                .filter(|t| t.name == "Relationship")
                .find(|t| t.attr("Type").is_some_and(|ty| ty.ends_with("/3dmodel")))
                .and_then(|t| t.attr("Target").map(|s| s.trim_start_matches('/').to_owned()))
        })
        .unwrap_or_else(|| "3D/3dmodel.model".to_owned());
    let mut models: HashMap<String, Model> = HashMap::new();
    let main = parse_model(&zip.read(&root).map_err(|e| Error::mesh(name, e))?)
        .map_err(|e| Error::mesh(name, refused(&root, e)))?;
    let settings = zip.read("Metadata/model_settings.config").unwrap_or_default();
    let slots = slot_map(&settings);
    let plate_of = plate_map(&settings);
    let names = object_names(&settings);
    let scale = main.unit_scale;
    let mut plates: std::collections::BTreeMap<u32, Vec<Mesh>> = std::collections::BTreeMap::new();
    let mut work = MAX_WORK;
    let mut costs = HashMap::new();
    for item in &main.build {
        let plate = plate_of.get(&item.object).copied().unwrap_or(1);
        let mut parts = Vec::new();
        let mut ctx = Resolve {
            zip: &zip,
            models: &mut models,
            parts: &mut parts,
            slots: &slots,
            name,
            work: &mut work,
        };
        // the whole item is costed from its object tree first, so a repeating file is refused before any copy
        let cost = ctx.cost(&main, &root, item.object, 0, &mut costs)?;
        *ctx.work = ctx
            .work
            .checked_sub(cost)
            .ok_or_else(|| Error::mesh(name, "3MF components repeat their meshes too many times to load"))?;
        ctx.object(&main, &root, item.object, item.transform, item.object, 0)?;
        if parts.is_empty() {
            continue;
        }
        if (scale - 1.0).abs() > f32::EPSILON {
            // Positions and the painted pieces decoded on them move to millimeters together.
            for p in &mut parts {
                let facets = p
                    .paint
                    .iter_mut()
                    .chain(p.support_paint.iter_mut())
                    .chain(p.seam_paint.iter_mut())
                    .chain(p.fuzzy_paint.iter_mut())
                    .flat_map(|f| f.v.iter_mut());
                for v in p.positions.iter_mut().chain(facets) {
                    for c in v.iter_mut() {
                        *c *= scale;
                    }
                }
            }
        }
        let own = names
            .get(&item.object)
            .cloned()
            .or_else(|| main.objects.get(&item.object).map(|o| o.name.clone()))
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| name.to_owned());
        plates.entry(plate).or_default().push(Mesh { name: own, parts });
    }
    if plates.is_empty() {
        return Err(Error::mesh(name, "the 3MF file has no printable objects"));
    }
    Ok(plates.into_iter().collect())
}

/// Object names from Bambu and Orca project metadata (`<object id>` with a `name` entry).
fn object_names(xml: &[u8]) -> HashMap<u32, String> {
    let mut map = HashMap::new();
    let mut object: Option<u32> = None;
    let mut part = false;
    for t in tags(xml) {
        match (t.name, t.closing) {
            ("object", false) => object = t.attr("id").and_then(|v| v.parse().ok()),
            ("object", true) => object = None,
            ("part", c) => part = !c,
            ("metadata", false) if !part && t.attr("key") == Some("name") => {
                if let (Some(o), Some(v)) = (object, t.attr("value")) {
                    map.entry(o).or_insert_with(|| v.to_owned());
                }
            }
            _ => {}
        }
    }
    map
}

/// The settings a Bambu Studio or Orca project carries next to its geometry.
/// The field names match the request of `sx-settings`' `import_project_json`.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMetadata {
    /// `Metadata/project_settings.config`, parsed (a JSON object of Orca keys).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_settings: Option<serde_json::Value>,
    /// Text of `Metadata/model_settings.config` (per-object settings, plates).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_settings: Option<String>,
    /// Text of `Metadata/layer_config_ranges.xml` (per-height overrides).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layer_ranges: Option<String>,
    /// Keys removed from `project_settings` because a file may not carry them
    /// (`post_process` runs programs, host passwords and API keys are secrets).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub dropped_keys: Vec<String>,
    /// Painted brim ears (`Metadata/brim_ear_points.txt`) per object, 1-based in the file's order: x, y, z in
    /// the space the mesh loads in (the build transform applied), and the radius of the ear head, mm.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub brim_ear_points: Vec<BrimEars>,
}

/// The painted brim ears of one object of a project.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct BrimEars {
    pub object: u32,
    pub points: Vec<[f32; 4]>,
}

/// Parses `brim_ear_points.txt`: an optional `brim_points_format_version=` line, then one
/// `object_id=N|x y z r x y z r ...` line per object.
fn parse_brim_ears(text: &str) -> Vec<(u32, Vec<[f32; 4]>)> {
    text.lines()
        .filter_map(|line| {
            let (head, body) = line.split_once('|')?;
            let id: u32 = head.strip_prefix("object_id=")?.trim().parse().ok()?;
            let nums: Vec<f32> = body
                .split_ascii_whitespace()
                .filter_map(|v| v.parse().ok())
                .collect();
            let points: Vec<[f32; 4]> = nums.as_chunks::<4>().0.to_vec();
            (id > 0 && !points.is_empty()).then_some((id, points))
        })
        .collect()
}

/// Reads the settings entries of a 3MF project without touching the geometry.
/// Entries the file does not have are `None`; a plain 3MF returns all `None`.
/// Fails when the bytes are not a ZIP archive or `project_settings.config` is
/// not JSON.
pub fn metadata(bytes: &[u8], name: &str) -> Result<ProjectMetadata> {
    let zip = Zip::open(bytes).map_err(|e| Error::mesh(name, e))?;
    let text = |entry: &str| {
        zip.read(entry)
            .ok()
            .map(|b| String::from_utf8_lossy(&b).into_owned())
    };
    let project_settings = zip
        .read("Metadata/project_settings.config")
        .ok()
        .map(|b| {
            serde_json::from_slice(&b)
                .map_err(|e| Error::mesh(name, format!("project_settings.config is not JSON: {e}")))
        })
        .transpose()?;
    let mut project_settings: Option<serde_json::Value> = project_settings;
    let mut dropped_keys = Vec::new();
    if let Some(serde_json::Value::Object(map)) = project_settings.as_mut() {
        map.retain(|k, _| {
            let keep = !crate::preflight::is_never_imported(k);
            if !keep {
                dropped_keys.push(k.clone());
            }
            keep
        });
    }
    // The ears sit in object space; the build item's transform puts them where the geometry loads.
    let brim_ear_points = text("Metadata/brim_ear_points.txt")
        .map(|t| parse_brim_ears(&t))
        .filter(|v| !v.is_empty())
        .map(|ears| {
            let root = zip
                .read("_rels/.rels")
                .ok()
                .and_then(|rels| {
                    tags(&rels)
                        .filter(|t| t.name == "Relationship")
                        .find(|t| t.attr("Type").is_some_and(|ty| ty.ends_with("/3dmodel")))
                        .and_then(|t| t.attr("Target").map(|s| s.trim_start_matches('/').to_owned()))
                })
                .unwrap_or_else(|| "3D/3dmodel.model".to_owned());
            let main = zip
                .read(&root)
                .ok()
                .and_then(|b| parse_model(&b).ok())
                .unwrap_or_default();
            ears.into_iter()
                .map(|(object, pts)| {
                    let item = usize::try_from(object - 1).ok().and_then(|i| main.build.get(i));
                    let t = item.map_or(IDENTITY, |i| i.transform);
                    let scale = if main.unit_scale > 0.0 {
                        main.unit_scale
                    } else {
                        1.0
                    };
                    BrimEars {
                        object,
                        points: pts
                            .into_iter()
                            .map(|p| {
                                let q = apply(&t, [p[0], p[1], p[2]]);
                                [q[0] * scale, q[1] * scale, q[2] * scale, p[3]]
                            })
                            .collect(),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(ProjectMetadata {
        project_settings,
        model_settings: text("Metadata/model_settings.config"),
        layer_ranges: text("Metadata/layer_config_ranges.xml"),
        dropped_keys,
        brim_ear_points,
    })
}

/// Plate number per build object from Bambu and Orca project metadata
/// (`<plate>` with `plater_id` and `model_instance` / `object_id`).
fn plate_map(xml: &[u8]) -> HashMap<u32, u32> {
    let mut map = HashMap::new();
    let mut plate: Option<u32> = None;
    let mut in_instance = false;
    for t in tags(xml) {
        match (t.name, t.closing) {
            ("plate", _) => plate = None,
            ("model_instance", c) => in_instance = !c,
            ("metadata", false) => {
                let value = t.attr("value").and_then(|v| v.parse::<u32>().ok());
                match (t.attr("key"), in_instance) {
                    (Some("plater_id"), false) => plate = value,
                    (Some("object_id"), true) => {
                        if let (Some(p), Some(o)) = (plate, value) {
                            map.entry(o).or_insert(p);
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    map
}

/// 3MF transform: rows of a 4x3 matrix applied to row vectors.
type Transform = [f32; 12];

const IDENTITY: Transform = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0];

/// A `transform` attribute: twelve finite numbers, or none at all (the identity). Anything else is refused as
/// `transform` for object `owner` (0 for a build item) and element `at`, not read as the identity.
fn parse_transform(s: Option<&str>, owner: u32, at: usize) -> Parsed<Transform> {
    let Some(s) = s else { return Ok(IDENTITY) };
    let v: Vec<f32> = s
        .split_ascii_whitespace()
        .filter_map(|x| x.parse::<f32>().ok().filter(|f| f.is_finite()))
        .collect();
    match v.as_slice().try_into() {
        Ok(t) if s.split_ascii_whitespace().count() == 12 => Ok(t),
        _ => Err(Refused("transform", owner, at, s.to_owned())),
    }
}

/// Why a model file is refused: a code, the object (0 for the file itself), the element's place in it and the
/// value read. The engine keeps it this short; the app words it (`engine-errors.ts` in the app package):
/// `unit`, `extension`, `id`, `vertex`, `triangle` (not a vertex number), `index` (past the object's vertex count,
/// which is the value) and `transform`.
struct Refused(&'static str, u32, usize, String);

type Parsed<T> = std::result::Result<T, Refused>;

/// `<path>: refused <code> <object> <element> <value>`, the text the app reads.
fn refused(path: &str, r: Refused) -> String {
    let Refused(code, object, at, value) = r;
    [
        path,
        ": refused ",
        code,
        " ",
        &object.to_string(),
        " ",
        &at.to_string(),
        " ",
        &value,
    ]
    .concat()
}

/// 3MF extensions whose content this loader reads or may leave out without changing the geometry: production
/// (components in other model files), materials and properties (colors), and the slicers' own namespaces.
const READ_EXTENSIONS: &[&str] = &[
    "http://schemas.microsoft.com/3dmanufacturing/production/2015/06",
    "http://schemas.microsoft.com/3dmanufacturing/material/2015/02",
    "http://schemas.bambulab.com/package/2021",
    "http://schemas.slic3r.org/3mf/2017/06",
];

/// `a` then `b`.
fn compose(a: &Transform, b: &Transform) -> Transform {
    let m = |t: &Transform, r: usize, c: usize| t.get(r * 3 + c).copied().unwrap_or(0.0);
    let mut out = [0f32; 12];
    for r in 0..4 {
        for c in 0..3 {
            let mut acc = if r == 3 { m(b, 3, c) } else { 0.0 };
            for k in 0..3 {
                acc += m(a, r, k) * m(b, k, c);
            }
            if let Some(o) = out.get_mut(r * 3 + c) {
                *o = acc;
            }
        }
    }
    out
}

fn apply(t: &Transform, p: [f32; 3]) -> [f32; 3] {
    let [a, b, c, d, e, f, g, h, i, j, k, l] = *t;
    let [x, y, z] = p;
    [
        x * a + y * d + z * g + j,
        x * b + y * e + z * h + k,
        x * c + y * f + z * i + l,
    ]
}

#[derive(Debug, Default)]
struct Object {
    positions: Vec<[f32; 3]>,
    triangles: Vec<[u32; 3]>,
    /// `(triangle index, paint text)` of the painted triangles.
    paint: Vec<(usize, String)>,
    /// The same for painted supports (`paint_supports`).
    support_paint: Vec<(usize, String)>,
    /// The same for painted seams (`paint_seam`).
    seam_paint: Vec<(usize, String)>,
    /// The same for painted fuzzy skin (`paint_fuzzy_skin`).
    fuzzy_paint: Vec<(usize, String)>,
    /// `(object id, model path, transform)`; an empty path means this model.
    components: Vec<(u32, String, Transform)>,
    name: String,
}

#[derive(Debug, Default)]
struct Model {
    objects: HashMap<u32, Object>,
    build: Vec<BuildItem>,
    unit_scale: f32,
}

#[derive(Debug, Clone, Copy)]
struct BuildItem {
    object: u32,
    transform: Transform,
}

/// One model file. Refuses, with what and where, what the loader would otherwise have to guess: an unknown unit,
/// an extension the file requires that is not read here, a vertex coordinate or transform that is not a number,
/// a triangle whose corner is not one of its object's vertices, an object or item without a usable id.
fn parse_model(xml: &[u8]) -> Parsed<Model> {
    let mut model = Model {
        unit_scale: 1.0,
        ..Model::default()
    };
    let mut current: Option<(u32, Object)> = None;
    let id_of = |t: &Tag<'_>, key: &str, owner: u32| -> Parsed<u32> {
        let v = t.attr(key).unwrap_or("");
        v.trim()
            .parse()
            .map_err(|_| Refused("id", owner, 0, v.to_owned()))
    };
    for t in tags(xml) {
        match (t.name, t.closing) {
            ("model", false) => {
                model.unit_scale = match t.attr("unit").unwrap_or("millimeter") {
                    "micron" => 0.001,
                    "millimeter" => 1.0,
                    "centimeter" => 10.0,
                    "inch" => 25.4,
                    "foot" => 304.8,
                    "meter" => 1000.0,
                    other => return Err(Refused("unit", 0, 0, other.to_owned())),
                };
                for prefix in t
                    .attr("requiredextensions")
                    .unwrap_or("")
                    .split_ascii_whitespace()
                {
                    let ns = t.attr(&["xmlns:", prefix].concat()).unwrap_or(prefix);
                    if !READ_EXTENSIONS.contains(&ns) {
                        return Err(Refused("extension", 0, 0, ns.to_owned()));
                    }
                }
            }
            ("object", false) => {
                let id = id_of(&t, "id", 0)?;
                let name = t.attr("name").unwrap_or("").to_owned();
                current = Some((
                    id,
                    Object {
                        name,
                        ..Object::default()
                    },
                ));
            }
            ("object", true) => {
                if let Some((id, o)) = current.take() {
                    let n = o.positions.len();
                    if let Some(k) = o
                        .triangles
                        .iter()
                        .position(|tri| tri.iter().any(|&i| i as usize >= n))
                    {
                        return Err(Refused("index", id, k, n.to_string()));
                    }
                    model.objects.insert(id, o);
                }
            }
            ("vertex", false) => {
                if let Some((id, o)) = current.as_mut() {
                    let k = o.positions.len();
                    let f = |c: &str| {
                        let v = t.attr(c).unwrap_or("");
                        v.trim()
                            .parse::<f32>()
                            .ok()
                            .filter(|f| f.is_finite())
                            .ok_or_else(|| Refused("vertex", *id, k, v.to_owned()))
                    };
                    o.positions.push([f("x")?, f("y")?, f("z")?]);
                }
            }
            ("triangle", false) => {
                if let Some((id, o)) = current.as_mut() {
                    let k = o.triangles.len();
                    let f = |c: &str| {
                        let v = t.attr(c).unwrap_or("");
                        v.trim()
                            .parse::<u32>()
                            .map_err(|_| Refused("triangle", *id, k, v.to_owned()))
                    };
                    let (a, b, c) = (f("v1")?, f("v2")?, f("v3")?);
                    if let Some(code) = t
                        .attr("paint_color")
                        .or_else(|| t.attr("slic3rpe:mmu_segmentation"))
                        .filter(|c| !c.is_empty())
                    {
                        o.paint.push((o.triangles.len(), code.to_owned()));
                    }
                    if let Some(code) = t
                        .attr("paint_supports")
                        .or_else(|| t.attr("slic3rpe:custom_supports"))
                        .filter(|c| !c.is_empty())
                    {
                        o.support_paint.push((o.triangles.len(), code.to_owned()));
                    }
                    if let Some(code) = t
                        .attr("paint_seam")
                        .or_else(|| t.attr("slic3rpe:custom_seam"))
                        .filter(|c| !c.is_empty())
                    {
                        o.seam_paint.push((o.triangles.len(), code.to_owned()));
                    }
                    if let Some(code) = t.attr("paint_fuzzy_skin").filter(|c| !c.is_empty()) {
                        o.fuzzy_paint.push((o.triangles.len(), code.to_owned()));
                    }
                    o.triangles.push([a, b, c]);
                }
            }
            ("component", false) => {
                if let Some((owner, o)) = current.as_mut() {
                    let id = id_of(&t, "objectid", *owner)?;
                    let path = t.attr("p:path").unwrap_or("").trim_start_matches('/').to_owned();
                    let transform = parse_transform(t.attr("transform"), *owner, o.components.len())?;
                    o.components.push((id, path, transform));
                }
            }
            ("item", false) => {
                let object = id_of(&t, "objectid", 0)?;
                let printable = t.attr("printable").is_none_or(|v| v != "0");
                if printable {
                    model.build.push(BuildItem {
                        object,
                        transform: parse_transform(t.attr("transform"), 0, model.build.len())?,
                    });
                }
            }
            _ => {}
        }
    }
    Ok(model)
}

/// Filament slot per object or part id from Bambu and Orca project metadata.
fn slot_map(xml: &[u8]) -> HashMap<u32, u8> {
    let mut map = HashMap::new();
    let mut object: Option<u32> = None;
    let mut part: Option<u32> = None;
    for t in tags(xml) {
        match (t.name, t.closing) {
            ("object", false) => object = t.attr("id").and_then(|v| v.parse().ok()),
            ("object", true) => object = None,
            ("part", false) => part = t.attr("id").and_then(|v| v.parse().ok()),
            ("part", true) => part = None,
            ("metadata", false) if t.attr("key") == Some("extruder") => {
                if let Some(slot) = t.attr("value").and_then(|v| v.parse::<u8>().ok()) {
                    match (part, object) {
                        (Some(p), _) => {
                            map.insert(p, slot);
                        }
                        (None, Some(o)) => {
                            map.entry(o).or_insert(slot);
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    map
}

struct Resolve<'a> {
    zip: &'a Zip<'a>,
    models: &'a mut HashMap<String, Model>,
    parts: &'a mut Vec<MeshPart>,
    slots: &'a HashMap<u32, u8>,
    name: &'a str,
    /// What is left of [`MAX_WORK`] for the whole file, charged per build item before it is placed.
    work: &'a mut u64,
}

impl Resolve<'_> {
    /// The work placing object `id` asks for: one unit per object visited plus its vertices and triangles,
    /// summed over every copy its components place. Each object is costed once, so this is quick however
    /// many copies the file asks for.
    fn cost(
        &mut self,
        model: &Model,
        path: &str,
        id: u32,
        depth: u32,
        memo: &mut HashMap<(String, u32), u64>,
    ) -> Result<u64> {
        if depth > MAX_DEPTH {
            return Err(Error::mesh(self.name, "3MF components nest too deep"));
        }
        if let Some(&c) = memo.get(&(path.to_owned(), id)) {
            return Ok(c);
        }
        let Some(obj) = model.objects.get(&id) else {
            return Err(Error::mesh(
                self.name,
                format!("3MF object {id} is missing in {path}"),
            ));
        };
        let mut total = 1 + (obj.positions.len() + obj.triangles.len()) as u64;
        for (child, child_path, _) in &obj.components {
            let c = if child_path.is_empty() || child_path == path {
                self.cost(model, path, *child, depth + 1, memo)?
            } else {
                if !self.models.contains_key(child_path) {
                    let bytes = self.zip.read(child_path).map_err(|e| Error::mesh(self.name, e))?;
                    let m =
                        parse_model(&bytes).map_err(|e| Error::mesh(self.name, refused(child_path, e)))?;
                    self.models.insert(child_path.clone(), m);
                }
                let sub = self.models.remove(child_path).unwrap_or_default();
                let r = self.cost(&sub, child_path, *child, depth + 1, memo);
                self.models.insert(child_path.clone(), sub);
                r?
            };
            total = total.saturating_add(c);
        }
        memo.insert((path.to_owned(), id), total);
        Ok(total)
    }

    fn object(
        &mut self,
        model: &Model,
        path: &str,
        id: u32,
        t: Transform,
        top: u32,
        depth: u32,
    ) -> Result<()> {
        if depth > MAX_DEPTH {
            return Err(Error::mesh(self.name, "3MF components nest too deep"));
        }
        let Some(obj) = model.objects.get(&id) else {
            return Err(Error::mesh(
                self.name,
                format!("3MF object {id} is missing in {path}"),
            ));
        };
        if !obj.triangles.is_empty() {
            let slot = self
                .slots
                .get(&id)
                .or_else(|| self.slots.get(&top))
                .copied()
                .unwrap_or(1)
                .max(1);
            let positions: Vec<[f32; 3]> = obj.positions.iter().map(|p| apply(&t, *p)).collect();
            let n = obj.positions.len();
            // Painted pieces in place (the part's own paint is skipped when it is the part's filament).
            let paint: Vec<crate::paint::PaintFacet> = obj
                .paint
                .iter()
                .filter_map(|(k, code)| {
                    let tri = obj.triangles.get(*k)?;
                    let corners = [
                        *positions.get(tri[0] as usize)?,
                        *positions.get(tri[1] as usize)?,
                        *positions.get(tri[2] as usize)?,
                    ];
                    Some(crate::paint::decode(code, corners))
                })
                .flatten()
                .filter(|f| f.state != slot)
                .collect();
            let decode_all = |list: &[(usize, String)]| -> Vec<crate::paint::PaintFacet> {
                list.iter()
                    .filter_map(|(k, code)| {
                        let tri = obj.triangles.get(*k)?;
                        let corners = [
                            *positions.get(tri[0] as usize)?,
                            *positions.get(tri[1] as usize)?,
                            *positions.get(tri[2] as usize)?,
                        ];
                        Some(crate::paint::decode(code, corners))
                    })
                    .flatten()
                    .collect()
            };
            let seam_paint = decode_all(&obj.seam_paint);
            let fuzzy_paint = decode_all(&obj.fuzzy_paint);
            let support_paint: Vec<crate::paint::PaintFacet> = obj
                .support_paint
                .iter()
                .filter_map(|(k, code)| {
                    let tri = obj.triangles.get(*k)?;
                    let corners = [
                        *positions.get(tri[0] as usize)?,
                        *positions.get(tri[1] as usize)?,
                        *positions.get(tri[2] as usize)?,
                    ];
                    Some(crate::paint::decode(code, corners))
                })
                .flatten()
                .collect();
            let triangles: Vec<[u32; 3]> = obj
                .triangles
                .iter()
                .filter(|tri| tri.iter().all(|&i| (i as usize) < n))
                .copied()
                .collect();
            // The texts by the index each painted triangle keeps once triangles outside the vertices are dropped.
            let mut kept = Vec::with_capacity(obj.triangles.len());
            let mut next = 0u32;
            for tri in &obj.triangles {
                kept.push(tri.iter().all(|&i| (i as usize) < n).then_some(next));
                next += u32::from(kept.last().copied().flatten().is_some());
            }
            let mut paint_texts = Vec::new();
            for (layer, list) in [
                (0u8, &obj.paint),
                (1, &obj.seam_paint),
                (2, &obj.support_paint),
                (3, &obj.fuzzy_paint),
            ] {
                for (k, code) in list {
                    if let Some(Some(t)) = kept.get(*k) {
                        paint_texts.push((layer, *t, code.clone()));
                    }
                }
            }
            let name = if obj.name.is_empty() {
                format!("part {}", self.parts.len() + 1)
            } else {
                obj.name.clone()
            };
            self.parts.push(MeshPart {
                name,
                slot,
                color: None,
                positions,
                triangles,
                paint,
                support_paint,
                seam_paint,
                fuzzy_paint,
                paint_texts,
            });
        }
        for (child, child_path, ct) in &obj.components {
            let t2 = compose(ct, &t);
            if child_path.is_empty() || child_path == path {
                self.object(model, path, *child, t2, top, depth + 1)?;
            } else {
                if !self.models.contains_key(child_path) {
                    let bytes = self.zip.read(child_path).map_err(|e| Error::mesh(self.name, e))?;
                    let m =
                        parse_model(&bytes).map_err(|e| Error::mesh(self.name, refused(child_path, e)))?;
                    self.models.insert(child_path.clone(), m);
                }
                let sub = self.models.remove(child_path).unwrap_or_default();
                let r = self.object(&sub, child_path, *child, t2, top, depth + 1);
                self.models.insert(child_path.clone(), sub);
                r?;
            }
        }
        Ok(())
    }
}

/// One XML tag: name, attributes and whether it closes an element.
struct Tag<'a> {
    name: &'a str,
    attrs: &'a str,
    closing: bool,
}

impl<'a> Tag<'a> {
    fn attr(&self, key: &str) -> Option<&'a str> {
        let mut rest = self.attrs;
        loop {
            let eq = rest.find('=')?;
            let k = rest.get(..eq)?.trim();
            let after = rest.get(eq + 1..)?.trim_start();
            let quote = after.chars().next()?;
            if quote != '"' && quote != '\'' {
                return None;
            }
            let body = after.get(1..)?;
            let end = body.find(quote)?;
            if k == key {
                return body.get(..end);
            }
            rest = body.get(end + 1..)?;
        }
    }
}

/// Tags in document order. A self-closing tag is reported as an opening
/// tag followed by a closing one. Comments, declarations and text are skipped;
/// entities in attribute values are left as they are (3MF numbers and ids do
/// not use them).
fn tags(xml: &[u8]) -> impl Iterator<Item = Tag<'_>> {
    let text = std::str::from_utf8(xml).unwrap_or("");
    let mut pos = 0usize;
    let mut pending_close: Option<&str> = None;
    std::iter::from_fn(move || {
        if let Some(name) = pending_close.take() {
            return Some(Tag {
                name,
                attrs: "",
                closing: true,
            });
        }
        loop {
            let rest = text.get(pos..)?;
            let start = rest.find('<')?;
            let body = rest.get(start + 1..)?;
            let end = body.find('>')?;
            pos += start + 1 + end + 1;
            let inner = body.get(..end)?;
            if inner.starts_with('?') || inner.starts_with('!') {
                continue;
            }
            let (closing, inner) = match inner.strip_prefix('/') {
                Some(r) => (true, r),
                None => (false, inner),
            };
            let (inner, self_closing) = match inner.strip_suffix('/') {
                Some(r) => (r, true),
                None => (inner, false),
            };
            let name_end = inner
                .find(|c: char| c.is_ascii_whitespace())
                .unwrap_or(inner.len());
            let full = inner.get(..name_end)?;
            // Drop a namespace prefix (`m:vertex`), keeping `p:path` style attributes intact.
            let name = full.rsplit(':').next().unwrap_or(full);
            let attrs = inner.get(name_end..).unwrap_or("");
            if self_closing {
                pending_close = Some(name);
            }
            return Some(Tag { name, attrs, closing });
        }
    })
}

/// A read-only view of a ZIP archive.
struct Zip<'a> {
    data: &'a [u8],
    entries: Vec<Entry>,
}

struct Entry {
    name: String,
    method: u16,
    compressed: usize,
    size: usize,
    offset: usize,
}

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    b.get(at..at + 2)
        .and_then(|s| s.try_into().ok())
        .map(u16::from_le_bytes)
}

fn u64_at(b: &[u8], at: usize) -> Option<u64> {
    b.get(at..at + 8)
        .and_then(|s| s.try_into().ok())
        .map(u64::from_le_bytes)
}

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4)
        .and_then(|s| s.try_into().ok())
        .map(u32::from_le_bytes)
}

impl<'a> Zip<'a> {
    fn open(data: &'a [u8]) -> std::result::Result<Self, String> {
        let bad = || "not a ZIP archive (3MF files are ZIP)".to_owned();
        let min = data.len().checked_sub(22).ok_or_else(bad)?;
        let low = min.saturating_sub(65_535);
        let eocd = (low..=min)
            .rev()
            .find(|&i| u32_at(data, i) == Some(0x0605_4b50))
            .ok_or_else(bad)?;
        let mut count = usize::from(u16_at(data, eocd + 10).ok_or_else(bad)?);
        let mut at = u32_at(data, eocd + 16).ok_or_else(bad)? as usize;
        if at == 0xFFFF_FFFF || count == 0xFFFF {
            // ZIP64: the locator just before the end record points at a
            // 64-bit end record with the real count and offset.
            let loc = eocd.checked_sub(20).ok_or_else(bad)?;
            if u32_at(data, loc) != Some(0x0706_4b50) {
                return Err("broken ZIP64 locator".to_owned());
            }
            let rec = u64_at(data, loc + 8)
                .and_then(|v| usize::try_from(v).ok())
                .ok_or_else(bad)?;
            if u32_at(data, rec) != Some(0x0606_4b50) {
                return Err("broken ZIP64 end record".to_owned());
            }
            count = u64_at(data, rec + 32)
                .and_then(|v| usize::try_from(v).ok())
                .ok_or_else(bad)?;
            at = u64_at(data, rec + 48)
                .and_then(|v| usize::try_from(v).ok())
                .ok_or_else(bad)?;
        }
        let mut entries = Vec::with_capacity(count.min(1 << 16));
        for _ in 0..count {
            if u32_at(data, at) != Some(0x0201_4b50) {
                return Err("broken ZIP central directory".to_owned());
            }
            let method = u16_at(data, at + 10).ok_or_else(bad)?;
            let mut compressed = u32_at(data, at + 20).ok_or_else(bad)? as usize;
            let mut size = u32_at(data, at + 24).ok_or_else(bad)? as usize;
            let name_len = usize::from(u16_at(data, at + 28).ok_or_else(bad)?);
            let extra_len = usize::from(u16_at(data, at + 30).ok_or_else(bad)?);
            let comment_len = usize::from(u16_at(data, at + 32).ok_or_else(bad)?);
            let mut offset = u32_at(data, at + 42).ok_or_else(bad)? as usize;
            let name =
                String::from_utf8_lossy(data.get(at + 46..at + 46 + name_len).ok_or_else(bad)?).into_owned();
            // ZIP64 extra field: 64-bit values for the fields set to all ones, in this order.
            let extra = data
                .get(at + 46 + name_len..at + 46 + name_len + extra_len)
                .unwrap_or(&[]);
            let mut e = 0;
            while let (Some(id), Some(len)) = (u16_at(extra, e), u16_at(extra, e + 2)) {
                if id == 1 {
                    let body = extra.get(e + 4..e + 4 + usize::from(len)).unwrap_or(&[]);
                    let mut f = 0;
                    for v in [&mut size, &mut compressed, &mut offset] {
                        if *v == 0xFFFF_FFFF
                            && let Some(x) = u64_at(body, f).and_then(|x| usize::try_from(x).ok())
                        {
                            *v = x;
                            f += 8;
                        }
                    }
                }
                e += 4 + usize::from(len);
            }
            entries.push(Entry {
                name,
                method,
                compressed,
                size,
                offset,
            });
            at += 46 + name_len + extra_len + comment_len;
        }
        Ok(Self { data, entries })
    }

    fn read(&self, name: &str) -> std::result::Result<Vec<u8>, String> {
        let e = self
            .entries
            .iter()
            .find(|e| e.name == name || e.name.eq_ignore_ascii_case(name))
            .ok_or_else(|| format!("{name} is missing from the archive"))?;
        if e.size > MAX_ENTRY {
            return Err(format!("{name} is too large"));
        }
        let h = e.offset;
        if u32_at(self.data, h) != Some(0x0403_4b50) {
            return Err(format!("{name}: broken local header"));
        }
        let name_len = usize::from(u16_at(self.data, h + 26).unwrap_or(0));
        let extra_len = usize::from(u16_at(self.data, h + 28).unwrap_or(0));
        let start = h + 30 + name_len + extra_len;
        let raw = self
            .data
            .get(start..start + e.compressed)
            .ok_or_else(|| format!("{name}: truncated"))?;
        match e.method {
            0 => Ok(raw.to_vec()),
            8 => miniz_oxide::inflate::decompress_to_vec_with_limit(raw, e.size.max(1))
                .map_err(|err| format!("{name}: deflate error {:?}", err.status)),
            m => Err(format!("{name}: compression method {m} is not supported")),
        }
    }
}

#[cfg(test)]
#[allow(
    clippy::cast_possible_truncation,
    clippy::float_cmp,
    reason = "test archives are tiny; coordinates are exact small integers"
)]
mod tests {
    use super::*;

    #[test]
    fn brim_ear_points_parse_per_object() {
        let text = "brim_points_format_version=0\nobject_id=1|1.5 2.5 -0.1 6 3 4 0 5.5\nobject_id=2|bad\n";
        let ears = parse_brim_ears(text);
        assert_eq!(ears.len(), 1);
        assert_eq!(ears[0].0, 1);
        assert_eq!(ears[0].1, vec![[1.5, 2.5, -0.1, 6.0], [3.0, 4.0, 0.0, 5.5]]);
    }

    /// Builds a ZIP with the given entries, stored or deflated.
    fn zip(entries: &[(&str, &[u8], bool)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, data, deflate) in entries {
            let body = if *deflate {
                miniz_oxide::deflate::compress_to_vec(data, 6)
            } else {
                data.to_vec()
            };
            let offset = out.len() as u32;
            let method: u16 = if *deflate { 8 } else { 0 };
            out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            out.extend_from_slice(&[20, 0, 0, 0]);
            out.extend_from_slice(&method.to_le_bytes());
            out.extend_from_slice(&[0; 8]);
            out.extend_from_slice(&(body.len() as u32).to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(&body);
            central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            central.extend_from_slice(&[20, 0, 20, 0, 0, 0]);
            central.extend_from_slice(&method.to_le_bytes());
            central.extend_from_slice(&[0; 8]);
            central.extend_from_slice(&(body.len() as u32).to_le_bytes());
            central.extend_from_slice(&(data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(name.len() as u16).to_le_bytes());
            central.extend_from_slice(&[0; 12]);
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(name.as_bytes());
        }
        let cd_at = out.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(central.len() as u32).to_le_bytes());
        out.extend_from_slice(&cd_at.to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        out
    }

    const CUBE_OBJECT: &str = r#"<object id="2" name="cube" type="model"><mesh><vertices>
<vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="10" y="10" z="0"/><vertex x="0" y="10" z="0"/>
<vertex x="0" y="0" z="10"/><vertex x="10" y="0" z="10"/><vertex x="10" y="10" z="10"/><vertex x="0" y="10" z="10"/>
</vertices><triangles>
<triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="3" v3="2"/><triangle v1="4" v2="5" v3="6"/><triangle v1="4" v2="6" v3="7"/>
<triangle v1="0" v2="1" v3="5"/><triangle v1="0" v2="5" v3="4"/><triangle v1="1" v2="2" v3="6"/><triangle v1="1" v2="6" v3="5"/>
<triangle v1="2" v2="3" v3="7"/><triangle v1="2" v2="7" v3="6"/><triangle v1="3" v2="0" v3="4"/><triangle v1="3" v2="4" v3="7"/>
</triangles></mesh></object>"#;

    /// The raw parts format with a paint block: one part, slot `slot`, the cube's corners and triangles, and
    /// `(layer, triangle, text)` paint.
    fn raw_painted_cube(slot: u8, paint: &[(u8, u32, &str)]) -> Vec<u8> {
        let corners: [[f32; 3]; 8] = [
            [0., 0., 0.],
            [10., 0., 0.],
            [10., 10., 0.],
            [0., 10., 0.],
            [0., 0., 10.],
            [10., 0., 10.],
            [10., 10., 10.],
            [0., 10., 10.],
        ];
        let tris: [[u32; 3]; 12] = [
            [0, 2, 1],
            [0, 3, 2],
            [4, 5, 6],
            [4, 6, 7],
            [0, 1, 5],
            [0, 5, 4],
            [1, 2, 6],
            [1, 6, 5],
            [2, 3, 7],
            [2, 7, 6],
            [3, 0, 4],
            [3, 4, 7],
        ];
        let mut b = b"SXMP".to_vec();
        b.extend_from_slice(&1u32.to_le_bytes());
        b.push(slot);
        b.extend_from_slice(&4u16.to_le_bytes());
        b.extend_from_slice(b"cube");
        b.extend_from_slice(&8u32.to_le_bytes());
        for c in corners.iter().flatten() {
            b.extend_from_slice(&c.to_le_bytes());
        }
        b.extend_from_slice(&12u32.to_le_bytes());
        for i in tris.iter().flatten() {
            b.extend_from_slice(&i.to_le_bytes());
        }
        let layers: Vec<u8> = (0..4).filter(|l| paint.iter().any(|p| p.0 == *l)).collect();
        b.extend_from_slice(b"SXPT");
        b.extend_from_slice(&(layers.len() as u32).to_le_bytes());
        for l in layers {
            let list: Vec<_> = paint.iter().filter(|p| p.0 == l).collect();
            b.extend_from_slice(&0u32.to_le_bytes());
            b.push(l);
            b.extend_from_slice(&(list.len() as u32).to_le_bytes());
            for (_, t, text) in list {
                b.extend_from_slice(&t.to_le_bytes());
                b.extend_from_slice(&(text.len() as u16).to_le_bytes());
                b.extend_from_slice(text.as_bytes());
            }
        }
        b
    }

    #[test]
    fn raw_paint_loads_as_the_same_3mf_paint() {
        use std::fmt::Write as _;
        // Real paint texts from a painted keychain, a whole triangle in each of two filaments, and seam, support and
        // fuzzy skin paint: the painted pieces must come out the same either way, the part's own filament left out.
        let paint: &[(u8, u32, &str)] = &[
            (0, 0, "4"),
            (0, 2, "8"),
            (0, 5, "004044244640446400AA603"),
            (0, 8, "0044244244434404424464340446400A6440446400A2044244A33"),
            (1, 3, "4"),
            (2, 4, "8"),
            (2, 9, "04044244640446400AA6044244244A2"),
            (3, 6, "4"),
        ];
        let attr =
            |l: u8| ["paint_color", "paint_seam", "paint_supports", "paint_fuzzy_skin"][usize::from(l)];
        // The cube with each triangle's paint attributes, as the app's project writer puts them.
        let mut pieces = CUBE_OBJECT.split("<triangle ");
        let mut obj = pieces.next().unwrap_or_default().to_owned();
        for (i, rest) in pieces.enumerate() {
            obj.push_str("<triangle ");
            for (l, t, text) in paint {
                if *t as usize == i {
                    let _ = write!(obj, r#"{}="{text}" "#, attr(*l));
                }
            }
            obj.push_str(rest);
        }
        let model = format!(
            r#"<model unit="millimeter"><resources>{obj}</resources><build><item objectid="2"/></build></model>"#
        );
        let settings = r#"<config><object id="2"><metadata key="extruder" value="2"/></object></config>"#;
        let three = Mesh::load(
            &zip(&[
                ("3D/3dmodel.model", model.as_bytes(), true),
                ("Metadata/model_settings.config", settings.as_bytes(), false),
            ]),
            "cube.3mf",
        )
        .unwrap();
        let raw = Mesh::load(&raw_painted_cube(2, paint), "cube").unwrap();
        let (a, b) = (&three.parts[0], &raw.parts[0]);
        assert_eq!(a.slot, 2);
        assert_eq!(b.slot, 2);
        assert_eq!(a.positions, b.positions);
        assert_eq!(a.triangles, b.triangles);
        assert!(
            !b.paint.is_empty()
                && !b.seam_paint.is_empty()
                && !b.support_paint.is_empty()
                && !b.fuzzy_paint.is_empty()
        );
        assert!(
            b.paint.iter().all(|f| f.state != 2),
            "the part's own filament is left out"
        );
        assert_eq!(a.paint, b.paint);
        assert_eq!(a.seam_paint, b.seam_paint);
        assert_eq!(a.support_paint, b.support_paint);
        assert_eq!(a.fuzzy_paint, b.fuzzy_paint);
        // A paint block cut short is refused, not read as garbage.
        let bytes = raw_painted_cube(2, paint);
        assert!(Mesh::from_raw(&bytes[..bytes.len() - 3], "cube").is_err());
    }

    #[test]
    fn plain_3mf_with_transform() {
        let model = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>{CUBE_OBJECT}</resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 100 50 0"/></build></model>"#
        );
        let bytes = zip(&[("3D/3dmodel.model", model.as_bytes(), true)]);
        let mesh = Mesh::load(&bytes, "cube.3mf").unwrap();
        assert_eq!(mesh.parts.len(), 1);
        assert_eq!(mesh.triangle_count(), 12);
        let (lo, hi) = mesh.bounds().unwrap();
        assert_eq!(lo, [100.0, 50.0, 0.0]);
        assert_eq!(hi, [110.0, 60.0, 10.0]);
    }

    #[test]
    fn production_components_and_slots() {
        let sub = format!(r#"<model unit="millimeter"><resources>{CUBE_OBJECT}</resources></model>"#);
        let main = r#"<model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources>
<object id="5" type="model"><components>
<component p:path="/3D/Objects/object_1.model" objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
<component p:path="/3D/Objects/object_1.model" objectid="2" transform="1 0 0 0 1 0 0 0 1 20 0 0"/>
</components></object></resources><build><item objectid="5"/></build></model>"#;
        let rels = r#"<Relationships><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>"#;
        let settings = r#"<config><object id="5"><metadata key="extruder" value="3"/><part id="2" subtype="normal_part"><metadata key="extruder" value="2"/></part></object></config>"#;
        let bytes = zip(&[
            ("_rels/.rels", rels.as_bytes(), false),
            ("3D/3dmodel.model", main.as_bytes(), true),
            ("3D/Objects/object_1.model", sub.as_bytes(), true),
            ("Metadata/model_settings.config", settings.as_bytes(), false),
        ]);
        let mesh = Mesh::load(&bytes, "plate.3mf").unwrap();
        assert_eq!(mesh.parts.len(), 2);
        assert_eq!(mesh.parts[0].slot, 2);
        let (lo, hi) = mesh.bounds().unwrap();
        assert_eq!(lo[0], 0.0);
        assert_eq!(hi[0], 30.0);
    }

    #[test]
    fn components_that_repeat_a_mesh_without_end_are_refused() {
        use std::fmt::Write as _;
        // Each level holds the level below four times: 4^15 cubes from a file under 2 KB.
        let mut objects = CUBE_OBJECT.to_owned();
        for id in 3..18 {
            let parts = format!(
                r#"<component objectid="{}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>"#,
                id - 1
            )
            .repeat(4);
            let _ = write!(
                objects,
                r#"<object id="{id}" type="model"><components>{parts}</components></object>"#
            );
        }
        let model = format!(
            r#"<model unit="millimeter"><resources>{objects}</resources><build><item objectid="17"/></build></model>"#
        );
        let bytes = zip(&[("3D/3dmodel.model", model.as_bytes(), true)]);
        let t = std::time::Instant::now();
        let err = Mesh::load(&bytes, "bomb.3mf").unwrap_err().to_string();
        assert!(err.contains("too many"), "{err}");
        assert!(t.elapsed().as_secs() < 2);
        // Empty objects repeated the same way cost time without memory, and are refused too.
        let empty = model.replace(
            CUBE_OBJECT,
            r#"<object id="2" type="model"><mesh><vertices/><triangles/></mesh></object>"#,
        );
        let bytes = zip(&[("3D/3dmodel.model", empty.as_bytes(), true)]);
        assert!(Mesh::load(&bytes, "bomb.3mf").is_err());
        assert!(t.elapsed().as_secs() < 10);
    }

    #[test]
    fn bambu_plates() {
        let model = format!(
            r#"<model unit="millimeter"><resources>{CUBE_OBJECT}<object id="3" type="model"><components><component objectid="2" transform="1 0 0 0 1 0 0 0 1 300 0 0"/></components></object></resources><build><item objectid="2"/><item objectid="3"/></build></model>"#
        );
        let settings = r#"<config><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="2"/></model_instance></plate><plate><metadata key="plater_id" value="2"/><model_instance><metadata key="object_id" value="3"/></model_instance></plate></config>"#;
        let bytes = zip(&[
            ("3D/3dmodel.model", model.as_bytes(), true),
            ("Metadata/model_settings.config", settings.as_bytes(), false),
        ]);
        let plates = load_plates(&bytes, "p.3mf").unwrap();
        assert_eq!(plates.len(), 2);
        assert_eq!(plates[1].0, 2);
        assert_eq!(plates[1].1.bounds().unwrap().0[0], 300.0);
        assert_eq!(Mesh::load(&bytes, "p.3mf").unwrap().parts.len(), 1);
    }

    #[test]
    fn plate_objects_keep_each_build_item() {
        let model = format!(
            r#"<model unit="millimeter"><resources>{CUBE_OBJECT}<object id="3" type="model"><components><component objectid="2" transform="1 0 0 0 1 0 0 0 1 60 0 0"/></components></object></resources><build><item objectid="2"/><item objectid="3"/></build></model>"#
        );
        let settings = r#"<config><object id="3"><metadata key="name" value="right"/><part id="2"><metadata key="name" value="a part"/></part></object><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="2"/></model_instance><model_instance><metadata key="object_id" value="3"/></model_instance></plate></config>"#;
        let bytes = zip(&[
            ("3D/3dmodel.model", model.as_bytes(), true),
            ("Metadata/model_settings.config", settings.as_bytes(), false),
        ]);
        let plates = load_plate_objects(&bytes, "p.3mf").unwrap();
        assert_eq!(plates.len(), 1);
        let items = &plates[0].1;
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].name, "cube");
        assert_eq!(items[1].name, "right");
        assert_eq!(items[1].bounds().unwrap().0[0], 60.0);
        // the merged plate is still one mesh with both
        assert_eq!(load_plates(&bytes, "p.3mf").unwrap()[0].1.parts.len(), 2);
    }

    #[test]
    fn project_metadata() {
        let model = format!(
            r#"<model unit="millimeter"><resources>{CUBE_OBJECT}</resources><build><item objectid="2"/></build></model>"#
        );
        let bytes = zip(&[
            ("3D/3dmodel.model", model.as_bytes(), true),
            (
                "Metadata/project_settings.config",
                br#"{"layer_height":"0.2","nozzle_diameter":["0.4"]}"#,
                true,
            ),
            ("Metadata/model_settings.config", b"<config/>", false),
        ]);
        let m = metadata(&bytes, "p.3mf").unwrap();
        assert_eq!(m.project_settings.as_ref().unwrap()["layer_height"], "0.2");
        assert_eq!(m.model_settings.as_deref(), Some("<config/>"));
        assert!(m.layer_ranges.is_none());
        let json = serde_json::to_value(&m).unwrap();
        assert!(json.get("projectSettings").is_some() && json.get("layerRanges").is_none());
        let plain = zip(&[("3D/3dmodel.model", model.as_bytes(), true)]);
        assert_eq!(metadata(&plain, "p.3mf").unwrap(), ProjectMetadata::default());
        let bad = zip(&[("Metadata/project_settings.config", b"nope", false)]);
        assert!(metadata(&bad, "p.3mf").is_err());
        assert!(metadata(b"not a zip at all, sorry", "p.3mf").is_err());
    }

    #[test]
    fn rejects_garbage() {
        assert!(Mesh::load(b"PK\x03\x04 not really", "x.3mf").is_err());
        assert!(Mesh::load(&zip(&[("3D/3dmodel.model", b"<model/>", false)]), "x.3mf").is_err());
    }

    /// A 1 inch cube in `unit`, its side `side` long in that unit, with the top painted for filament 2 and a side
    /// painted for support: the same cube as a file in millimeters with a side of 25.4.
    fn painted_cube(unit: &str, side: f32) -> Vec<u8> {
        let v = |x: u8, y: u8, z: u8| {
            format!(
                r#"<vertex x="{}" y="{}" z="{}"/>"#,
                f32::from(x) * side,
                f32::from(y) * side,
                f32::from(z) * side
            )
        };
        let verts = [
            v(0, 0, 0),
            v(1, 0, 0),
            v(1, 1, 0),
            v(0, 1, 0),
            v(0, 0, 1),
            v(1, 0, 1),
            v(1, 1, 1),
            v(0, 1, 1),
        ]
        .concat();
        let model = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?><model unit="{unit}" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="2" name="cube" type="model"><mesh><vertices>{verts}</vertices><triangles>
<triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="3" v3="2"/><triangle v1="4" v2="5" v3="6" paint_color="8"/><triangle v1="4" v2="6" v3="7" paint_color="8"/>
<triangle v1="0" v2="1" v3="5" paint_supports="4"/><triangle v1="0" v2="5" v3="4"/><triangle v1="1" v2="2" v3="6"/><triangle v1="1" v2="6" v3="5"/>
<triangle v1="2" v2="3" v3="7"/><triangle v1="2" v2="7" v3="6"/><triangle v1="3" v2="0" v3="4"/><triangle v1="3" v2="4" v3="7"/>
</triangles></mesh></object></resources><build><item objectid="2"/></build></model>"#
        );
        zip(&[("3D/3dmodel.model", model.as_bytes(), true)])
    }

    #[test]
    fn an_inch_file_scales_its_paint_with_its_positions() {
        let inch = Mesh::load(&painted_cube("inch", 1.0), "inch.3mf").unwrap();
        let mm = Mesh::load(&painted_cube("millimeter", 25.4), "mm.3mf").unwrap();
        let (a, b) = (&inch.parts[0], &mm.parts[0]);
        let close = |p: &[f32; 3], q: &[f32; 3]| p.iter().zip(q).all(|(x, y)| (x - y).abs() < 1e-4);
        let moved = |p: &[f32; 3]| *p;
        assert_eq!(a.positions.len(), b.positions.len());
        assert!(
            a.positions
                .iter()
                .zip(&b.positions)
                .all(|(p, q)| close(&moved(p), q))
        );
        for (fa, fb) in [(&a.paint, &b.paint), (&a.support_paint, &b.support_paint)] {
            assert!(!fa.is_empty() && fa.len() == fb.len());
            for (x, y) in fa.iter().zip(fb.iter()) {
                assert_eq!(x.state, y.state);
                assert!(
                    x.v.iter().zip(&y.v).all(|(p, q)| close(&moved(p), q)),
                    "{:?} {:?}",
                    x.v,
                    y.v
                );
            }
        }
        // The top is painted at the cube's top, 25.4 mm up, not at 1.
        assert!(
            a.paint
                .iter()
                .all(|f| f.v.iter().all(|p| (p[2] - 25.4).abs() < 1e-4))
        );
    }

    #[test]
    fn an_inch_file_slices_as_its_millimeter_twin_in_one_shard_or_four() {
        // Two filaments: the painted top prints with filament 2.
        let slice = |bytes: Vec<u8>, shards: u32| {
            let mesh = std::sync::Arc::new(Mesh::load(&bytes, "cube.3mf").unwrap());
            let req: crate::api::SliceRequest = serde_json::from_value(serde_json::json!({
                "plate": {"objects": [{"mesh": "c"}]},
                "config": {"nozzle_temperature": [220, 220], "filament_diameter": [1.75, 1.75], "brim_type": "no_brim"},
                "options": {"shards": shards},
            }))
            .unwrap();
            let run = crate::api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
            String::from_utf8(run.gcode).unwrap()
        };
        let mm = slice(painted_cube("millimeter", 25.4), 1);
        assert!(
            mm.contains(
                "
T1
"
            ),
            "the painted top prints with filament 2"
        );
        assert_eq!(slice(painted_cube("inch", 1.0), 1), mm);
        assert_eq!(slice(painted_cube("inch", 1.0), 4), mm);
    }

    /// The cube file with `head` as the model tag and `edit` applied to the rest.
    fn cube_file(head: &str, edit: &dyn Fn(String) -> String) -> std::result::Result<Mesh, String> {
        let body = edit(format!(
            r#"<resources>{CUBE_OBJECT}</resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 100 50 0"/></build></model>"#
        ));
        let model = format!(r#"<?xml version="1.0" encoding="UTF-8"?>{head}{body}"#);
        Mesh::load(&zip(&[("3D/3dmodel.model", model.as_bytes(), true)]), "cube.3mf")
            .map_err(|e| e.to_string())
    }

    const CORE: &str =
        r#"<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">"#;

    #[test]
    fn a_malformed_3mf_is_refused_with_what_and_where() {
        let same = |s: String| s;
        assert_eq!(cube_file(CORE, &same).unwrap().triangle_count(), 12);
        let refused = |head: &str, edit: &dyn Fn(String) -> String, says: &str| {
            let e = cube_file(head, edit).unwrap_err();
            assert!(e.contains(says), "{e}");
        };
        refused(
            r#"<model unit="furlong">"#,
            &same,
            "3D/3dmodel.model: refused unit 0 0 furlong",
        );
        refused(
            r#"<model unit="millimeter" xmlns:b="http://schemas.microsoft.com/3dmanufacturing/beamlattice/2017/02" requiredextensions="b">"#,
            &same,
            "refused extension 0 0 http://schemas.microsoft.com/3dmanufacturing/beamlattice/2017/02",
        );
        refused(
            CORE,
            &|s| s.replacen(r#"x="10""#, r#"x="ten""#, 1),
            "refused vertex 2 1 ten",
        );
        refused(
            CORE,
            &|s| s.replacen(r#"x="10""#, r#"x="NaN""#, 1),
            "refused vertex 2 1 NaN",
        );
        refused(
            CORE,
            &|s| s.replacen(r#"v3="1""#, r#"v3="8""#, 1),
            "refused index 2 0 8",
        );
        refused(
            CORE,
            &|s| s.replacen(r#"v3="1""#, r#"v3="-1""#, 1),
            "refused triangle 2 0 -1",
        );
        refused(
            CORE,
            &|s| s.replace("1 0 0 0 1 0 0 0 1 100 50 0", "1 0 0 0 1 0 0 0 1 100 50"),
            "refused transform 0 0 1 0 0 0 1 0 0 0 1 100 50",
        );
        refused(
            CORE,
            &|s| s.replace("100 50 0", "100 fifty 0"),
            "refused transform 0 0 1 0 0 0 1 0 0 0 1 100 fifty 0",
        );
        refused(
            CORE,
            &|s| s.replace(r#"<item objectid="2""#, r#"<item objectid="two""#),
            "refused id 0 0 two",
        );
    }

    #[test]
    fn extensions_the_loader_reads_or_may_leave_out_still_load() {
        let head = r#"<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02" xmlns:b="http://schemas.microsoft.com/3dmanufacturing/beamlattice/2017/02" requiredextensions="p m">"#;
        // beam lattice is declared but not required: it is left out
        assert_eq!(cube_file(head, &|s| s).unwrap().triangle_count(), 12);
        for unit in ["micron", "millimeter", "centimeter", "inch", "foot", "meter"] {
            let head = format!(r#"<model unit="{unit}">"#);
            assert!(cube_file(&head, &|s| s).is_ok(), "{unit}");
        }
    }

    #[test]
    fn the_bench_projects_load_as_before() {
        for (file, parts) in [("x-mark-2color.3mf", 2), ("x-mark-2color-orca.3mf", 2)] {
            let bytes = std::fs::read(format!("{}/bench/models/{file}", env!("CARGO_MANIFEST_DIR"))).unwrap();
            let mesh = Mesh::load(&bytes, file).unwrap();
            assert_eq!(mesh.parts.len(), parts, "{file}");
        }
    }
}
