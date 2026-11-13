// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! exact bodies the engine holds by number, and their triangles out of the engine
//!
//! every exact body is in this table until it is freed: the ones the engine's own exact ops make, and the ones the
//! older solid operations make, which are taken out of their table as soon as they are made. the table is per
//! thread, as a body cannot leave the thread that made it.

use crate::error::{Error, Result};
use crate::faces::Surface as Kind;
use crate::json::OutFile;
use crate::mesh::TriMesh;
use crate::normals;
use crate::vec3::{self, V3};
use serde_json::{Map, Value, json};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use sx_brep::{Body, Curve, Face, Frame, Mesh, Surface, Tessellation};

/// A body in the table, with the key of each of its faces in face order (none at all for a body without keys). The
/// keys are the ones on the kernel's faces, read once when the body is held; nothing changes a held body.
pub struct Held {
    pub body: Body,
    pub keys: Vec<u64>,
}

// the next number, for every thread's table: one is never given out twice in a process
static NEXT: AtomicU64 = AtomicU64::new(1);

/// A held body's mesh at one chord and angle, and which of its faces are sorted as flat; `tessellate` answers from it.
struct Shown {
    mesh: Mesh,
    flat: Vec<bool>,
}

impl Shown {
    /// the bytes its lists hold
    fn bytes(&self) -> usize {
        let m = &self.mesh;
        let points: usize = m.edges.iter().map(|e| size_of_val(e.points.as_slice())).sum();
        size_of_val(m.positions.as_slice())
            + size_of_val(m.triangles.as_slice())
            + size_of_val(m.faces.as_slice())
            + size_of_val(m.normals.as_slice())
            + size_of_val(m.surfaces.as_slice())
            + size_of_val(m.edges.as_slice())
            + points
            + size_of_val(self.flat.as_slice())
    }
}

/// The most bytes of meshes a thread keeps (256 MiB); past it the one asked for longest ago is dropped and made again.
pub const MESH_BYTES: usize = 256 << 20;

/// a kept mesh: the body's number, chord and angle bits, the mesh, and its bytes
type KeptMesh = ((u32, u64, u64), Rc<Shown>, usize);

thread_local! {
    static TABLE: RefCell<BTreeMap<u32, Rc<Held>>> = const { RefCell::new(BTreeMap::new()) };
    // the one asked for last at the end
    static MESHES: RefCell<Vec<KeptMesh>> = const { RefCell::new(Vec::new()) };
    static MESH_CAP: Cell<usize> = const { Cell::new(MESH_BYTES) };
    static TESSELLATED: Cell<u64> = const { Cell::new(0) };
}

/// How many meshes this thread's `tessellate` has asked the kernel for.
#[doc(hidden)]
#[must_use]
pub fn tessellated() -> u64 {
    TESSELLATED.get()
}

/// The triangles and bytes of the meshes this thread keeps.
#[doc(hidden)]
#[must_use]
pub fn kept_meshes() -> (usize, usize) {
    MESHES.with(|m| {
        m.borrow().iter().fold((0, 0), |(t, b), (_, shown, bytes)| {
            (t + shown.mesh.triangles.len(), b + bytes)
        })
    })
}

/// Sets the most bytes of meshes this thread keeps, [`MESH_BYTES`] until set, and drops what no longer fits.
#[doc(hidden)]
pub fn keep_mesh_bytes(cap: usize) {
    MESH_CAP.set(cap);
    MESHES.with(|m| trim(&mut m.borrow_mut(), 0));
}

/// drops the meshes asked for longest ago until `room` more bytes fit under the cap
fn trim(meshes: &mut Vec<KeptMesh>, room: usize) {
    let over = meshes
        .iter()
        .map(|kept| kept.2)
        .sum::<usize>()
        .saturating_add(room)
        .saturating_sub(MESH_CAP.get());
    let mut freed = 0;
    let n = meshes
        .iter()
        .take_while(|kept| {
            let take = freed < over;
            freed += kept.2;
            take
        })
        .count();
    meshes.drain(..n);
}

fn kernel(e: &sx_brep::Error) -> Error {
    Error::geometry("brep", e.to_string())
}

