// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! exact bodies the engine holds by number, and their triangles out of the engine
//!
//! a body one of the engine's own exact ops makes stays in this table until it is freed. the table is per
//! thread, as a body cannot leave the thread that made it.

use crate::error::{Error, Result};
use crate::faces::Surface as Kind;
use crate::json::OutFile;
use crate::mesh::TriMesh;
use crate::normals;
use crate::vec3::{self, V3};
use serde_json::{Map, Value, json};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use sx_brep::{Body, Curve, Frame, Mesh, Surface, Tessellation};

/// A body in the table, with the key of each of its faces in face order (none at all for a body without keys).
pub struct Held {
    pub body: Body,
    pub keys: Vec<u64>,
}

/// The first number the table gives out.
// temporary: the old kernel table still numbers its own bodies from 1 and both travel in the same request
// fields, so this table starts far above it. the hand-over pair, which puts every body in this table, is the
// change that removes the split and lets numbers start at 1.
pub const FIRST: u32 = 1 << 31;

// the next number, for every thread's table: one is never given out twice in a process
#[allow(clippy::cast_lossless, reason = "u64::from is not const")]
static NEXT: AtomicU64 = AtomicU64::new(FIRST as u64);

thread_local! {
    static TABLE: RefCell<BTreeMap<u32, Rc<Held>>> = const { RefCell::new(BTreeMap::new()) };
}

fn kernel(e: &sx_brep::Error) -> Error {
    Error::geometry("brep", e.to_string())
}

/// Whether a body number is one this table gives out, held or not. The old kernel table never has one this high.
#[must_use]
pub fn is_handle(n: u64) -> bool {
    (u64::from(FIRST)..=u64::from(u32::MAX)).contains(&n)
}

/// Keeps a body and returns its number. Refused, and the body dropped, when `keys` is neither empty nor one per
/// face.
pub fn hold(body: Body, keys: Vec<u64>) -> Result<u32> {
    if !keys.is_empty() && keys.len() != body.faces().map_err(|e| kernel(&e))?.len() {
        return Err(Error::invalid(
            "keys",
            "must be one for each face of the body, or none",
        ));
    }
    let n = u32::try_from(NEXT.fetch_add(1, Ordering::Relaxed))
        .map_err(|_| Error::geometry("brep", "no body numbers are left in this process"))?;
    TABLE.with(|t| t.borrow_mut().insert(n, Rc::new(Held { body, keys })));
    Ok(n)
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
    gone.is_some()
}

/// How many bodies this thread holds.
#[must_use]
pub fn count() -> usize {
    TABLE.with(|t| t.borrow().len())
}

/// the request fields that name a body
const BODY_FIELDS: [&str; 4] = ["body", "target", "a", "b"];

/// a number in the table's range, which the old kernel table must never be asked for
fn high(v: &Value) -> Option<f64> {
    v.as_f64()
        .filter(|n| (f64::from(FIRST)..=f64::from(u32::MAX)).contains(n))
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "a whole number in the table's range, which is inside u32"
)]
fn held(n: f64) -> Option<Rc<Held>> {
    (n.fract() == 0.0).then(|| get(n as u32)).flatten()
}

fn no_such_body(field: &str) -> Error {
    // the old kernel table's words for a number it does not have
    Error::geometry(
        "brep",
        format!("{field}: no such body (freed, or from an earlier session)"),
    )
}

/// A brep op as this table answers it, or none for a request that is the old kernel table's alone and goes to it
/// untouched. `tessellate`, `info` and `free` work on a held body and `count` adds the bodies held here.
pub(crate) fn answer(op: &str, req: &Value, raw: bool) -> Option<Result<Value>> {
    if op == "count" {
        let here = count();
        return (here > 0).then(|| counted(req, here));
    }
    let named = |field: &str| req.get(field).and_then(high);
    if let ("tessellate" | "info" | "free", Some(n)) = (op, named("body")) {
        if op == "free" {
            let freed = n.fract() == 0.0 && free_number(n);
            return Some(Ok(json!({ "freed": freed })));
        }
        let Some(held) = held(n) else {
            return Some(Err(no_such_body("body")));
        };
        return Some(if op == "info" {
            info(&held)
        } else {
            tessellate(&held, req, raw)
        });
    }
    // no other op takes a body of this table yet. the hand-over pair, which lends one to the old ops, removes
    // the first case
    BODY_FIELDS.iter().find_map(|field| {
        let n = named(field)?;
        Some(Err(if held(n).is_some() {
            Error::geometry(
                "brep",
                format!("{field}: this operation cannot work on this body yet"),
            )
        } else {
            no_such_body(field)
        }))
    })
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "a whole number in the table's range, which is inside u32"
)]
fn free_number(n: f64) -> bool {
    free(n as u32)
}

