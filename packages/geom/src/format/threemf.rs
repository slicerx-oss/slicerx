// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! 3mf projects as plain data: objects and their parts, part types, paint, plates and settings, as bambu studio,
//! orcaslicer and prusaslicer write them. nothing here decides how a project prints.

use super::xml::{self, Tag};
use super::zip::Zip;
use crate::error::{Error, Result};
use std::collections::{HashMap, HashSet};

const MAX_DEPTH: u32 = 16;
/// one unit per object visited plus its vertices and triangles, for every copy placed
const MAX_WORK: u64 = 40_000_000;

/// rows of a 4x3 matrix applied to row vectors, as 3mf writes it
pub type Transform = [f32; 12];

pub const IDENTITY: Transform = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0];

/// extensions whose content is read here or may be left out without changing the geometry
const READ_EXTENSIONS: &[&str] = &[
    "http://schemas.microsoft.com/3dmanufacturing/production/2015/06",
    "http://schemas.microsoft.com/3dmanufacturing/material/2015/02",
    "http://schemas.bambulab.com/package/2021",
    "http://schemas.slic3r.org/3mf/2017/06",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PartKind {
    #[default]
    Normal,
    Negative,
    Modifier,
    SupportBlocker,
    SupportEnforcer,
}

/// painted triangles as the file writes them: (triangle, code)
#[derive(Debug, Clone, Default)]
pub struct Paint {
    pub color: Vec<(u32, String)>,
    pub seam: Vec<(u32, String)>,
    pub support: Vec<(u32, String)>,
    pub fuzzy: Vec<(u32, String)>,
}

impl Paint {
    fn layers_mut(&mut self) -> [&mut Vec<(u32, String)>; 4] {
        [
            &mut self.color,
            &mut self.seam,
            &mut self.support,
            &mut self.fuzzy,
        ]
    }

    pub fn is_empty(&self) -> bool {
        self.color.is_empty() && self.seam.is_empty() && self.support.is_empty() && self.fuzzy.is_empty()
    }
}

/// a `<texture2d>` of the materials extension. the image stays in the archive and is read on demand with
/// [`Texture2d::read`], so a large textured project holds no image memory until something samples it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Texture2d {
    /// the model part whose resources hold it; resource ids are unique only within one model part
    pub model: String,
    pub id: u32,
    /// the archive entry, without a leading slash
    pub path: String,
    pub content_type: String,
    /// the entry's inflated size in bytes
    pub size: u64,
    pub tilestyle_u: Option<String>,
    pub tilestyle_v: Option<String>,
    pub filter: Option<String>,
}

impl Texture2d {
    /// the image's bytes, from the archive the project was read from
    pub fn read(&self, archive: &[u8]) -> Result<Vec<u8>> {
        read_entry(archive, &self.path)
    }
}

/// a `<texture2dgroup>`: texture coordinates into one texture, which triangle corners index
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TextureGroup {
    /// the model part whose resources hold it
    pub model: String,
    pub id: u32,
    /// the id of the [`Texture2d`] in the same model part
    pub texture: u32,
    /// `(u, v)` per `<tex2coord>`, in order
    pub uvs: Vec<[f32; 2]>,
}

/// the textures of every model part the build reaches, ordered by model part, then id
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Textures {
    pub images: Vec<Texture2d>,
    pub groups: Vec<TextureGroup>,
}

impl Textures {
    pub fn is_empty(&self) -> bool {
        self.images.is_empty() && self.groups.is_empty()
    }

    pub fn group(&self, model: &str, id: u32) -> Option<&TextureGroup> {
        self.groups.iter().find(|g| g.model == model && g.id == id)
    }

    pub fn image(&self, model: &str, id: u32) -> Option<&Texture2d> {
        self.images.iter().find(|t| t.model == model && t.id == id)
    }
}

/// the property references of a part's triangles (`pid` and `p1` to `p3`): into a texture group, or into a color
/// group or base materials, which are kept as references and not read here
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PartProps {
    /// the model part whose resources the ids name
    pub model: String,
    /// the object's own `pid` and `pindex`, which a triangle without its own takes on all three corners
    pub default: Option<(u32, u32)>,
    /// `(triangle, pid, [p1, p2, p3])` for the triangles that name their own, by triangle. a missing `pid` is the
    /// object's, a missing `p1` the object's `pindex`, and a missing `p2` or `p3` is `p1`.
    pub triangles: Vec<(u32, u32, [u32; 3])>,
}

impl PartProps {
    pub fn is_empty(&self) -> bool {
        self.default.is_none() && self.triangles.is_empty()
    }