/// Puts a body in the table under the next number.
fn keep(body: Body, keys: Vec<u64>) -> Result<u32> {
    let n = u32::try_from(NEXT.fetch_add(1, Ordering::Relaxed))
        .map_err(|_| Error::geometry("brep", "no body numbers are left in this process"))?;
    TABLE.with(|t| t.borrow_mut().insert(n, Rc::new(Held { body, keys })));
    Ok(n)
}

/// Keeps a body and returns its number. `keys` are written on the kernel's faces, where the older operations read
/// them and carry them to what they make. Refused, and the body dropped, when `keys` is neither empty nor one per
/// face.
pub fn hold(mut body: Body, keys: Vec<u64>) -> Result<u32> {
    if !keys.is_empty() {
        if keys.len() != body.faces().map_err(|e| kernel(&e))?.len() {
            return Err(Error::invalid(
                "keys",
                "must be one for each face of the body, or none",
            ));
        }
        body.set_keys(&keys).map_err(|e| kernel(&e))?;
    }
    keep(body, keys)
}

fn get(handle: u32) -> Option<Rc<Held>> {
    TABLE.with(|t| t.borrow().get(&handle).cloned())
}

/// Runs `f` on a held body, or returns none for a number that is not held. `f` may hold and free bodies, this one
/// too: it stays alive until `f` returns.
pub fn with<R>(handle: u32, f: impl FnOnce(&Held) -> R) -> Option<R> {
    get(handle).map(|held| f(&held))
}

/// Drops a held body. False for a number that is not held.
pub fn free(handle: u32) -> bool {
    // dropped after the table is let go: freeing a body goes into the kernel
    let gone = TABLE.with(|t| t.borrow_mut().remove(&handle));
    MESHES.with(|m| m.borrow_mut().retain(|(key, ..)| key.0 != handle));
    gone.is_some()
}

/// How many bodies this thread holds.
#[must_use]
pub fn count() -> usize {
    TABLE.with(|t| t.borrow().len())
}

/// the request fields that name a body
const BODY_FIELDS: [&str; 4] = ["body", "target", "a", "b"];
/// the reply fields that name a body an operation made
const MADE_FIELDS: [&str; 3] = ["body", "below", "above"];

/// the number a field names a body by, when it names one by number
fn number(req: &Value, field: &str) -> Option<f64> {
    req.get(field).and_then(Value::as_f64)
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "a whole number from 0 to the largest u32"
)]
fn handle_of(n: f64) -> Option<u32> {
    (n.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(&n)).then_some(n as u32)
}

fn held(n: f64) -> Option<Rc<Held>> {
    handle_of(n).and_then(get)
}

fn no_such_body(field: &str) -> Error {
    Error::geometry(
        "brep",
        format!("{field}: no such body (freed, or from an earlier session)"),
    )
}

/// One of the older operations, called as it is.
fn older(op: &str, req: &Value) -> Result<Value> {
    let reply = sx_brep::call(op, &req.to_string()).map_err(|e| Error::geometry("brep", e))?;
    serde_json::from_str(&reply).map_err(|e| Error::Json(e.to_string()))
}

/// A brep op, answered. Every body is in this table: `tessellate`, `info`, `save`, `free` and `count` are answered
/// from it, and the older operations that take or make a body ([`sx_brep::handover::ROUTED`]) are lent the bodies
/// a request names and have what they make taken into the table. A body sent as text is the older code's for that
/// one call.
pub(crate) fn answer(op: &str, req: &Value, raw: bool) -> Result<Value> {
    match (op, number(req, "body")) {
        ("count", _) => Ok(json!({ "bodies": count() })),
        ("free", n) => Ok(json!({ "freed": n.and_then(handle_of).is_some_and(free) })),
        ("tessellate" | "info" | "save", Some(n)) => {
            let (handle, held) = handle_of(n)
                .and_then(|handle| get(handle).map(|held| (handle, held)))
                .ok_or_else(|| no_such_body("body"))?;
            match op {
                "info" => info(&held),
                // the text the older `save` writes, keys line and checksum included, so `load` reads it
                "save" => held
                    .body
                    .saved(&held.keys)
                    .map(|smb| json!({ "smb": smb }))
                    .map_err(|e| kernel(&e)),
                _ => tessellate(handle, &held, req, raw),
            }
        }
        _ if sx_brep::handover::ROUTED.contains(&op) => handed(op, req),
        _ => older(op, req),
    }
}