/// the old table's count with this table's added
fn counted(req: &Value, here: usize) -> Result<Value> {
    let reply = sx_brep::call("count", &req.to_string()).map_err(|e| Error::geometry("brep", e))?;
    let mut v: Value = serde_json::from_str(&reply).map_err(|e| Error::Json(e.to_string()))?;
    let old = v.get("bodies").and_then(Value::as_u64).unwrap_or(0);
    if let Some(o) = v.as_object_mut() {
        o.insert("bodies".to_owned(), json!(old + here as u64));
    }
    Ok(v)
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
        *types.entry(names(&face.surface()).1).or_default() += 1;
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

/// the five-kind table of a mesh's faces, in face order
fn table(mesh: &Mesh) -> Vec<Kind> {
    let mut sides = vec![[0.0; 3]; mesh.surfaces.len()];
    let at = |i: u32| mesh.positions.get(i as usize).copied().unwrap_or_default();
    for (t, &face) in mesh.triangles.iter().zip(&mesh.faces) {
        if let Some(side) = sides.get_mut(face as usize) {
            let [a, b, c] = t.map(at);
            *side = vec3::add(*side, vec3::cross(vec3::sub(b, a), vec3::sub(c, a)));
        }
    }
    mesh.surfaces
        .iter()
        .zip(sides)
        .map(|(s, side)| five(s, side))
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
fn tessellate(held: &Held, req: &Value, raw: bool) -> Result<Value> {
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
    let mesh = held.body.tessellate(&how).map_err(|e| kernel(&e))?;
    let triangles = mesh.triangles.len();
    let faces = mesh.surfaces.len();
    if mesh.faces.len() != triangles
        || mesh.normals.len() != triangles
        || mesh.faces.iter().any(|&f| f as usize >= faces)
        || (!held.keys.is_empty() && held.keys.len() != faces)
    {
        return Err(Error::geometry(
            "brep",
            "tessellate: the mesh does not match the body's faces",
        ));
    }
    let kinds: Vec<Value> = table(&mesh).iter().map(kind_json).collect();
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
                    "type": names(s).1,
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
        "rawOut": out(TriMesh::new(mesh.positions, mesh.triangles).to_raw()),
        "normalsOut": out(le_bytes(&packed, i16::to_le_bytes)),
        "faceIdsOut": out(face_ids),
        "edgePointsOut": out(le_bytes(&runs, u32::to_le_bytes)),
        "faces": table,
        "surfaces": surfaces,
        "edges": edges,
    }))
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
    fn only_numbers_the_old_table_never_gives_out_are_this_table_s() {
        assert!(!is_handle(0) && !is_handle(1) && !is_handle((1 << 31) - 1));
        assert!(is_handle(1 << 31) && is_handle((1 << 32) - 1));
        assert!(!is_handle(1 << 32));
        // the page adds its process number times 2^32 above a handle and takes it off again: both stay whole numbers
        // a double holds
        assert!((u64::from(u32::MAX) + (1 << 32) * ((1 << 21) - 1)) < (1 << 53));
        assert_eq!(high(&json!(2_147_483_647)), None);
        assert_eq!(high(&json!(2_147_483_648_u32)), Some(2_147_483_648.0));
        assert_eq!(high(&json!(2_147_483_648.5)), Some(2_147_483_648.5));
        assert_eq!(high(&json!(4_294_967_295_u32)), Some(4_294_967_295.0));
        assert_eq!(high(&json!(4_294_967_296_u64)), None);
        assert_eq!(high(&json!({ "smb": "text" })), None);
        assert_eq!(high(&json!("2147483648")), None);
        // nothing is held in a test that made no body
        assert!(held(2_147_483_648.0).is_none() && held(2_147_483_648.5).is_none());
        assert_eq!(count(), 0);
        assert!(!free(FIRST));
        assert_eq!(with(FIRST, |_| ()), None);
    }

    #[test]
    fn a_request_for_the_old_table_alone_is_left_to_it() {
        for (op, req) in [
            ("count", json!({})),
            ("tessellate", json!({ "body": 7 })),
            ("free", json!({ "body": 7 })),
            ("info", json!({ "body": { "smb": "text" } })),
            ("boolean", json!({ "op": "union", "a": 1, "b": 2 })),
            ("cut", json!({ "body": 4_294_967_296_u64 })),
        ] {
            assert!(answer(op, &req, false).is_none(), "{op}");
        }
    }

    #[test]
    fn a_number_in_this_table_s_range_never_reaches_the_old_table() {
        let free = answer("free", &json!({ "body": FIRST }), false);
        assert_eq!(free.unwrap().unwrap(), json!({ "freed": false }));
        for (op, req, field) in [
            ("tessellate", json!({ "body": FIRST }), "body"),
            ("info", json!({ "body": 2_147_483_648.5 }), "body"),
            ("boolean", json!({ "op": "union", "a": 1, "b": FIRST }), "b"),
            ("extrude", json!({ "target": u32::MAX }), "target"),
            ("free", json!({ "body": 3, "a": FIRST }), "a"),
        ] {
            let refused = answer(op, &req, false).unwrap().unwrap_err().to_string();
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