    /// the property group of one triangle and the index of each corner in it
    pub fn of(&self, triangle: u32) -> Option<(u32, [u32; 3])> {
        match self.triangles.binary_search_by_key(&triangle, |t| t.0) {
            Ok(i) => self.triangles.get(i).map(|t| (t.1, t.2)),
            Err(_) => self.default.map(|(pid, p)| (pid, [p; 3])),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Part {
    /// the mesh object's id in its model file
    pub id: u32,
    /// empty when the file names none
    pub name: String,
    /// the mesh object's own name in the model file
    pub mesh_name: String,
    /// the triangles of the mesh object this part is, when the project lists parts by range
    pub range: Option<(u32, u32)>,
    pub kind: PartKind,
    /// a type this reader does not know; the part is read as a normal one
    pub kind_text: Option<String>,
    pub slot: Option<u8>,
    /// as the file has them, before the chain and the unit
    pub positions: Vec<[f32; 3]>,
    pub triangles: Vec<[u32; 3]>,
    pub paint: Paint,
    /// property references by triangle: texture coordinates, color groups, base materials; empty when it has none
    pub props: PartProps,
    pub settings: Vec<(String, String)>,
    /// component transforms from the object down to this mesh, outermost first
    pub chain: Vec<Transform>,
    /// a component on the way names a transform, rather than leaving it out
    pub transformed: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Object {
    /// the build item's object id
    pub id: u32,
    pub name: String,
    /// the build item's transform, in the file's unit
    pub transform: Transform,
    pub printable: bool,
    pub plate: Option<u32>,
    pub slot: Option<u8>,
    pub settings: Vec<(String, String)>,
    /// `<metadata>` of the object in the model file
    pub metadata: Vec<(String, String)>,
    pub parts: Vec<Part>,
}

#[derive(Debug, Clone, Default)]
pub struct Plate {
    pub id: u32,
    pub name: String,
    /// object ids, in the file's order
    pub objects: Vec<u32>,
    /// the rest of the plate's metadata (print sequence, filament maps)
    pub settings: Vec<(String, String)>,
}

/// whose project files the archive carries
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Layout {
    #[default]
    Plain,
    /// bambu studio and orcaslicer: `Metadata/model_settings.config`
    Bambu,
    /// prusaslicer: `Metadata/Slic3r_PE_model.config`
    Prusa,
}

/// the project's own files, as text
#[derive(Debug, Clone, Default)]
pub struct Files {
    pub project_settings: Option<String>,
    pub prusa_config: Option<String>,
    pub model_settings: Option<String>,
    pub prusa_model_config: Option<String>,
    pub layer_ranges: Option<String>,
    pub custom_gcode: Option<String>,
    pub brim_ears: Option<String>,
    /// `Metadata/slicerx_*`
    pub slicerx: Vec<(String, Vec<u8>)>,
}

#[derive(Debug, Clone, Default)]
pub struct Project {
    /// one per build item, in the file's order
    pub objects: Vec<Object>,
    pub plates: Vec<Plate>,
    pub layout: Layout,
    /// millimeters per file unit
    pub unit_scale: f32,
    /// `<metadata>` of the root model (title, application, sx: marks)
    pub metadata: Vec<(String, String)>,
    /// a model part declares a document type, which a 3mf never needs
    pub doctype: bool,
    pub files: Files,
    /// the materials extension's textures; a part's [`PartProps`] indexes them
    pub textures: Textures,
    pub entries: Vec<String>,
    pub notes: Vec<String>,
}

/// `a` then `b`
pub fn compose(a: &Transform, b: &Transform) -> Transform {
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

pub fn apply(t: &Transform, p: [f32; 3]) -> [f32; 3] {
    let [a, b, c, d, e, f, g, h, i, j, k, l] = *t;
    let [x, y, z] = p;
    [
        x * a + y * d + z * g + j,
        x * b + y * e + z * h + k,
        x * c + y * f + z * i + l,
    ]
}

impl Part {
    /// positions on the build plate in millimeters: the item's transform, then the chain, as `sx` places them
    pub fn placed(&self, item: &Transform, unit_scale: f32) -> Vec<[f32; 3]> {
        let t = self.chain.iter().fold(*item, |t, ct| compose(ct, &t));
        self.positions
            .iter()
            .map(|p| apply(&t, *p).map(|c| c * unit_scale))
            .collect()
    }

    /// positions in the object's own space in millimeters
    pub fn in_object(&self, unit_scale: f32) -> Vec<[f32; 3]> {
        self.placed(&IDENTITY, unit_scale)
    }

    pub fn prints(&self) -> bool {
        self.kind == PartKind::Normal
    }
}

/// any entry of the archive
pub fn read_entry(bytes: &[u8], name: &str) -> Result<Vec<u8>> {
    Zip::open(bytes)?.read(name)
}

/// a whole 3mf project
pub fn read_3mf(bytes: &[u8]) -> Result<Project> {
    let zip = Zip::open(bytes)?;
    let root = zip
        .read("_rels/.rels")
        .ok()
        .and_then(|rels| root_part(&String::from_utf8_lossy(&rels)))
        .unwrap_or_else(|| "3D/3dmodel.model".to_owned());
    let text = |name: &str| {
        zip.has(name)
            .then(|| zip.read(name).ok())
            .flatten()
            .map(|b| String::from_utf8_lossy(&b).into_owned())
    };
    let files = Files {
        project_settings: text("Metadata/project_settings.config"),
        prusa_config: text("Metadata/Slic3r_PE.config"),
        model_settings: text("Metadata/model_settings.config"),
        prusa_model_config: text("Metadata/Slic3r_PE_model.config"),
        layer_ranges: text("Metadata/layer_config_ranges.xml"),
        custom_gcode: text("Metadata/custom_gcode_per_layer.xml"),
        brim_ears: text("Metadata/brim_ear_points.txt"),
        slicerx: zip
            .names()
            .filter(|n| n.starts_with("Metadata/slicerx_"))
            .map(str::to_owned)
            .collect::<Vec<_>>()
            .into_iter()
            .filter_map(|n| zip.read(&n).ok().map(|b| (n, b)))
            .collect(),
    };
    let (layout, meta) = if let Some(s) = &files.model_settings {
        (Layout::Bambu, bambu_meta(s))
    } else if let Some(s) = &files.prusa_model_config {
        (Layout::Prusa, prusa_meta(s))
    } else {
        (Layout::Plain, Meta::default())
    };
    let mut models: HashMap<String, Model> = HashMap::new();
    let main = load_model(&zip, &root)?;
    let unit_scale = main.unit_scale;
    let metadata = main.metadata.clone();
    let build = main.build.clone();
    models.insert(root.clone(), main);

    // every mesh each item places
    let mut work = MAX_WORK;
    let mut memo = HashMap::new();
    let mut placed: Vec<Vec<Leaf>> = Vec::with_capacity(build.len());
    for item in &build {
        let cost = cost(&zip, &mut models, &root, item.object, 0, &mut memo)?;
        work = work.checked_sub(cost).ok_or_else(|| {
            Error::invalid("3mf", "3MF components repeat their meshes too many times to load")
        })?;
        let mut leaves = Vec::new();
        leaves_of(
            &models,
            &root,
            item.object,
            &mut Vec::new(),
            false,
            0,
            &mut leaves,
        )?;
        placed.push(leaves);
    }
    let mut notes = Vec::new();
    let doctype = models.values().any(|m| m.doctype);
    let mut paths: Vec<String> = models.keys().cloned().collect();
    paths.sort();
    let mut textures = Textures::default();
    // per model part: property ids dropped, and those of other property resources
    let mut refs: HashMap<String, (Vec<u32>, Vec<u32>)> = HashMap::new();
    for path in &paths {
        if let Some(m) = models.get_mut(path) {
            textures.images.append(&mut m.images);
            textures.groups.append(&mut m.groups);
            notes.append(&mut m.notes);
            refs.insert(
                path.clone(),
                (std::mem::take(&mut m.dropped), std::mem::take(&mut m.other_props)),
            );
        }
    }
    let mut objects = objects_of(&build, placed, &mut models, &root, &meta, &mut notes);
    let named = Named::of(&textures, &refs);
    for part in objects.iter_mut().flat_map(|o| o.parts.iter_mut()) {
        settle_props(part, &named, &mut notes);
    }
    Ok(Project {
        objects,
        plates: meta.plates,
        layout,
        unit_scale,
        metadata,
        doctype,
        files,
        textures,
        entries: zip.names().map(str::to_owned).collect(),
        notes,
    })
}

/// what a part's property references may name, per model part: each texture group's coordinate count, and the
/// other property resources that are kept
#[derive(Default)]
struct Named {
    groups: HashMap<(String, u32), usize>,
    other: HashSet<(String, u32)>,
}

impl Named {
    fn of(textures: &Textures, refs: &HashMap<String, (Vec<u32>, Vec<u32>)>) -> Self {
        let groups = textures
            .groups
            .iter()
            .map(|g| ((g.model.clone(), g.id), g.uvs.len()))
            .collect();
        let other = refs
            .iter()
            .flat_map(|(model, (dropped, other))| {
                other
                    .iter()
                    .filter(|id| !dropped.contains(id))
                    .map(|&id| (model.clone(), id))
            })
            .collect();
        Self { groups, other }
    }
}

/// a part's property references that name a dropped resource, no resource, or a coordinate past their texture
/// group are left out, with one note per part
fn settle_props(part: &mut Part, named: &Named, notes: &mut Vec<String>) {
    if part.props.is_empty() {
        return;
    }
    // one lookup per property group the part names, not per triangle
    let mut seen: HashMap<u32, Option<usize>> = HashMap::new();
    let model = part.props.model.clone();
    let mut len = |pid: u32| {
        *seen.entry(pid).or_insert_with(|| {
            let key = (model.clone(), pid);
            match named.groups.get(&key) {
                Some(&n) => Some(n),
                None => named.other.contains(&key).then_some(usize::MAX),
            }
        })
    };
    let mut ok = |pid: u32, p: &[u32]| len(pid).is_some_and(|n| p.iter().all(|&i| (i as usize) < n));
    let mut left = 0usize;
    if let Some((pid, i)) = part.props.default
        && !ok(pid, &[i])
    {
        part.props.default = None;
        left += 1;
    }
    let before = part.props.triangles.len();
    part.props.triangles.retain(|&(_, pid, p)| ok(pid, &p));
    left += before - part.props.triangles.len();
    if left > 0 {
        notes.push(format!(
            "{}: {left} property references name a resource that is missing, left out, or too short; left out",
            part.name
        ));
    }
}

/// each build item with its parts; a mesh placed once moves into its part, one placed more often is copied
fn objects_of(
    build: &[Item],
    placed: Vec<Vec<Leaf>>,
    models: &mut HashMap<String, Model>,
    root: &str,
    meta: &Meta,
    notes: &mut Vec<String>,
) -> Vec<Object> {
    let mut uses: HashMap<(String, u32), usize> = HashMap::new();
    for l in placed.iter().flatten() {
        *uses.entry((l.path.clone(), l.id)).or_default() += 1;
    }
    let mut objects = Vec::with_capacity(build.len());
    for (item, leaves) in build.iter().zip(placed) {
        let own = meta.objects.get(&item.object);
        let (model_name, model_meta) = models
            .get(root)
            .and_then(|m| m.objects.get(&item.object))
            .map(|o| (o.name.clone(), o.metadata.clone()))
            .unwrap_or_default();
        let mut parts = Vec::new();
        for leaf in leaves {
            let left = uses.get_mut(&(leaf.path.clone(), leaf.id));
            let last = left.as_deref().is_some_and(|n| *n <= 1);
            if let Some(n) = left {
                *n = n.saturating_sub(1);
            }
            let Some(mesh) = models
                .get_mut(&leaf.path)
                .and_then(|m| m.objects.get_mut(&leaf.id))
            else {
                continue;
            };
            // a part list by triangle ranges: prusaslicer's, or an older bambu project's
            let ranges = own
                .map(|o| &o.ranges)
                .filter(|r| !r.is_empty() && leaf.chain.is_empty() && leaf.id == item.object)
                .or_else(|| {
                    meta.objects
                        .get(&leaf.id)
                        .map(|o| &o.ranges)
                        .filter(|r| !r.is_empty())
                });
            if let Some(ranges) = ranges {
                for info in ranges {
                    let Some((first, last)) = info.range else { continue };
                    let mut part = mesh.range(first, last);
                    if part.triangles.is_empty() {
                        continue;
                    }
                    part.id = leaf.id;
                    part.range = Some((first, last));
                    part.chain.clone_from(&leaf.chain);
                    part.transformed = leaf.transformed;
                    part.props.model.clone_from(&leaf.path);
                    info.fill(&mut part, notes);
                    parts.push(part);
                }
                continue;
            }
            let mut part = if last { mesh.take() } else { mesh.copy() };
            part.id = leaf.id;
            part.chain = leaf.chain;
            part.transformed = leaf.transformed;
            part.props.model = leaf.path;
            if let Some(info) = own.and_then(|o| o.parts.get(&leaf.id)) {
                info.fill(&mut part, notes);
            }
            parts.push(part);
        }
        let plate = meta
            .plates
            .iter()
            .find(|p| p.objects.contains(&item.object))
            .map(|p| p.id);
        objects.push(Object {
            id: item.object,
            name: own
                .map(|o| o.name.clone())
                .filter(|n| !n.is_empty())
                .unwrap_or(model_name),
            transform: item.transform,
            printable: item.printable,
            plate,
            slot: own.and_then(|o| o.slot),
            settings: own.map(|o| o.settings.clone()).unwrap_or_default(),
            metadata: model_meta,
            parts,
        });
    }
    objects
}

fn root_part(rels: &str) -> Option<String> {
    let mut found = None;
    let _ = xml::scan(rels, |t: Tag<'_>| -> std::result::Result<(), ()> {
        if found.is_none()
            && t.opens()
            && t.name == "Relationship"
            && t.attr("Type").is_some_and(|ty| ty.ends_with("/3dmodel"))
        {
            found = t.attr("Target").map(|s| s.trim_start_matches('/').to_owned());
        }
        Ok(())
    });
    found
}

#[derive(Debug, Default)]
struct MeshObject {
    name: String,
    positions: Vec<[f32; 3]>,
    triangles: Vec<[u32; 3]>,
    paint: Paint,
    /// property references; `model` is filled in when the object becomes a part
    props: PartProps,
    /// triangles whose property references did not read, dropped with one note
    bad_props: usize,
    /// (object id, model path, transform); an empty path is this model
    components: Vec<(u32, String, Transform, bool)>,
    metadata: Vec<(String, String)>,
}

impl MeshObject {
    fn take(&mut self) -> Part {
        Part {
            name: self.name.clone(),
            mesh_name: self.name.clone(),
            positions: std::mem::take(&mut self.positions),
            triangles: std::mem::take(&mut self.triangles),
            paint: std::mem::take(&mut self.paint),
            props: std::mem::take(&mut self.props),
            ..Part::default()
        }
    }

    fn copy(&self) -> Part {
        Part {
            name: self.name.clone(),
            mesh_name: self.name.clone(),
            positions: self.positions.clone(),
            triangles: self.triangles.clone(),
            paint: self.paint.clone(),
            props: self.props.clone(),
            ..Part::default()
        }
    }

    /// triangles `first..=last` with only the vertices they use, and their paint
    fn range(&self, first: u32, last: u32) -> Part {
        let picked = self
            .triangles
            .get(first as usize..=(last as usize).min(self.triangles.len().saturating_sub(1)))
            .unwrap_or_default();
        let mut index: HashMap<u32, u32> = HashMap::new();
        let mut positions = Vec::new();
        let mut triangles = Vec::with_capacity(picked.len());
        for tri in picked {
            let mut out = [0u32; 3];
            for (o, &i) in out.iter_mut().zip(tri) {
                *o = *index.entry(i).or_insert_with(|| {
                    positions.push(self.positions.get(i as usize).copied().unwrap_or_default());
                    u32::try_from(positions.len() - 1).unwrap_or(u32::MAX)
                });
            }
            triangles.push(out);
        }
        let mut paint = self.paint.clone();
        for layer in paint.layers_mut() {
            layer.retain(|(k, _)| (first..=last).contains(k));
            for (k, _) in layer.iter_mut() {
                *k -= first;
            }
        }
        let props = PartProps {
            model: String::new(),
            default: self.props.default,
            triangles: self
                .props
                .triangles
                .iter()
                .filter(|t| (first..=last).contains(&t.0))
                .map(|&(k, pid, p)| (k - first, pid, p))
                .collect(),
        };
        Part {
            name: self.name.clone(),
            mesh_name: self.name.clone(),
            positions,
            triangles,
            paint,
            props,
            ..Part::default()
        }
    }
}

#[derive(Debug, Default)]
struct Model {
    objects: HashMap<u32, MeshObject>,
    build: Vec<Item>,
    unit_scale: f32,
    metadata: Vec<(String, String)>,
    doctype: bool,
    /// texture2d resources, `model` and `size` not yet filled in
    images: Vec<Texture2d>,
    groups: Vec<TextureGroup>,
    /// ids of the other property resources (color groups, base materials, composites, multiproperties)
    other_props: Vec<u32>,
    /// ids of property resources dropped because they did not read
    dropped: Vec<u32>,
    notes: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
struct Item {
    object: u32,
    transform: Transform,
    printable: bool,
}

/// why a model file is refused: code, object (0 for the file), element, value. the same text `sx` gives.
struct Refused(&'static str, u32, usize, String);

fn refused(path: &str, r: Refused) -> Error {
    let Refused(code, object, at, value) = r;
    Error::invalid("3mf", format!("{path}: refused {code} {object} {at} {value}"))
}

fn transform(s: Option<&str>, owner: u32, at: usize) -> std::result::Result<Transform, Refused> {
    let Some(s) = s else { return Ok(IDENTITY) };
    let mut t = IDENTITY;
    let mut n = 0;
    for v in s.split_ascii_whitespace() {
        let x = v
            .parse::<f32>()
            .ok()
            .filter(|f| f.is_finite())
            .ok_or_else(|| Refused("transform", owner, at, s.to_owned()))?;
        match t.get_mut(n) {
            Some(slot) => *slot = x,
            None => return Err(Refused("transform", owner, at, s.to_owned())),
        }
        n += 1;
    }
    if n == 12 {
        Ok(t)
    } else {
        Err(Refused("transform", owner, at, s.to_owned()))
    }
}

/// reads a model part as it inflates
fn load_model(zip: &Zip<'_>, path: &str) -> Result<Model> {
    let mut p = ModelParser {
        model: Model {
            unit_scale: 1.0,
            ..Model::default()
        },
        current: None,
        meta_name: None,
        group: None,
    };
    let mut buf: Vec<u8> = Vec::new();
    let mut head = true;
    // the whole tags of a piece; returns how much of it they cover
    let run = |p: &mut ModelParser, region: &[u8]| -> Result<usize> {
        let s =
            std::str::from_utf8(region).map_err(|_| Error::invalid("3mf", format!("{path} is not UTF-8")))?;
        xml::scan(s, |t| p.tag(&t)).map_err(|r| refused(path, r))
    };
    zip.stream(path, |chunk| {
        if head {
            // a doctype sits in the prolog, before the first element
            head = false;
            p.model.doctype = chunk.windows(9).any(|w| w == b"<!DOCTYPE");
        }
        let mut piece = chunk;
        if !buf.is_empty() {
            // finish the tag the last piece cut off, then read this one where it is, without a copy
            let Some(gt) = piece.iter().position(|&b| b == b'>') else {
                buf.extend_from_slice(piece);
                return Ok(());
            };
            buf.extend_from_slice(piece.get(..=gt).unwrap_or_default());
            piece = piece.get(gt + 1..).unwrap_or_default();
            let used = run(&mut p, &buf)?;
            if used < buf.len() {
                // a comment holding a '>': keep it all together
                buf.drain(..used);
                buf.extend_from_slice(piece);
                return Ok(());
            }
            buf.clear();
        }
        let Some(end) = piece.iter().rposition(|&b| b == b'>') else {
            buf.extend_from_slice(piece);
            return Ok(());
        };
        let used = run(&mut p, piece.get(..=end).unwrap_or_default())?;
        buf.extend_from_slice(piece.get(used..).unwrap_or_default());
        Ok(())
    })?;
    if !buf.is_empty() && buf.contains(&b'>') {
        let used = run(&mut p, &buf)?;
        buf.drain(..used);
    }
    if let Some((id, o)) = p.current.take() {
        p.model.objects.insert(id, o);
    }
    if let Some((g, _)) = p.group.take() {
        p.model.dropped.push(g.id);
        p.model
            .notes
            .push(format!("texture group {} is not closed; left out", g.id));
    }
    let mut m = p.model;
    settle_textures(zip, path, &mut m);
    Ok(m)
}

/// textures whose image is in the archive, and groups whose texture is kept; the rest dropped with a note
fn settle_textures(zip: &Zip<'_>, path: &str, m: &mut Model) {
    let mut images = Vec::with_capacity(m.images.len());
    for mut t in std::mem::take(&mut m.images) {
        if let Some(size) = zip.size(&t.path) {
            path.clone_into(&mut t.model);
            t.size = size as u64;
            images.push(t);
        } else {
            m.notes.push(format!(
                "texture {} names {}, which the archive lacks; left out",
                t.id, t.path
            ));
            m.dropped.push(t.id);
        }
    }
    let mut groups = Vec::with_capacity(m.groups.len());
    for mut g in std::mem::take(&mut m.groups) {
        if images.iter().any(|t| t.id == g.texture) {
            path.clone_into(&mut g.model);
            groups.push(g);
        } else {
            m.notes.push(format!(
                "texture group {} uses texture {}, which is missing or left out; left out",
                g.id, g.texture
            ));
            m.dropped.push(g.id);
        }
    }
    images.sort_by_key(|t| t.id);
    groups.sort_by_key(|g| g.id);
    m.images = images;
    m.groups = groups;
    for n in &mut m.notes {
        *n = format!("{path}: {n}");
    }
}

struct ModelParser {
    model: Model,
    current: Option<(u32, MeshObject)>,
    /// the name of an open `<metadata>`
    meta_name: Option<String>,
    /// an open `<texture2dgroup>`, and whether a coordinate in it failed to read
    group: Option<(TextureGroup, bool)>,
}

/// what a triangle's attribute is
#[derive(Clone, Copy)]
enum Attr {
    /// `v1` to `v3`
    Corner(usize),
    /// a paint layer and the rank of the name that wrote it
    Paint(usize, u8),
    /// `pid`, then `p1` to `p3`
    Prop(usize),
}

/// a property index or id as the file writes it; `None` when absent, `Err` when it does not read
fn prop(v: Option<&str>) -> std::result::Result<Option<u32>, ()> {
    v.map(|v| xml::u32_of(v).ok_or(())).transpose()
}

/// a triangle's `pid` and corner indices with the object's defaults; `None` when one does not read or none is
/// given where the spec needs one
fn resolve_props(props: [Option<&str>; 4], default: Option<(u32, u32)>) -> Option<(u32, [u32; 3])> {
    let [pid, p1, p2, p3] = props.map(prop);
    let pid = pid.ok()?.or(default.map(|d| d.0))?;
    let p1 = p1.ok()?.or(default.map(|d| d.1))?;
    Some((pid, [p1, p2.ok()?.unwrap_or(p1), p3.ok()?.unwrap_or(p1)]))
}

fn id_of(t: &Tag<'_>, key: &str, owner: u32) -> std::result::Result<u32, Refused> {
    let v = t.attr(key).unwrap_or("");
    v.trim()
        .parse()
        .map_err(|_| Refused("id", owner, 0, v.to_owned()))
}

impl ModelParser {
    fn vertex(&mut self, t: &Tag<'_>) -> std::result::Result<(), Refused> {
        if let Some((id, o)) = self.current.as_mut() {
            let k = o.positions.len();
            let mut p = [f32::NAN; 3];
            for (key, v) in xml::attrs(t.attrs) {
                let c = match key {
                    "x" => 0,
                    "y" => 1,
                    "z" => 2,
                    _ => continue,
                };
                let f = xml::f32_of(v)
                    .filter(|f| f.is_finite())
                    .ok_or_else(|| Refused("vertex", *id, k, v.to_owned()))?;
                if let Some(slot) = p.get_mut(c) {
                    *slot = f;
                }
            }
            if p.iter().any(|c| c.is_nan()) {
                return Err(Refused("vertex", *id, k, String::new()));
            }
            o.positions.push(p);
        }
        Ok(())
    }

    fn triangle(&mut self, t: &Tag<'_>) -> std::result::Result<(), Refused> {
        if let Some((id, o)) = self.current.as_mut() {
            let k = o.triangles.len();
            let mut v = [None; 3];
            // paint by layer, the first name of each pair preferred
            let mut paint: [(u8, &str); 4] = [(0, ""); 4];
            // pid, p1, p2, p3 as written
            let mut refs: [Option<&str>; 4] = [None; 4];
            let mut has_refs = false;
            // one match per attribute: this loop runs for every attribute of every triangle
            for (key, val) in xml::attrs(t.attrs) {
                // the two-byte keys by their bytes first: corners are most of what a triangle holds
                let attr = match key.as_bytes() {
                    [b'v', c @ b'1'..=b'3'] => Attr::Corner(usize::from(c - b'1')),
                    [b'p', c @ b'1'..=b'3'] => Attr::Prop(usize::from(c - b'0')),
                    b"pid" => Attr::Prop(0),
                    b"paint_color" => Attr::Paint(0, 2),
                    b"slic3rpe:mmu_segmentation" => Attr::Paint(0, 1),
                    b"paint_seam" => Attr::Paint(1, 2),
                    b"slic3rpe:custom_seam" => Attr::Paint(1, 1),
                    b"paint_supports" => Attr::Paint(2, 2),
                    b"slic3rpe:custom_supports" => Attr::Paint(2, 1),
                    b"paint_fuzzy_skin" => Attr::Paint(3, 2),
                    _ => continue,
                };
                match attr {
                    Attr::Corner(s) => {
                        let i =
                            xml::u32_of(val).ok_or_else(|| Refused("triangle", *id, k, val.to_owned()))?;
                        if let Some(c) = v.get_mut(s) {
                            *c = Some(i);
                        }
                    }
                    Attr::Paint(layer, rank) => {
                        if let Some(p) = paint.get_mut(layer)
                            && !val.is_empty()
                            && rank > p.0
                        {
                            *p = (rank, val);
                        }
                    }
                    Attr::Prop(i) => {
                        has_refs = true;
                        if let Some(slot) = refs.get_mut(i) {
                            *slot = Some(val);
                        }
                    }
                }
            }
            let corner = |c: Option<u32>| c.ok_or_else(|| Refused("triangle", *id, k, String::new()));
            let tri = [corner(v[0])?, corner(v[1])?, corner(v[2])?];
            let at = u32::try_from(k).unwrap_or(u32::MAX);
            for (layer, (rank, code)) in o.paint.layers_mut().into_iter().zip(paint) {
                if rank > 0 {
                    layer.push((at, code.to_owned()));
                }
            }
            if has_refs {
                match resolve_props(refs, o.props.default) {
                    Some((pid, p)) => o.props.triangles.push((at, pid, p)),
                    None => o.bad_props += 1,
                }
            }
            o.triangles.push(tri);
        }
        Ok(())
    }

    /// a `<texture2d>`; one that does not read is left out with a note
    fn texture(&mut self, t: &Tag<'_>) {
        let id = prop(t.attr("id"));
        let path = t
            .attr("path")
            .map(|p| xml::unescape(p).trim_start_matches('/').to_owned());
        match (id, path) {
            (Ok(Some(id)), Some(path)) if !path.is_empty() => self.model.images.push(Texture2d {
                id,
                path,
                content_type: xml::unescape(t.attr("contenttype").unwrap_or("")),
                tilestyle_u: t.attr("tilestyleu").map(xml::unescape),
                tilestyle_v: t.attr("tilestylev").map(xml::unescape),
                filter: t.attr("filter").map(xml::unescape),
                ..Texture2d::default()
            }),
            (id, _) => {
                let id = id.ok().flatten();
                self.model.notes.push(format!(
                    "texture {} has no id or path that reads; left out",
                    id.map_or_else(|| "?".to_owned(), |i| i.to_string())
                ));
                if let Some(id) = id {
                    self.model.dropped.push(id);
                }
            }
        }
    }

    /// an `<object>` opening or closing, with its default property
    fn object(&mut self, t: &Tag<'_>) -> std::result::Result<(), Refused> {
        if t.opens() {
            let id = id_of(t, "id", 0)?;
            let mut o = MeshObject {
                name: xml::unescape(t.attr("name").unwrap_or("")),
                ..MeshObject::default()
            };
            match (prop(t.attr("pid")), prop(t.attr("pindex"))) {
                (Ok(None), Ok(None)) => {}
                (Ok(Some(pid)), Ok(Some(pindex))) => o.props.default = Some((pid, pindex)),
                _ => self.model.notes.push(format!(
                    "object {id}: its pid or pindex does not read; its default property left out"
                )),
            }
            self.current = Some((id, o));
        }
        if t.closes()
            && let Some((id, o)) = self.current.take()
        {
            let n = o.positions.len();
            if let Some(k) = o
                .triangles
                .iter()
                .position(|tri| tri.iter().any(|&i| i as usize >= n))
            {
                return Err(Refused("index", id, k, n.to_string()));
            }
            if o.bad_props > 0 {
                self.model.notes.push(format!(
                    "object {id}: {} triangles name properties that do not read; left out",
                    o.bad_props
                ));
            }
            self.model.objects.insert(id, o);
        }
        Ok(())
    }

    /// a `<texture2dgroup>` opening or closing; one that does not read is left out with a note
    fn texture_group(&mut self, t: &Tag<'_>) {
        if t.opens() {
            let (id, texture) = (prop(t.attr("id")), prop(t.attr("texid")));
            let ok = matches!((id, texture), (Ok(Some(_)), Ok(Some(_))));
            let group = TextureGroup {
                id: id.ok().flatten().unwrap_or(u32::MAX),
                texture: texture.ok().flatten().unwrap_or(u32::MAX),
                ..TextureGroup::default()
            };
            self.group = Some((group, !ok));
        }
        if t.closes()
            && let Some((g, broken)) = self.group.take()
        {
            if broken {
                self.model.notes.push(format!(
                    "texture group {} has an id, texture or coordinate that does not read; left out",
                    g.id
                ));
                self.model.dropped.push(g.id);
            } else {
                self.model.groups.push(g);
            }
        }
    }

    /// a `<tex2coord>` of the open texture group
    fn tex2coord(&mut self, t: &Tag<'_>) {
        if let Some((g, broken)) = self.group.as_mut() {
            let uv = |key| t.attr(key).and_then(xml::f32_of).filter(|f| f.is_finite());
            match (uv("u"), uv("v")) {
                (Some(u), Some(v)) => g.uvs.push([u, v]),
                _ => *broken = true,
            }
        }
    }

    fn tag(&mut self, t: &Tag<'_>) -> std::result::Result<(), Refused> {
        match t.name {
            "vertex" if t.opens() => self.vertex(t)?,
            "triangle" if t.opens() => self.triangle(t)?,
            "object" => self.object(t)?,
            "component" if t.opens() => {
                if let Some((owner, o)) = self.current.as_mut() {
                    let id = id_of(t, "objectid", *owner)?;
                    let path = t.attr("p:path").unwrap_or("").trim_start_matches('/').to_owned();
                    let tr = transform(t.attr("transform"), *owner, o.components.len())?;
                    o.components.push((id, path, tr, t.attr("transform").is_some()));
                }
            }
            "texture2d" if t.opens() => self.texture(t),
            "texture2dgroup" => self.texture_group(t),
            "tex2coord" if t.opens() => self.tex2coord(t),
            "colorgroup" | "basematerials" | "compositematerials" | "multiproperties" if t.opens() => {
                if let Ok(Some(id)) = prop(t.attr("id")) {
                    self.model.other_props.push(id);
                }
            }
            "item" if t.opens() => {
                let object = id_of(t, "objectid", 0)?;
                let at = self.model.build.len();
                self.model.build.push(Item {
                    object,
                    transform: transform(t.attr("transform"), 0, at)?,
                    printable: t.attr("printable").is_none_or(|v| v.trim() != "0"),
                });
            }
            "metadata" => {
                if t.kind == xml::Kind::Open {
                    self.meta_name = t.attr("name").map(xml::unescape);
                } else if let Some(name) = self
                    .meta_name
                    .take()
                    .or_else(|| t.attr("name").map(xml::unescape))
                {
                    let value = if t.kind == xml::Kind::Close {
                        xml::unescape(t.text.trim())
                    } else {
                        String::new()
                    };
                    match self.current.as_mut() {
                        Some((_, o)) => o.metadata.push((name, value)),
                        None => self.model.metadata.push((name, value)),
                    }
                }
            }
            "model" if t.opens() => {
                self.model.unit_scale = match t.attr("unit").unwrap_or("millimeter") {
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
            _ => {}
        }
        Ok(())
    }
}

/// a mesh an item places: its model, object id and the components on the way, outermost first
struct Leaf {
    path: String,
    id: u32,
    chain: Vec<Transform>,
    transformed: bool,
}

fn model_of(zip: &Zip<'_>, models: &mut HashMap<String, Model>, path: &str) -> Result<()> {
    if !models.contains_key(path) {
        let m = load_model(zip, path)?;
        models.insert(path.to_owned(), m);
    }
    Ok(())
}

fn cost(
    zip: &Zip<'_>,
    models: &mut HashMap<String, Model>,
    path: &str,
    id: u32,
    depth: u32,
    memo: &mut HashMap<(String, u32), u64>,
) -> Result<u64> {
    if depth > MAX_DEPTH {
        return Err(Error::invalid("3mf", "3MF components nest too deep"));
    }
    if let Some(&c) = memo.get(&(path.to_owned(), id)) {
        return Ok(c);
    }
    model_of(zip, models, path)?;
    let (own, children) = {
        let obj = models
            .get(path)
            .and_then(|m| m.objects.get(&id))
            .ok_or_else(|| Error::invalid("3mf", format!("3MF object {id} is missing in {path}")))?;
        let children: Vec<(u32, String)> = obj
            .components
            .iter()
            .map(|(c, p, _, _)| (*c, if p.is_empty() { path.to_owned() } else { p.clone() }))
            .collect();
        (1 + (obj.positions.len() + obj.triangles.len()) as u64, children)
    };
    let mut total = own;
    for (child, child_path) in children {
        total = total.saturating_add(cost(zip, models, &child_path, child, depth + 1, memo)?);
    }
    memo.insert((path.to_owned(), id), total);
    Ok(total)
}

fn leaves_of(
    models: &HashMap<String, Model>,
    path: &str,
    id: u32,
    chain: &mut Vec<Transform>,
    transformed: bool,
    depth: u32,
    out: &mut Vec<Leaf>,
) -> Result<()> {
    if depth > MAX_DEPTH {
        return Err(Error::invalid("3mf", "3MF components nest too deep"));
    }
    let obj = models
        .get(path)
        .and_then(|m| m.objects.get(&id))
        .ok_or_else(|| Error::invalid("3mf", format!("3MF object {id} is missing in {path}")))?;
    if !obj.triangles.is_empty() {
        out.push(Leaf {
            path: path.to_owned(),
            id,
            chain: chain.clone(),
            transformed,
        });
    }
    for (child, child_path, t, set) in &obj.components {
        chain.push(*t);
        let p = if child_path.is_empty() {
            path
        } else {
            child_path.as_str()
        };
        leaves_of(models, p, *child, chain, transformed || *set, depth + 1, out)?;
        chain.pop();
    }
    Ok(())
}

/// what a project's settings file says about one part
#[derive(Debug, Clone, Default)]
struct PartInfo {
    kind: PartKind,
    kind_text: Option<String>,
    name: Option<String>,
    slot: Option<u8>,
    settings: Vec<(String, String)>,
    range: Option<(u32, u32)>,
}

impl PartInfo {
    fn set_kind(&mut self, text: &str) {
        let kind = match text {
            "" | "normal_part" | "ModelPart" => Some(PartKind::Normal),
            "negative_part" | "NegativeVolume" => Some(PartKind::Negative),
            "modifier_part" | "ParameterModifier" => Some(PartKind::Modifier),
            "support_blocker" | "SupportBlocker" => Some(PartKind::SupportBlocker),
            "support_enforcer" | "SupportEnforcer" => Some(PartKind::SupportEnforcer),
            _ => None,
        };
        self.kind = kind.unwrap_or_default();
        self.kind_text = kind.is_none().then(|| text.to_owned());
    }

    fn fill(&self, part: &mut Part, notes: &mut Vec<String>) {
        part.kind = self.kind;
        part.kind_text.clone_from(&self.kind_text);
        if let Some(n) = self.name.as_ref().filter(|n| !n.is_empty()) {
            part.name.clone_from(n);
        }
        part.slot = self.slot.or(part.slot);
        part.settings.clone_from(&self.settings);
        if let Some(t) = &self.kind_text {
            let line = format!(
                "{}: part type {t} is not one this reader knows; read as a normal part",
                part.name
            );
            if !notes.contains(&line) {
                notes.push(line);
            }
        }
    }
}

#[derive(Debug, Default)]
struct ObjectInfo {
    name: String,
    slot: Option<u8>,
    settings: Vec<(String, String)>,
    /// parts by mesh object id
    parts: HashMap<u32, PartInfo>,
    /// parts as triangle ranges of the object's own mesh, in file order
    ranges: Vec<PartInfo>,
}

#[derive(Debug, Default)]
struct Meta {
    objects: HashMap<u32, ObjectInfo>,
    plates: Vec<Plate>,
}

/// part metadata that describes the part rather than how it prints
const PART_KEYS: &[&str] = &[
    "name",
    "matrix",
    "mesh_shared",
    "extruder",
    "volume_type",
    "part_type",
    "source_file",
    "source_object_id",
    "source_volume_id",
    "source_offset_x",
    "source_offset_y",
    "source_offset_z",
    "source_in_inches",
    "source_in_meters",
];

const OBJECT_KEYS: &[&str] = &["name", "extruder", "module"];

/// the same for prusaslicer's volumes and objects
const PRUSA_KEYS: &[&str] = &[
    "name",
    "volume_type",
    "modifier",
    "matrix",
    "extruder",
    "source_file",
    "source_object_id",
    "source_volume_id",
    "source_offset_x",
    "source_offset_y",
    "source_offset_z",
    "source_in_inches",
    "source_in_meters",
    "mesh_stat",
    "text_configuration",
    "shape_configuration",
    "svg",
    "cut_id",
    "cut_info",
];

fn slot(v: &str) -> Option<u8> {
    v.trim().parse::<u8>().ok().filter(|s| *s > 0)
}

/// bambu studio and orcaslicer: `<object>` with `<metadata>` and `<part id subtype>` (or an older project's
/// `<volume firstid lastid>`), and `<plate>` with its `<model_instance>`s
fn bambu_meta(text: &str) -> Meta {
    let mut out = Meta::default();
    let mut object: Option<u32> = None;
    let mut part: Option<(Option<u32>, PartInfo)> = None;
    let mut plate: Option<Plate> = None;
    let mut instance = false;
    let _ = xml::scan(text, |t: Tag<'_>| -> std::result::Result<(), ()> {
        match t.name {
            "object" if plate.is_none() => {
                if t.opens() {
                    object = t.attr("id").and_then(|v| v.trim().parse().ok());
                    if let Some(o) = object {
                        out.objects.entry(o).or_default();
                    }
                }
                if t.closes() {
                    object = None;
                }
            }
            "part" | "volume" if object.is_some() => {
                if t.opens() {
                    let mut info = PartInfo::default();
                    info.set_kind(t.attr("subtype").unwrap_or(""));
                    let first = t.attr("firstid").and_then(|v| v.trim().parse::<u32>().ok());
                    let last = t.attr("lastid").and_then(|v| v.trim().parse::<u32>().ok());
                    if t.name == "volume"
                        && let (Some(f), Some(l)) = (first, last)
                        && l > 0
                    {
                        info.range = Some((f, l));
                    }
                    part = Some((t.attr("id").and_then(|v| v.trim().parse().ok()), info));
                }
                if t.closes()
                    && let (Some(o), Some((id, info))) = (object, part.take())
                    && let Some(obj) = out.objects.get_mut(&o)
                {
                    if info.range.is_some() {
                        obj.ranges.push(info);
                    } else if let Some(id) = id {
                        obj.parts.insert(id, info);
                    }
                }
            }
            "plate" => {
                if t.opens() {
                    plate = Some(Plate::default());
                }
                if t.closes()
                    && let Some(p) = plate.take()
                {
                    out.plates.push(p);
                }
            }
            "model_instance" => instance = t.kind == xml::Kind::Open,
            "metadata" if t.opens() => {
                let (Some(k), Some(v)) = (t.attr("key"), t.attr("value")) else {
                    return Ok(());
                };
                let v = xml::unescape(v);
                if let Some(p) = plate.as_mut() {
                    match (k, instance) {
                        ("object_id", true) => {
                            if let Ok(o) = v.trim().parse() {
                                p.objects.push(o);
                            }
                        }
                        (_, true) => {}
                        ("plater_id", false) => p.id = v.trim().parse().unwrap_or(0),
                        ("plater_name", false) => p.name = v,
                        _ => p.settings.push((k.to_owned(), v)),
                    }
                } else if let Some((_, info)) = part.as_mut() {
                    match k {
                        "name" => info.name = Some(v),
                        "volume_type" | "part_type" => info.set_kind(&v),
                        "extruder" => info.slot = slot(&v),
                        k if PART_KEYS.contains(&k) => {}
                        k => info.settings.push((k.to_owned(), v)),
                    }
                } else if let Some(obj) = object.and_then(|o| out.objects.get_mut(&o)) {
                    match k {
                        "name" => obj.name = v,
                        "extruder" => obj.slot = slot(&v),
                        k if OBJECT_KEYS.contains(&k) => {}
                        k => obj.settings.push((k.to_owned(), v)),
                    }
                }
            }
            _ => {}
        }
        Ok(())
    });
    out
}

/// prusaslicer: `<object>` with `<metadata type key value>` and `<volume firstid lastid>`, each volume a range of
/// the object's triangles
fn prusa_meta(text: &str) -> Meta {
    let mut out = Meta::default();
    let mut object: Option<u32> = None;
    let mut volume: Option<PartInfo> = None;
    let mut modifier = false;
    let _ = xml::scan(text, |t: Tag<'_>| -> std::result::Result<(), ()> {
        match t.name {
            "object" => {
                if t.opens() {
                    object = t.attr("id").and_then(|v| v.trim().parse().ok());
                    if let Some(o) = object {
                        out.objects.entry(o).or_default();
                    }
                }
                if t.closes() {
                    object = None;
                }
            }
            "volume" if object.is_some() => {
                if t.opens() {
                    let first = t.attr("firstid").and_then(|v| v.trim().parse::<u32>().ok());
                    let last = t.attr("lastid").and_then(|v| v.trim().parse::<u32>().ok());
                    volume = Some(PartInfo {
                        range: first.zip(last),
                        ..PartInfo::default()
                    });
                    modifier = false;
                }
                if t.closes()
                    && let (Some(o), Some(mut info)) = (object, volume.take())
                    && let Some(obj) = out.objects.get_mut(&o)
                {
                    // older files mark a modifier only with modifier=1
                    if modifier && info.kind == PartKind::Normal && info.kind_text.is_none() {
                        info.kind = PartKind::Modifier;
                    }
                    obj.ranges.push(info);
                }
            }
            "metadata" if t.opens() => {
                let (Some(k), Some(v)) = (t.attr("key"), t.attr("value")) else {
                    return Ok(());
                };
                let v = xml::unescape(v);
                if let Some(info) = volume.as_mut() {
                    match k {
                        "name" => info.name = Some(v),
                        "volume_type" => info.set_kind(&v),
                        "modifier" => modifier = v.trim() == "1",
                        "extruder" => info.slot = slot(&v),
                        k if PRUSA_KEYS.contains(&k) => {}
                        k => info.settings.push((k.to_owned(), v)),
                    }
                } else if let Some(obj) = object.and_then(|o| out.objects.get_mut(&o)) {
                    match k {
                        "name" => obj.name = v,
                        "extruder" => obj.slot = slot(&v),
                        k if PRUSA_KEYS.contains(&k) => {}
                        k => obj.settings.push((k.to_owned(), v)),
                    }
                }
            }
            _ => {}
        }
        Ok(())
    });
    out
}