/// An older operation on the bodies this table holds: each body the request names by number is lent to it for the
/// call, and each body it makes is taken into the table, so the answer names bodies of this table only.
fn handed(op: &str, req: &Value) -> Result<Value> {
    let mut named = Vec::new();
    for field in BODY_FIELDS {
        if let Some(n) = number(req, field) {
            named.push((field, held(n).ok_or_else(|| no_such_body(field))?));
        }
    }
    let mut asked = req.clone();
    let mut lent = Vec::new();
    for (field, held) in &named {
        let lend = sx_brep::handover::lend(&held.body).map_err(|e| kernel(&e))?;
        // the field is there: its number was read from it
        if let Some(place) = asked.get_mut(*field) {
            *place = json!(lend.number());
        }
        lent.push(lend);
    }
    let reply = older(op, &asked);
    // the numbers leave the older table before anything is made of the answer
    drop(lent);
    let mut reply = reply?;
    take_over(&mut reply)?;
    Ok(reply)
}

/// Takes every body an older operation's reply names into this table and writes this table's numbers in their
/// place. A body that does not read back as a solid is refused: then nothing of the reply is kept, here or in the
/// older table.
fn take_over(reply: &mut Value) -> Result<()> {
    let made: Vec<(&str, i64)> = MADE_FIELDS
        .iter()
        .filter_map(|field| Some((*field, reply.get(*field)?.as_i64()?)))
        .collect();
    let mut kept = Vec::new();
    let mut refused = None;
    for &(field, older_number) in &made {
        if refused.is_some() {
            // freed where it is: nothing was made of it
            let _ = older("free", &json!({ "body": older_number }));
            continue;
        }
        let taken = sx_brep::handover::adopt(older_number)
            .and_then(|body| Ok((body.keys()?, body)))
            .map_err(|e| kernel(&e))
            .and_then(|(keys, body)| {
                // a body without keys has none in the table either
                let keys = if keys.iter().all(|&key| key == 0) {
                    Vec::new()
                } else {
                    keys
                };
                keep(body, keys)
            });
        match taken {
            Ok(handle) => kept.push((field, handle)),
            Err(e) => refused = Some(e),
        }
    }
    if let Some(e) = refused {
        for (_, handle) in kept {
            free(handle);
        }
        return Err(e);
    }
    for (field, handle) in kept {
        reply[field] = json!(handle);
    }
    Ok(())
}

/// Whether a face on a spline surface is a plane where faces are sorted into kinds (`info`'s counts, `tessellate`'s
/// `type` and the five-kind table): one the kernel calls flat within [`sx_brep::FLAT_KIND_MM`], as the older
/// operations sort it. A tapered extrude's and a straight loft's flat sides are such faces. `surfaces` is not sorted.
fn sorted_flat(face: Face) -> bool {
    matches!(face.surface(), Surface::Spline) && face.flat_within(sx_brep::FLAT_KIND_MM)
}

/// a surface's kind as the kernel has it, and the name the old `tessellate` and `info` give that kind
fn names(s: &Surface) -> (&'static str, &'static str) {
    match s {
        Surface::Plane { .. } => ("plane", "plane"),
        Surface::Cylinder { .. } => ("cylinder", "cylinder"),
        Surface::Cone { .. } => ("cone", "cone"),
        Surface::Sphere { .. } => ("sphere", "sphere"),
        Surface::Torus { .. } => ("torus", "torus"),
        Surface::Spline => ("spline", "nurbs"),
        Surface::Revolved => ("revolved", "revolution"),
        Surface::Extruded => ("extruded", "extrusion"),
        Surface::Blend => ("blend", "blend"),
        Surface::Offset => ("offset", "offset"),
        Surface::Other { .. } => ("other", "other"),
    }
}

fn info(held: &Held) -> Result<Value> {
    let body = &held.body;
    let (min, max) = body.bounds().map_err(|e| kernel(&e))?;
    let volume = body.volume().map_err(|e| kernel(&e))?;
    let faces = body.faces().map_err(|e| kernel(&e))?;
    let mut types: BTreeMap<&str, u64> = BTreeMap::new();
    for face in &faces {
        let name = if sorted_flat(*face) {
            "plane"
        } else {
            names(&face.surface()).1
        };
        *types.entry(name).or_default() += 1;
    }
    // a body is in the table only after it read back as a solid
    Ok(json!({
        "manifold": true,
        "volumeMm3": volume,
        "bounds": { "min": min, "max": max },
        "faces": faces.len(),
        "faceTypes": types,
    }))
}

/// A face's surface as one of the five kinds mesh ops know. `side` is the sum of the area vectors of the face's
/// triangles, which says which way a plane faces out; the kernel's plane does not.
fn five(s: &Surface, side: V3) -> Kind {
    match *s {
        Surface::Plane { frame } => {
            let toward = vec3::dot(frame.z, side);
            let normal = if toward > 0.0 {
                frame.z
            } else if toward < 0.0 {
                // 0 - c, so a zero stays plus zero
                frame.z.map(|c| 0.0 - c)
            } else {
                // no triangles, or none with any area: nothing says which side is out
                return Kind::Other;
            };
            Kind::Plane {
                normal,
                offset: vec3::dot(normal, frame.origin),
            }
        }
        Surface::Cylinder { frame, radius } => Kind::Cylinder {
            origin: frame.origin,
            axis: frame.z,
            radius,
        },
        Surface::Cone {
            frame,
            radius,
            half_angle_deg,
            apex,
        } => {
            // the kernel keeps a cylinder as a cone that does not widen and has no tip
            if half_angle_deg.abs() < 1e-9 {
                return Kind::Cylinder {
                    origin: frame.origin,
                    axis: frame.z,
                    radius,
                };
            }
            let Some(apex) = apex else {
                return Kind::Other;
            };
            // a positive angle widens along the frame's z; the table's axis is the way the cone opens
            let axis = if half_angle_deg > 0.0 {
                frame.z
            } else {
                frame.z.map(|c| 0.0 - c)
            };
            Kind::Cone {
                apex,
                axis,
                half_angle: half_angle_deg.abs().to_radians(),
            }
        }
        Surface::Sphere { frame, radius } => Kind::Sphere {
            center: frame.origin,
            radius,
        },
        _ => Kind::Other,
    }
}

/// The plane of a face sorted as flat, from its triangles as the older operations take it: it faces the way the
/// triangles' area vectors sum (`side`), through their middle weighted by area (`middle` over `area`).
fn flat_plane(side: V3, middle: V3, area: f64) -> Kind {
    match vec3::normalize(side) {
        Some(normal) if area > 0.0 => Kind::Plane {
            normal,
            offset: vec3::dot(normal, vec3::scale(middle, 1.0 / area)),
        },
        _ => Kind::Other,
    }
}

/// the five-kind table of a mesh's faces, in face order; `flat` says which faces are sorted as planes whatever
/// their surface ([`sorted_flat`])
fn table(mesh: &Mesh, flat: &[bool]) -> Vec<Kind> {
    let mut sides = vec![([0.0; 3], [0.0; 3], 0.0); mesh.surfaces.len()];
    let at = |i: u32| mesh.positions.get(i as usize).copied().unwrap_or_default();
    for (t, &face) in mesh.triangles.iter().zip(&mesh.faces) {
        if let Some((side, middle, area)) = sides.get_mut(face as usize) {
            let [a, b, c] = t.map(at);
            let twice = vec3::cross(vec3::sub(b, a), vec3::sub(c, a));
            let weight = vec3::len(twice);
            *side = vec3::add(*side, twice);
            *middle = vec3::add(*middle, vec3::scale(vec3::add(vec3::add(a, b), c), weight / 3.0));
            *area += weight;
        }
    }
    mesh.surfaces
        .iter()
        .zip(sides)
        .enumerate()
        .map(|(face, (s, (side, middle, area)))| {
            if flat.get(face) == Some(&true) {
                flat_plane(side, middle, area)
            } else {
                five(s, side)
            }
        })
        .collect()
}

/// a kind as the faces table has it in JSON (what serde writes for it in builds with the cad feature)
fn kind_json(k: &Kind) -> Value {
    match *k {
        Kind::Plane { normal, offset } => json!({ "kind": "plane", "normal": normal, "offset": offset }),
        Kind::Cylinder { origin, axis, radius } => {
            json!({ "kind": "cylinder", "origin": origin, "axis": axis, "radius": radius })
        }
        Kind::Cone {
            apex,
            axis,
            half_angle,
        } => json!({ "kind": "cone", "apex": apex, "axis": axis, "halfAngle": half_angle }),
        Kind::Sphere { center, radius } => json!({ "kind": "sphere", "center": center, "radius": radius }),
        Kind::Other => json!({ "kind": "other" }),
    }
}

fn frame_json(f: &Frame) -> Value {
    json!({ "origin": f.origin, "x": f.x, "y": f.y, "z": f.z })
}

/// a surface with the kernel's own kind and numbers
fn surface_json(s: &Surface) -> Value {
    let kind = names(s).0;
    match *s {
        Surface::Plane { frame } => json!({ "kind": kind, "frame": frame_json(&frame) }),
        Surface::Cylinder { frame, radius } | Surface::Sphere { frame, radius } => {
            json!({ "kind": kind, "frame": frame_json(&frame), "radius": radius })
        }
        Surface::Cone {
            frame,
            radius,
            half_angle_deg,
            apex,
        } => json!({
            "kind": kind,
            "frame": frame_json(&frame),
            "radius": radius,
            "halfAngleDeg": half_angle_deg,
            "apex": apex,
        }),
        Surface::Torus { frame, major, minor } => json!({
            "kind": kind,
            "frame": frame_json(&frame),
            "majorRadius": major,
            "minorRadius": minor,
        }),
        Surface::Other { kernel_type } => json!({ "kind": kind, "kernelType": kernel_type }),
        _ => json!({ "kind": kind }),
    }
}

fn curve_json(c: Curve, into: &mut Map<String, Value>) {
    let name = match c {
        Curve::Line => "line",
        Curve::Circle => "circle",
        Curve::Ellipse => "ellipse",
        Curve::Spline => "spline",
        Curve::Other { kernel_type } => {
            into.insert("kernelType".to_owned(), json!(kernel_type));
            "other"
        }
    };
    into.insert("curve".to_owned(), json!(name));
}

fn limit(req: &Value, field: &'static str, default: f64) -> Result<f64> {
    match req.get(field) {
        None | Some(Value::Null) => Ok(default),
        Some(v) => v
            .as_f64()
            .ok_or_else(|| Error::invalid(field, "must be a number")),
    }
}

fn le_bytes<const N: usize, T: Copy>(values: &[T], bytes: impl Fn(T) -> [u8; N]) -> Vec<u8> {
    values.iter().flat_map(|&v| bytes(v)).collect()
}

/// A held body as triangles: the kernel's own vertices, never welded again, with a face for each triangle, packed
/// corner normals (`normals.rs`), the faces as the five kinds mesh ops know and as the kernel has them, and the
/// body's edges as runs of vertices.
///
/// With `raw` the mesh leaves as the raw buffer every mesh uses (positions as f32) and three more buffers beside it,
/// named in the answer by number: `normalsOut` (i16, six per triangle), `faceIdsOut` (u32 per triangle) and
/// `edgePointsOut` (u32 vertex numbers, each edge's run after the last); `meshForm` is 2 and `faces` is the table
/// and keys alone. Without it the answer is the old `tessellate`'s JSON, positions as f64, with `normals`,
/// `surfaces` and `edges` added.
fn tessellate(handle: u32, held: &Held, req: &Value, raw: bool) -> Result<Value> {
    // the old tessellate's own limits, in its words, so a caller hears the same whichever table holds the body.
    // the typed call takes an angle of 0 when a chord is given; this operation never has
    let refuse = |field: &str, why: &str| Err(Error::geometry("brep", format!("{field}: {why}")));
    let chord = limit(req, "chordMm", 0.01)?;
    if chord.is_nan() || chord < 0.0 {
        return refuse("chordMm", "must be 0 or more");
    }
    let angle = limit(req, "angleDeg", 15.0)?;
    if angle.is_nan() || angle <= 0.0 || angle > 90.0 {
        return refuse("angleDeg", "must be more than 0 and at most 90");
    }
    let how = Tessellation {
        chord_mm: chord,
        curve_angle_deg: angle,
        surface_angle_deg: angle,
        ..Tessellation::default()
    };
    // the answer is built anew on every call: each call's raw buffers are its own
    let shown = shown(handle, held, &how)?;
    let (mesh, flat) = (&shown.mesh, &shown.flat);
    let kinds: Vec<Value> = table(mesh, flat).iter().map(kind_json).collect();
    let surfaces: Vec<Value> = mesh.surfaces.iter().map(surface_json).collect();
    let packed = normals::pack_triangles(&mesh.normals);
    let edges = |points: &dyn Fn(&[u32]) -> Value| -> Vec<Value> {
        mesh.edges
            .iter()
            .map(|e| {
                let mut o = Map::new();
                o.insert("faces".to_owned(), json!(e.faces));
                curve_json(e.curve, &mut o);
                o.insert("tangent".to_owned(), json!(e.tangent));
                o.insert("points".to_owned(), points(&e.points));
                Value::Object(o)
            })
            .collect()
    };
    if !raw {
        let entries: Vec<Value> = mesh
            .surfaces
            .iter()
            .zip(&kinds)
            .enumerate()
            .map(|(i, (s, kind))| {
                json!({
                    "id": i,
                    "type": if flat.get(i) == Some(&true) { "plane" } else { names(s).1 },
                    "surface": kind,
                    "key": held.keys.get(i).copied().unwrap_or(0),
                })
            })
            .collect();
        return Ok(json!({
            "positions": mesh.positions.iter().flatten().collect::<Vec<_>>(),
            "indices": mesh.triangles.iter().flatten().collect::<Vec<_>>(),
            "faceIds": mesh.faces,
            "faces": entries,
            "normals": packed,
            "surfaces": surfaces,
            "edges": edges(&|points| json!(points)),
        }));
    }
    let edges = edges(&|points| json!(points.len()));
    let runs: Vec<u32> = mesh.edges.iter().flat_map(|e| e.points.iter().copied()).collect();
    let mut table = Map::new();
    table.insert("table".to_owned(), Value::Array(kinds));
    if !held.keys.is_empty() {
        table.insert("keys".to_owned(), json!(held.keys));
    }
    let face_ids = le_bytes(&mesh.faces, u32::to_le_bytes);
    let out = |bytes: Vec<u8>| crate::json::push_out_file(OutFile::Bytes(bytes));
    Ok(json!({
        "meshForm": 2,
        "rawOut": out(TriMesh::new(mesh.positions.clone(), mesh.triangles.clone()).to_raw()),
        "normalsOut": out(le_bytes(&packed, i16::to_le_bytes)),
        "faceIdsOut": out(face_ids),
        "edgePointsOut": out(le_bytes(&runs, u32::to_le_bytes)),
        "faces": table,
        "surfaces": surfaces,
        "edges": edges,
    }))
}

/// A held body's mesh at a chord and angle, kept until the body is freed or newer meshes pass [`MESH_BYTES`].
fn shown(handle: u32, held: &Held, how: &Tessellation) -> Result<Rc<Shown>> {
    let key = (handle, how.chord_mm.to_bits(), how.curve_angle_deg.to_bits());
    let found = MESHES.with(|m| {
        let mut m = m.borrow_mut();
        let at = m.iter().position(|kept| kept.0 == key)?;
        let kept = m.remove(at);
        let shown = Rc::clone(&kept.1);
        m.push(kept);
        Some(shown)
    });
    if let Some(shown) = found {
        return Ok(shown);
    }
    TESSELLATED.set(TESSELLATED.get() + 1);
    let mut mesh = held.body.tessellate(how).map_err(|e| kernel(&e))?;
    // no answer reads them
    mesh.uvs = Vec::new();
    let flat: Vec<bool> = held
        .body
        .faces()
        .map_err(|e| kernel(&e))?
        .iter()
        .map(|&face| sorted_flat(face))
        .collect();
    let triangles = mesh.triangles.len();
    let faces = mesh.surfaces.len();
    if mesh.faces.len() != triangles
        || mesh.normals.len() != triangles
        || mesh.faces.iter().any(|&f| f as usize >= faces)
        || (!held.keys.is_empty() && held.keys.len() != faces)
        || flat.len() != faces
    {
        return Err(Error::geometry(
            "brep",
            "tessellate: the mesh does not match the body's faces",
        ));
    }
    let shown = Rc::new(Shown { mesh, flat });
    let bytes = shown.bytes();
    if bytes <= MESH_CAP.get() {
        MESHES.with(|m| {
            let mut m = m.borrow_mut();
            trim(&mut m, bytes);
            m.push((key, Rc::clone(&shown), bytes));
        });
    }
    Ok(shown)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRAME: Frame = Frame {
        origin: [1.0, 2.0, 3.0],
        x: [1.0, 0.0, 0.0],
        y: [0.0, 1.0, 0.0],
        z: [0.0, 0.0, 1.0],
    };

    #[test]
    fn a_number_names_a_body_only_when_it_is_whole_and_held() {
        assert_eq!(handle_of(0.0), Some(0));
        assert_eq!(handle_of(1.0), Some(1));
        assert_eq!(handle_of(4_294_967_295.0), Some(u32::MAX));
        for not_one in [-1.0, 1.5, 4_294_967_296.0, f64::NAN, f64::INFINITY] {
            assert_eq!(handle_of(not_one), None, "{not_one}");
        }
        assert_eq!(number(&json!({ "body": 7 }), "body"), Some(7.0));
        assert_eq!(number(&json!({ "body": { "smb": "text" } }), "body"), None);
        assert_eq!(number(&json!({ "body": "7" }), "body"), None);
        assert_eq!(number(&json!({}), "body"), None);
        // nothing is held in a test that made no body
        assert!(held(1.0).is_none() && held(2_147_483_648.0).is_none());
        assert_eq!(count(), 0);
        assert!(!free(1));
        assert_eq!(with(1, |_| ()), None);
    }

    #[test]
    fn a_number_nothing_is_held_under_is_refused_before_any_older_operation_is_asked() {
        assert_eq!(
            answer("count", &json!({}), false).unwrap(),
            json!({ "bodies": 0 })
        );
        for body in [json!(7), json!(1.5), json!({ "smb": "text" }), json!(null)] {
            let free = answer("free", &json!({ "body": body }), false);
            assert_eq!(free.unwrap(), json!({ "freed": false }), "{body}");
        }
        for (op, req, field) in [
            ("tessellate", json!({ "body": 7 }), "body"),
            ("info", json!({ "body": 2_147_483_648.5 }), "body"),
            ("save", json!({ "body": 4_294_967_296_u64 }), "body"),
            ("boolean", json!({ "op": "union", "a": 1, "b": 2 }), "a"),
            (
                "boolean",
                json!({ "op": "union", "a": { "smb": "text" }, "b": 2 }),
                "b",
            ),
            ("extrude", json!({ "target": u32::MAX }), "target"),
            ("cut", json!({ "body": 4_294_967_296_u64 }), "body"),
        ] {
            let refused = answer(op, &req, false).unwrap_err().to_string();
            assert_eq!(
                refused,
                format!("brep: {field}: no such body (freed, or from an earlier session)"),
                "{op}"
            );
        }
    }

    #[test]
    fn a_plane_faces_the_way_its_triangles_do() {
        let plane = Surface::Plane { frame: FRAME };
        assert_eq!(
            five(&plane, [0.0, 0.0, 2.0]),
            Kind::Plane {
                normal: [0.0, 0.0, 1.0],
                offset: 3.0
            }
        );
        let down = five(&plane, [0.1, 0.0, -2.0]);
        assert_eq!(
            down,
            Kind::Plane {
                normal: [0.0, 0.0, -1.0],
                offset: -3.0
            }
        );
        // a flipped zero is still plus zero, so it prints as 0
        assert_eq!(kind_json(&down)["normal"].to_string(), "[0.0,0.0,-1.0]");
        assert_eq!(five(&plane, [0.0; 3]), Kind::Other);
        assert_eq!(five(&plane, [1.0, 1.0, 0.0]), Kind::Other);
    }

    #[test]
    fn round_faces_become_the_kinds_mesh_ops_know() {
        let none = [0.0; 3];
        let cylinder = Kind::Cylinder {
            origin: FRAME.origin,
            axis: FRAME.z,
            radius: 4.0,
        };
        assert_eq!(
            five(
                &Surface::Cylinder {
                    frame: FRAME,
                    radius: 4.0
                },
                none
            ),
            cylinder
        );
        // a cylinder as the kernel makes one: a cone that does not widen, with no tip
        let straight = Surface::Cone {
            frame: FRAME,
            radius: 4.0,
            half_angle_deg: 0.0,
            apex: None,
        };
        assert_eq!(five(&straight, none), cylinder);
        // narrowing along z to a tip above: the table's cone opens downward from it
        let narrowing = Surface::Cone {
            frame: FRAME,
            radius: 4.0,
            half_angle_deg: -45.0,
            apex: Some([1.0, 2.0, 7.0]),
        };
        assert_eq!(
            five(&narrowing, none),
            Kind::Cone {
                apex: [1.0, 2.0, 7.0],
                axis: [0.0, 0.0, -1.0],
                half_angle: 45.0_f64.to_radians(),
            }
        );
        let no_tip = Surface::Cone {
            frame: FRAME,
            radius: 4.0,
            half_angle_deg: 30.0,
            apex: None,
        };
        assert_eq!(five(&no_tip, none), Kind::Other);
        assert_eq!(
            five(
                &Surface::Sphere {
                    frame: FRAME,
                    radius: 2.5
                },
                none
            ),
            Kind::Sphere {
                center: FRAME.origin,
                radius: 2.5
            }
        );
        let torus = Surface::Torus {
            frame: FRAME,
            major: 5.0,
            minor: 1.0,
        };
        for other in [
            torus,
            Surface::Spline,
            Surface::Revolved,
            Surface::Extruded,
            Surface::Blend,
            Surface::Offset,
            Surface::Other { kernel_type: 15999 },
        ] {
            assert_eq!(five(&other, [0.0, 0.0, 1.0]), Kind::Other, "{other:?}");
        }
    }

    #[cfg(feature = "cad")]
    #[test]
    fn the_table_is_written_as_the_faces_type_reads_it() {
        for kind in [
            Kind::Plane {
                normal: [0.0, 0.0, -1.0],
                offset: -3.0,
            },
            Kind::Cylinder {
                origin: [1.0, 2.0, 3.0],
                axis: [0.0, 1.0, 0.0],
                radius: 4.0,
            },
            Kind::Cone {
                apex: [1.0, 2.0, 7.0],
                axis: [0.0, 0.0, -1.0],
                half_angle: 0.5,
            },
            Kind::Sphere {
                center: [1.0, 2.0, 3.0],
                radius: 2.5,
            },
            Kind::Other,
        ] {
            let written = kind_json(&kind);
            assert_eq!(written, serde_json::to_value(kind).unwrap());
            assert_eq!(serde_json::from_value::<Kind>(written).unwrap(), kind);
        }
    }

    #[test]
    fn exact_surfaces_keep_the_kernel_s_kind_and_numbers() {
        let frame = json!({ "origin": [1.0, 2.0, 3.0], "x": [1.0, 0.0, 0.0], "y": [0.0, 1.0, 0.0], "z": [0.0, 0.0, 1.0] });
        assert_eq!(
            surface_json(&Surface::Plane { frame: FRAME }),
            json!({ "kind": "plane", "frame": frame })
        );
        assert_eq!(
            surface_json(&Surface::Cone {
                frame: FRAME,
                radius: 4.0,
                half_angle_deg: 0.0,
                apex: None
            }),
            json!({ "kind": "cone", "frame": frame, "radius": 4.0, "halfAngleDeg": 0.0, "apex": null })
        );
        assert_eq!(
            surface_json(&Surface::Torus {
                frame: FRAME,
                major: 5.0,
                minor: 1.0
            }),
            json!({ "kind": "torus", "frame": frame, "majorRadius": 5.0, "minorRadius": 1.0 })
        );
        assert_eq!(surface_json(&Surface::Spline), json!({ "kind": "spline" }));
        assert_eq!(
            surface_json(&Surface::Other { kernel_type: 15999 }),
            json!({ "kind": "other", "kernelType": 15999 })
        );
        // the old ops' names for the same kinds, which `info` and the JSON form's `type` keep
        assert_eq!(names(&Surface::Spline), ("spline", "nurbs"));
        assert_eq!(names(&Surface::Revolved), ("revolved", "revolution"));
        assert_eq!(names(&Surface::Extruded), ("extruded", "extrusion"));
    }
}
