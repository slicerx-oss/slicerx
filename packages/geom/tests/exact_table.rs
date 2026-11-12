// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Bodies the engine holds itself (src/exact.rs) through the brep ops that answer for them: tessellate in both
// forms, info, free and count, beside the old kernel table, which must answer as before for its own numbers. The
// bodies are the kernel's four primitives, made by the typed makers and put in the table through its Rust calls.
// Skipped in a build without the kernel, and empty without the brep feature.
#![cfg(feature = "brep")]
use serde_json::{Value, json};
use std::collections::HashMap;
use std::f64::consts::PI;
use std::sync::{Mutex, MutexGuard};
use sx_brep::Body;
use sx_geom::fm::Fm;
use sx_geom::{exact, normals};

// the older operations' table is the whole process's, so the tests here run one at a time
static ONE: Mutex<()> = Mutex::new(());

fn alone() -> MutexGuard<'static, ()> {
    ONE.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn text(op: &str, req: &Value) -> Result<String, String> {
    sx_geom::json::call(op, &req.to_string()).map_err(|e| e.to_string())
}

fn run(op: &str, req: &Value) -> Value {
    let reply = text(op, req).unwrap_or_else(|e| panic!("{op}: {e}"));
    serde_json::from_str(&reply).expect("reply is JSON")
}

fn refused(op: &str, req: &Value) -> String {
    text(op, req).expect_err("the op is refused")
}

fn bodies() -> u64 {
    run("brep.count", &json!({}))["bodies"].as_u64().expect("a count")
}

/// The raw form: the answer and the buffers it names.
fn raw(req: &Value) -> (Value, Vec<Vec<u8>>) {
    let mut req = req.clone();
    req["meshOutput"] = json!("raw");
    let answer = run("brep.tessellate", &req);
    let files = sx_geom::json::take_out_files()
        .iter()
        .map(sx_geom::json::OutFile::to_bytes)
        .collect();
    (answer, files)
}

fn buffer<'a>(answer: &Value, files: &'a [Vec<u8>], field: &str) -> &'a [u8] {
    let n = answer[field]
        .as_u64()
        .unwrap_or_else(|| panic!("{field} names a buffer"));
    &files[usize::try_from(n).unwrap()]
}

fn u32s(bytes: &[u8]) -> Vec<u32> {
    let (words, rest) = bytes.as_chunks::<4>();
    assert!(rest.is_empty());
    words.iter().map(|&w| u32::from_le_bytes(w)).collect()
}

fn i16s(bytes: &[u8]) -> Vec<i16> {
    let (words, rest) = bytes.as_chunks::<2>();
    assert!(rest.is_empty());
    words.iter().map(|&w| i16::from_le_bytes(w)).collect()
}

fn numbers<T>(v: &Value, read: impl Fn(&Value) -> Option<T>) -> Vec<T> {
    v.as_array()
        .expect("an array")
        .iter()
        .map(|n| read(n).expect("a number"))
        .collect()
}

fn index(v: &Value) -> Option<u32> {
    v.as_u64().and_then(|n| u32::try_from(n).ok())
}

fn triple(v: &Value) -> [f64; 3] {
    [0, 1, 2].map(|k| v[k].as_f64().expect("a number"))
}

/// A reply's `positions`, each number read by the standard library, which gives the nearest f64 (the JSON reader
/// may land one step beside it).
fn positions_of(reply: &str) -> Vec<f64> {
    let key = "\"positions\":[";
    let start = reply.find(key).expect("positions in the reply") + key.len();
    let end = start + reply[start..].find(']').expect("the end of positions");
    reply[start..end]
        .split(',')
        .filter(|n| !n.is_empty())
        .map(|n| n.parse().expect("a number"))
        .collect()
}

struct Shape {
    name: &'static str,
    typed: fn() -> Body,
    /// The same solid as the old `brep.primitive` makes it, standing on the origin.
    old: Value,
}

fn shapes() -> Vec<Shape> {
    vec![
        Shape {
            name: "box",
            typed: || Body::cuboid([-10.0, -15.0, 0.0], [20.0, 30.0, 10.0]).unwrap(),
            old: json!({ "type": "box", "sizeMm": [20, 30, 10] }),
        },
        Shape {
            name: "cylinder",
            typed: || Body::cylinder([0.0; 3], 10.0, 20.0).unwrap(),
            old: json!({ "type": "cylinder", "diameterMm": 20, "heightMm": 20 }),
        },
        Shape {
            name: "cone",
            typed: || Body::cone([0.0; 3], 10.0, 0.0, 10.0).unwrap(),
            old: json!({ "type": "cone", "diameterMm": 20, "topDiameterMm": 0, "heightMm": 10 }),
        },
        Shape {
            name: "sphere",
            typed: || Body::sphere([0.0, 0.0, 10.0], 10.0).unwrap(),
            old: json!({ "type": "sphere", "diameterMm": 20 }),
        },
    ]
}

/// A held body, freed when the test lets go of it.
struct Kept(u32);

impl Kept {
    fn new(body: Body) -> Self {
        Self(exact::hold(body, Vec::new()).expect("the table takes the body"))
    }
}

impl Drop for Kept {
    fn drop(&mut self) {
        exact::free(self.0);
    }
}

/// An older operation called directly, past the engine: its own answer, with any body it makes in its own table.
fn older(op: &str, req: &Value) -> String {
    sx_brep::call(op, &req.to_string()).unwrap_or_else(|e| panic!("{op}: {e}"))
}

/// A body in the older operations' own table, made by one of them directly, freed when the test lets go of it.
struct Old(Value);

impl Old {
    fn made(op: &str, req: &Value) -> Self {
        let reply: Value = serde_json::from_str(&older(op, req)).expect("reply is JSON");
        Self(reply["body"].clone())
    }
}

impl Drop for Old {
    fn drop(&mut self) {
        let _ = sx_brep::call("free", &json!({ "body": self.0 }).to_string());
    }
}

/// A body an operation made through the engine, which holds it; freed when the test lets go of it.
struct Made(Value);

impl Drop for Made {
    fn drop(&mut self) {
        let _ = text("brep.free", &json!({ "body": self.0 }));
    }
}

fn unit(a: [f64; 3]) -> [f64; 3] {
    sx_geom::vec3::normalize(a).expect("a direction")
}

fn angle_deg(a: [f64; 3], b: [f64; 3]) -> f64 {
    let c = sx_geom::vec3::cross(a, b);
    sx_geom::vec3::len(c)
        .m_atan2(sx_geom::vec3::dot(a, b))
        .to_degrees()
}

/// The angle the shared vectors allow between a normal and what its packed pair gives back.
fn packed_angle_deg() -> f64 {
    let fixture: Value =
        serde_json::from_str(include_str!("../../contracts/fixtures/mesh-normal-pack.json")).unwrap();
    fixture["maxAngleDeg"].as_f64().unwrap()
}

/// The JSON form of a held body: f64 positions, triangles, the face of each, and the packed normals.
struct Read {
    positions: Vec<[f64; 3]>,
    triangles: Vec<[u32; 3]>,
    faces: Vec<u32>,
    normals: Vec<i16>,
    answer: Value,
}

fn read(body: u32) -> Read {
    let reply = text("brep.tessellate", &json!({ "body": body })).expect("tessellates");
    let answer: Value = serde_json::from_str(&reply).unwrap();
    Read {
        positions: positions_of(&reply).as_chunks::<3>().0.to_vec(),
        triangles: numbers(&answer["indices"], index).as_chunks::<3>().0.to_vec(),
        faces: numbers(&answer["faceIds"], index),
        normals: numbers(&answer["normals"], |v| {
            v.as_i64().and_then(|n| i16::try_from(n).ok())
        }),
        answer,
    }
}

impl Read {
    /// The corner normals of triangle `t` unpacked, or none when it has none.
    fn corner_normals(&self, t: usize) -> Option<[[f64; 3]; 3]> {
        let six = &self.normals[6 * t..6 * t + 6];
        let all = [0, 1, 2].map(|k| normals::unpack([six[2 * k], six[2 * k + 1]]));
        assert_eq!(
            normals::exact_triangle(&self.normals, t),
            all.iter().all(Option::is_some)
        );
        Some([all[0]?, all[1]?, all[2]?])
    }

    fn kind(&self, t: usize) -> &str {
        self.answer["faces"][self.faces[t] as usize]["surface"]["kind"]
            .as_str()
            .expect("a kind")
    }
}

#[test]
fn the_buffers_are_as_long_as_the_counts_say() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    for shape in shapes() {
        let name = shape.name;
        let kept = Kept::new((shape.typed)());
        let (answer, files) = raw(&json!({ "body": kept.0 }));
        assert_eq!(answer["meshForm"], 2, "{name}");
        assert_eq!(files.len(), 4, "{name}: buffers");
        let mesh = buffer(&answer, &files, "rawOut");
        let (nv, nt) = (u32s(&mesh[..4])[0] as usize, u32s(&mesh[4..8])[0] as usize);
        assert!(nv > 0 && nt > 0, "{name}");
        assert_eq!(mesh.len(), 8 + 12 * nv + 12 * nt, "{name}: mesh");
        // today's raw form, as every reader of it takes it
        let read_back = sx_geom::TriMesh::from_raw(mesh, name).expect("the raw mesh reads");
        assert_eq!((read_back.positions.len(), read_back.triangles.len()), (nv, nt));
        let packed = i16s(buffer(&answer, &files, "normalsOut"));
        assert_eq!(packed.len(), 6 * nt, "{name}: normals");
        let ids = u32s(buffer(&answer, &files, "faceIdsOut"));
        assert_eq!(ids.len(), nt, "{name}: face ids");
        let table = answer["faces"]["table"].as_array().expect("a table");
        let surfaces = answer["surfaces"].as_array().expect("surfaces");
        assert_eq!(table.len(), surfaces.len(), "{name}");
        assert!(ids.iter().all(|&f| (f as usize) < table.len()), "{name}");
        // every face has triangles
        assert!(
            (0..table.len()).all(|f| ids.iter().any(|&i| i as usize == f)),
            "{name}"
        );
        assert!(answer["faces"].get("keys").is_none(), "{name}: no keys held");
        let runs = u32s(buffer(&answer, &files, "edgePointsOut"));
        let edges = answer["edges"].as_array().expect("edges");
        let points: u64 = edges.iter().map(|e| e["points"].as_u64().expect("a count")).sum();
        assert_eq!(runs.len() as u64, points, "{name}: edge points");
        assert!(runs.iter().all(|&p| (p as usize) < nv), "{name}");
        for edge in edges {
            let on = numbers(&edge["faces"], index);
            assert_eq!(on.len(), 2, "{name}");
            assert!(on.iter().all(|&f| (f as usize) < table.len()), "{name}");
            assert!(
                edge["curve"].is_string() && edge["tangent"].is_boolean(),
                "{name}: {edge}"
            );
        }

        // the JSON form says the same, with positions in full
        let json_form = read(kept.0);
        assert!(json_form.answer.get("meshForm").is_none(), "{name}");
        assert_eq!(json_form.positions.len(), nv, "{name}");
        assert_eq!(json_form.triangles, read_back.triangles, "{name}");
        #[allow(
            clippy::cast_possible_truncation,
            clippy::float_cmp,
            reason = "the raw form is the f32 nearest each number"
        )]
        for (p, q) in json_form.positions.iter().zip(&read_back.positions) {
            assert_eq!(p.map(|c| f64::from(c as f32)), *q, "{name}: positions as f32");
        }
        assert_eq!(json_form.faces, ids, "{name}");
        assert_eq!(json_form.normals, packed, "{name}");
        assert_eq!(json_form.answer["surfaces"], answer["surfaces"], "{name}");
        let listed: Vec<u32> = json_form.answer["edges"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|e| numbers(&e["points"], index))
            .collect();
        assert_eq!(listed, runs, "{name}: edge runs");
        for (i, face) in json_form.answer["faces"].as_array().unwrap().iter().enumerate() {
            assert_eq!(face["id"], i, "{name}");
            assert_eq!(face["surface"], table[i], "{name}");
            assert_eq!(face["key"], 0, "{name}");
            assert!(face["type"].is_string(), "{name}");
        }
    }
}

#[test]
fn normals_on_round_faces_are_the_exact_ones_within_the_packed_angle() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    let max = packed_angle_deg();
    let check = |name: &str, got: [f64; 3], want: [f64; 3], at: [f64; 3]| {
        let off = angle_deg(got, want);
        assert!(off <= max, "{name}: {off} degrees off at {at:?}");
    };

    let sphere = Kept::new(Body::sphere([3.0, -2.0, 7.0], 10.0).unwrap());
    let m = read(sphere.0);
    let mut with = 0;
    for (t, corners) in m.triangles.iter().enumerate() {
        let Some(ns) = m.corner_normals(t) else {
            continue;
        };
        with += 1;
        for (&i, n) in corners.iter().zip(ns) {
            let p = m.positions[i as usize];
            check("sphere", n, unit(sx_geom::vec3::sub(p, [3.0, -2.0, 7.0])), p);
        }
    }
    // nearly all of it: a triangle goes without only where the kernel's own normal is unusable
    assert!(
        with * 100 >= m.triangles.len() * 99,
        "{with} of {}",
        m.triangles.len()
    );

    let cylinder = Kept::new(Body::cylinder([5.0, -4.0, 2.0], 10.0, 20.0).unwrap());
    let m = read(cylinder.0);
    let mut wall = 0;
    for (t, corners) in m.triangles.iter().enumerate() {
        let ns = m
            .corner_normals(t)
            .expect("every corner of a cylinder has a normal");
        let round = m.kind(t) == "cylinder";
        wall += usize::from(round);
        for (&i, n) in corners.iter().zip(ns) {
            let p = m.positions[i as usize];
            let want = if round {
                unit([p[0] - 5.0, p[1] + 4.0, 0.0])
            } else {
                [0.0, 0.0, if p[2] > 12.0 { 1.0 } else { -1.0 }]
            };
            check("cylinder", n, want, p);
        }
    }
    assert!(wall > 0);

    let cone = Kept::new(Body::cone([0.0; 3], 10.0, 0.0, 10.0).unwrap());
    let m = read(cone.0);
    let tip = |p: [f64; 3]| p[0].m_hypot(p[1]) < 1e-9 && (p[2] - 10.0).abs() < 1e-9;
    let (mut with, mut without) = (0, 0);
    for (t, corners) in m.triangles.iter().enumerate() {
        let points = corners.map(|i| m.positions[i as usize]);
        let on_cone = m.kind(t) == "cone";
        let at_tip = on_cone && points.iter().any(|&p| tip(p));
        // round the tip no one direction is the normal, so those triangles pack as none
        let Some(ns) = m.corner_normals(t) else {
            without += 1;
            assert!(at_tip, "cone: no normal away from the tip");
            assert_eq!(m.normals[6 * t..6 * t + 6], [normals::NO_NORMAL; 6]);
            continue;
        };
        with += 1;
        assert!(!at_tip, "cone: a normal at the tip");
        for (p, n) in points.into_iter().zip(ns) {
            let want = if on_cone {
                let r = p[0].m_hypot(p[1]);
                unit([p[0] / r, p[1] / r, 1.0])
            } else {
                [0.0, 0.0, -1.0]
            };
            check("cone", n, want, p);
        }
    }
    assert!(with > 0 && without > 0, "{with} with, {without} without");
}

#[cfg(feature = "cad")]
fn near(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

#[cfg(feature = "cad")]
fn near3(a: [f64; 3], b: [f64; 3]) -> bool {
    (0..3).all(|k| near(a[k], b[k]))
}

/// A body's faces from the raw form, read as the engine's own `Faces` and checked against its mesh.
#[cfg(feature = "cad")]
fn faces_of(body: Body, keys: Vec<u64>) -> (sx_geom::faces::Faces, Value) {
    let handle = exact::hold(body, keys).expect("held");
    let (answer, files) = raw(&json!({ "body": handle }));
    assert!(exact::free(handle));
    let mesh = sx_geom::TriMesh::from_raw(buffer(&answer, &files, "rawOut"), "mesh").unwrap();
    let mut faces = answer["faces"].clone();
    faces["ids"] = json!(u32s(buffer(&answer, &files, "faceIdsOut")));
    let faces: sx_geom::faces::Faces = serde_json::from_value(faces).expect("the engine's Faces reads it");
    faces
        .check("faces", mesh.triangles.len())
        .expect("one id per triangle, in the table");
    assert!(faces.fit(&mesh), "the surfaces lie on their triangles");
    (faces, answer)
}

#[cfg(feature = "cad")]
#[test]
fn flat_faces_read_as_planes_facing_out_with_their_keys() {
    use sx_geom::faces::Surface;
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    // a box away from the origin: six planes facing out, with the keys it was held with
    let (faces, _) = faces_of(
        Body::cuboid([1.0, 2.0, 3.0], [4.0, 5.0, 6.0]).unwrap(),
        vec![11, 12, 13, 14, 15, 16],
    );
    assert_eq!(faces.keys, [11, 12, 13, 14, 15, 16]);
    let mut planes: Vec<([f64; 3], f64)> = faces
        .table
        .iter()
        .map(|s| match *s {
            Surface::Plane { normal, offset } => (normal, offset),
            other => panic!("a box face is a plane, not {other:?}"),
        })
        .collect();
    planes.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let want = [
        ([-1.0, 0.0, 0.0], -1.0),
        ([0.0, -1.0, 0.0], -2.0),
        ([0.0, 0.0, -1.0], -3.0),
        ([0.0, 0.0, 1.0], 9.0),
        ([0.0, 1.0, 0.0], 7.0),
        ([1.0, 0.0, 0.0], 5.0),
    ];
    for ((normal, offset), (n, o)) in planes.iter().zip(want) {
        assert!(near3(*normal, n) && near(*offset, o), "{planes:?}");
    }
}

#[cfg(feature = "cad")]
#[test]
fn round_faces_read_as_the_engine_s_own_kinds() {
    use sx_geom::faces::Surface;
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    // a cylinder: the kernel keeps its wall as a cone that does not widen, and the table says cylinder
    let (faces, answer) = faces_of(Body::cylinder([5.0, -4.0, 2.0], 10.0, 20.0).unwrap(), Vec::new());
    assert!(faces.keys.is_empty());
    assert_eq!(faces.table.len(), 3);
    let walls: Vec<_> = faces
        .table
        .iter()
        .enumerate()
        .filter(|(_, s)| !matches!(s, Surface::Plane { .. }))
        .collect();
    let [(wall, &Surface::Cylinder { origin, axis, radius })] = walls[..] else {
        panic!("one cylinder wall, not {walls:?}");
    };
    assert!(near(radius, 10.0) && near(axis[2].abs(), 1.0), "{walls:?}");
    assert!(near(origin[0], 5.0) && near(origin[1], -4.0), "{walls:?}");
    let exact_wall = &answer["surfaces"][wall];
    assert!(
        exact_wall["kind"] == "cylinder"
            || (exact_wall["kind"] == "cone"
                && exact_wall["halfAngleDeg"] == 0.0
                && exact_wall["apex"].is_null()),
        "{exact_wall}"
    );
    assert!(near(exact_wall["radius"].as_f64().unwrap(), 10.0));

    // a cone to a point: its tip, the way it opens and its half angle
    let (faces, answer) = faces_of(Body::cone([0.0; 3], 10.0, 0.0, 10.0).unwrap(), Vec::new());
    let cones: Vec<_> = faces
        .table
        .iter()
        .enumerate()
        .filter(|(_, s)| !matches!(s, Surface::Plane { .. }))
        .collect();
    let [
        (
            wall,
            &Surface::Cone {
                apex,
                axis,
                half_angle,
            },
        ),
    ] = cones[..]
    else {
        panic!("one cone wall, not {cones:?}");
    };
    assert!(
        near3(apex, [0.0, 0.0, 10.0]) && near3(axis, [0.0, 0.0, -1.0]),
        "{cones:?}"
    );
    assert!(near(half_angle, PI / 4.0), "{cones:?}");
    let exact_wall = &answer["surfaces"][wall];
    assert_eq!(exact_wall["kind"], "cone");
    assert!(near(exact_wall["halfAngleDeg"].as_f64().unwrap().abs(), 45.0));
    assert!(near3(triple(&exact_wall["apex"]), [0.0, 0.0, 10.0]));

    let (faces, answer) = faces_of(Body::sphere([3.0, -2.0, 7.0], 10.0).unwrap(), Vec::new());
    let [Surface::Sphere { center, radius }] = faces.table[..] else {
        panic!("one sphere, not {:?}", faces.table);
    };
    assert!(near3(center, [3.0, -2.0, 7.0]) && near(radius, 10.0));
    assert_eq!(answer["surfaces"][0]["kind"], "sphere");
    assert!(near3(
        triple(&answer["surfaces"][0]["frame"]["origin"]),
        [3.0, -2.0, 7.0]
    ));
}

/// A mesh's points welded as the old `tessellate` welds them: points that round alike on a 1e-6 mm grid become the
/// first of them, and a triangle with two corners on one welded point is left out. Returns flat positions, flat
/// indices, the face of each triangle kept, and how many were left out.
#[allow(
    clippy::cast_possible_truncation,
    reason = "coordinates times 1e6 stay far inside i64"
)]
fn welded(m: &Read) -> (Vec<f64>, Vec<u64>, Vec<i64>, usize) {
    let mut weld: HashMap<[i64; 3], u64> = HashMap::new();
    let (mut positions, mut indices, mut faces, mut left_out) = (Vec::new(), Vec::new(), Vec::new(), 0);
    for (triangle, &face) in m.triangles.iter().zip(&m.faces) {
        let ids = triangle.map(|corner| {
            let p = m.positions[corner as usize];
            let next = weld.len() as u64;
            *weld
                .entry(p.map(|c| (c * 1e6).round() as i64))
                .or_insert_with(|| {
                    positions.extend(p);
                    next
                })
        });
        if ids[0] == ids[1] || ids[1] == ids[2] || ids[0] == ids[2] {
            left_out += 1;
            continue;
        }
        indices.extend(ids);
        faces.push(i64::from(face));
    }
    (positions, indices, faces, left_out)
}

/// The faces of a held body's JSON form against the old op's: the same faces in the same order, named and read
/// alike.
fn same_faces(name: &str, new: &Value, old: &Value) {
    let old_faces = old["faces"].as_array().unwrap();
    let new_faces = new["faces"].as_array().unwrap();
    assert_eq!(new_faces.len(), old_faces.len(), "{name}: face count");
    for (a, b) in new_faces.iter().zip(old_faces) {
        assert_eq!(a["id"], b["id"], "{name}");
        assert_eq!(a["type"], b["type"], "{name}");
        let (a, b) = (&a["surface"], &b["surface"]);
        assert_eq!(a["kind"], b["kind"], "{name}: {a} against {b}");
        for (field, value) in b.as_object().unwrap() {
            match value {
                Value::Number(n) => {
                    let (got, want) = (a[field].as_f64().unwrap(), n.as_f64().unwrap());
                    assert!((got - want).abs() < 1e-9, "{name}: {field} {a} against {b}");
                }
                Value::Array(_) => {
                    let (got, want) = (triple(&a[field]), triple(value));
                    assert!(
                        (0..3).all(|k| (got[k] - want[k]).abs() < 1e-9),
                        "{name}: {field} {a} against {b}"
                    );
                }
                _ => {}
            }
        }
    }
}

/// `brep.info` of a held body against the old op's for the same solid.
fn same_info(name: &str, held: u32, old_body: &Value) {
    let (a, b) = (
        run("brep.info", &json!({ "body": held })),
        serde_json::from_str::<Value>(&older("info", &json!({ "body": old_body }))).expect("reply is JSON"),
    );
    assert_eq!(a["manifold"], b["manifold"], "{name}");
    assert_eq!(a["faces"], b["faces"], "{name}");
    let counts = |v: &Value| -> Vec<(String, f64)> {
        v["faceTypes"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, n)| (k.clone(), n.as_f64().unwrap()))
            .collect()
    };
    assert_eq!(counts(&a), counts(&b), "{name}");
    let (va, vb) = (a["volumeMm3"].as_f64().unwrap(), b["volumeMm3"].as_f64().unwrap());
    assert!((va - vb).abs() <= 1e-9 * vb, "{name}: volume {va} against {vb}");
    for side in ["min", "max"] {
        let (got, want) = (triple(&a["bounds"][side]), triple(&b["bounds"][side]));
        assert!((0..3).all(|k| (got[k] - want[k]).abs() < 1e-9), "{name}: {side}");
    }
}

// a tapered extrude's sides come out of the kernel as ruled surfaces, flat to a hundredth of a micron, and the
// older operation puts them on exact planes before it answers. The engine, which holds the body now, answers its
// faces as the older operation does
#[test]
fn a_tapered_extrude_s_sides_are_planes_as_the_older_operation_has_them() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    let request = json!({
        "frame": { "origin": [0, 0, 0], "u": [1, 0, 0], "normal": [0, 0, 1] },
        "polygons": [{ "outer": { "points": [[0, 0], [20, 0], [20, 10], [0, 10]] }, "holes": [] }],
        "fromMm": 0,
        "toMm": 5,
        "taperDeg": 10,
    });
    let old_body = Old::made("extrude", &request);
    let old: Value =
        serde_json::from_str(&older("tessellate", &json!({ "body": old_body.0 }))).expect("reply is JSON");
    let made = Made(run("brep.extrude", &request)["body"].clone());
    let held = made
        .0
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .expect("a body");
    let new = read(held);
    same_faces("taper", &new.answer, &old);
    same_info("taper", held, &old_body.0);
    let count = |list: &Value, kind: &dyn Fn(&Value) -> &Value, name: &str| {
        list.as_array()
            .expect("a list")
            .iter()
            .filter(|v| kind(v) == name)
            .count()
    };
    assert_eq!(
        count(&new.answer["faces"], &|f| &f["surface"]["kind"], "plane"),
        6
    );
    assert_eq!(count(&new.answer["faces"], &|f| &f["type"], "plane"), 6);
    // and they are planes in the kernel itself
    assert_eq!(count(&new.answer["surfaces"], &|s| &s["kind"], "plane"), 6);
    let (answer, _) = raw(&json!({ "body": held }));
    assert_eq!(count(&answer["faces"]["table"], &|s| &s["kind"], "plane"), 6);
}

#[allow(clippy::float_cmp, reason = "coordinates are compared bit for bit")]
#[test]
fn a_held_body_tessellates_to_the_old_op_s_triangles() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    for shape in shapes() {
        let name = shape.name;
        let old_body = Old::made("primitive", &shape.old);
        // the old op does not read `meshOutput`: its answer is the same with it
        let reply = older("tessellate", &json!({ "body": old_body.0 }));
        assert_eq!(
            older("tessellate", &json!({ "body": old_body.0, "meshOutput": "raw" })),
            reply,
            "{name}"
        );
        assert!(sx_geom::json::take_out_files().is_empty(), "{name}");
        let old: Value = serde_json::from_str(&reply).unwrap();
        let kept = Kept::new((shape.typed)());
        let new = read(kept.0);

        let (positions, indices, faces, left_out) = welded(&new);
        let old_positions = positions_of(&reply);
        assert_eq!(
            indices,
            numbers(&old["indices"], Value::as_u64),
            "{name}: triangle corners"
        );
        assert_eq!(
            faces,
            numbers(&old["faceIds"], Value::as_i64),
            "{name}: the face of each triangle"
        );
        assert_eq!(positions.len(), old_positions.len(), "{name}: point count");
        // a box agrees bit for bit. on round faces some coordinates come out one float step apart between a body
        // made by the old op and the same body made by the typed maker; each path repeats itself exactly (below)
        let differ = (0..positions.len())
            .filter(|&i| positions[i] != old_positions[i])
            .count();
        let largest = positions
            .iter()
            .zip(&old_positions)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0, f64::max);
        println!(
            "{name}: {} triangles on {} kernel vertices, {} welded points; {differ} of {} coordinates differ from the old op's, the largest by {largest:e} mm",
            new.triangles.len(),
            new.positions.len(),
            positions.len() / 3,
            positions.len()
        );
        if name == "box" {
            assert_eq!(positions, old_positions, "{name}: positions");
        }
        assert_eq!(left_out, 0, "{name}: triangles the weld leaves out");
        assert_eq!(
            new.positions.len() * 3,
            old_positions.len(),
            "{name}: kernel vertices"
        );

        // the same body read twice, and a second body made the same way, give the same bytes in both forms
        let again = Kept::new((shape.typed)());
        let form = |body: u32| {
            (
                text("brep.tessellate", &json!({ "body": body })),
                raw(&json!({ "body": body })),
            )
        };
        let first = form(kept.0);
        assert!(first == form(kept.0), "{name}: one held body read twice");
        assert!(first == form(again.0), "{name}: two held bodies made alike");

        same_faces(name, &new.answer, &old);
        same_info(name, kept.0, &old_body.0);
    }
}

#[test]
fn a_freed_body_is_gone_and_the_count_comes_back() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    let start = bodies();
    let held = exact::count();
    let a = exact::hold(Body::cuboid([0.0; 3], [1.0; 3]).unwrap(), Vec::new()).unwrap();
    let b = exact::hold(Body::sphere([0.0; 3], 2.0).unwrap(), Vec::new()).unwrap();
    assert!(a >= 1 && b > a);
    assert_eq!(exact::count(), held + 2);
    assert_eq!(bodies(), start + 2);
    // a body an older operation makes is held here beside them, under the next number, and the older table keeps
    // nothing
    let made = Made(run("brep.box", &json!({ "min": [0, 0, 0], "max": [1, 1, 1] }))["body"].clone());
    let number = u32::try_from(made.0.as_u64().unwrap()).unwrap();
    assert!(number > b && exact::with(number, |_| ()).is_some());
    assert_eq!(bodies(), start + 3);
    assert_eq!(exact::count(), held + 3);
    assert_eq!(older("count", &json!({})), r#"{"bodies":0}"#);

    assert_eq!(run("brep.free", &json!({ "body": a })), json!({ "freed": true }));
    assert_eq!(bodies(), start + 2);
    let gone = "brep: body: no such body (freed, or from an earlier session)";
    assert_eq!(refused("brep.tessellate", &json!({ "body": a })), gone);
    assert_eq!(
        refused("brep.tessellate", &json!({ "body": a, "meshOutput": "raw" })),
        gone
    );
    assert!(sx_geom::json::take_out_files().is_empty());
    assert_eq!(refused("brep.info", &json!({ "body": a })), gone);
    assert_eq!(run("brep.free", &json!({ "body": a })), json!({ "freed": false }));
    assert_eq!(exact::with(a, |_| ()), None);
    // a number this table never gave out, and one that is no whole number: errors of the engine's own, in the old
    // table's words for a number it does not have
    for never in [json!(u32::MAX), json!(f64::from(b) + 0.5)] {
        assert_eq!(refused("brep.tessellate", &json!({ "body": never })), gone);
        assert_eq!(refused("brep.info", &json!({ "body": never })), gone);
        assert_eq!(
            run("brep.free", &json!({ "body": never })),
            json!({ "freed": false })
        );
    }
    let old_gone = {
        let freed = run("brep.box", &json!({ "min": [0, 0, 0], "max": [1, 1, 1] }))["body"].clone();
        assert_eq!(
            run("brep.free", &json!({ "body": freed })),
            json!({ "freed": true })
        );
        refused("brep.tessellate", &json!({ "body": freed }))
    };
    assert_eq!(old_gone, gone, "a body an older operation made, once freed");

    // a number is never given out twice
    let c = exact::hold(Body::cuboid([0.0; 3], [1.0; 3]).unwrap(), Vec::new()).unwrap();
    assert!(c > b);
    assert!(exact::free(c) && !exact::free(c));
    assert!(exact::free(b));
    drop(made);
    assert_eq!(bodies(), start);
    assert_eq!(exact::count(), held);
}

#[test]
fn the_older_operations_take_a_held_body_and_leave_it_held() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    let kept = Kept::new(Body::cuboid([0.0; 3], [10.0; 3]).unwrap());
    let other = Made(run("brep.box", &json!({ "min": [5, 5, 5], "max": [15, 15, 15] }))["body"].clone());
    let start = bodies();
    let gone = |field: &str| format!("brep: {field}: no such body (freed, or from an earlier session)");
    let union = |a: &Value, b: &Value| text("brep.boolean", &json!({ "op": "union", "a": a, "b": b }));
    let volume = |body: &Value| {
        run("brep.info", &json!({ "body": body }))["volumeMm3"]
            .as_f64()
            .unwrap()
    };
    let about = |v: f64, want: f64| (v - want).abs() <= 1e-6 * want;
    // in either place, with a body an older operation made: two cubes of 1000 that share 125
    for (a, b) in [(json!(kept.0), other.0.clone()), (other.0.clone(), json!(kept.0))] {
        let joined: Value = serde_json::from_str(&union(&a, &b).expect("joined")).unwrap();
        let joined = Made(joined["body"].clone());
        assert!(about(volume(&joined.0), 1875.0), "{}", volume(&joined.0));
        assert_eq!(bodies(), start + 1);
    }
    let plane = json!({ "point": [0, 0, 5], "normal": [0, 0, 1] });
    let halves = run("brep.cut", &json!({ "body": kept.0, "plane": plane }));
    let (below, above) = (Made(halves["below"].clone()), Made(halves["above"].clone()));
    assert!(about(volume(&below.0), 500.0) && about(volume(&above.0), 500.0));
    drop((below, above));
    // save answers the text the load reads; the body it describes is the held one, which stays held
    let saved = run("brep.save", &json!({ "body": kept.0 }));
    assert!(saved["smb"].as_str().is_some_and(|smb| !smb.is_empty()));
    sx_geom::json::allow_brep_text(true);
    let loaded = Made(run("brep.load", &json!({ "body": saved }))["body"].clone());
    sx_geom::json::allow_brep_text(false);
    assert!(about(volume(&loaded.0), 1000.0));
    drop(loaded);
    assert!(exact::with(kept.0, |_| ()).is_some());

    let freed = {
        let body = exact::hold(Body::cuboid([0.0; 3], [1.0; 3]).unwrap(), Vec::new()).unwrap();
        assert!(exact::free(body));
        json!(body)
    };
    assert_eq!(union(&freed, &other.0), Err(gone("a")));
    assert_eq!(union(&other.0, &freed), Err(gone("b")));
    assert_eq!(
        refused("brep.cut", &json!({ "body": freed, "plane": plane })),
        gone("body")
    );
    assert_eq!(refused("brep.save", &json!({ "body": freed })), gone("body"));
    assert_eq!(
        refused("brep.extrude", &json!({ "target": freed, "operation": "join" })),
        gone("target")
    );

    // nothing was lost, the older table holds nothing, and the held body is as it was
    assert_eq!(bodies(), start);
    assert_eq!(older("count", &json!({})), r#"{"bodies":0}"#);
    assert_eq!(read(kept.0).triangles.len(), 12);
}

#[test]
fn chord_and_angle_have_the_old_op_s_limits() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    let kept = Kept::new(Body::sphere([0.0; 3], 10.0).unwrap());
    let triangles = |req: Value| run("brep.tessellate", &req)["faceIds"].as_array().unwrap().len();
    let default = triangles(json!({ "body": kept.0 }));
    // the defaults are the old op's: a 0.01 mm chord and 15 degrees
    assert_eq!(
        triangles(json!({ "body": kept.0, "chordMm": 0.01, "angleDeg": 15 })),
        default
    );
    assert_eq!(triangles(json!({ "body": kept.0, "chordMm": null })), default);
    let coarse = triangles(json!({ "body": kept.0, "chordMm": 0.5, "angleDeg": 45 }));
    let fine = triangles(json!({ "body": kept.0, "chordMm": 0.01, "angleDeg": 5 }));
    assert!(coarse < default && default < fine, "{coarse} {default} {fine}");

    // out of range, a body held from the start and one an older operation made are refused in the same words
    let old = Made(run("brep.primitive", &json!({ "type": "sphere", "diameterMm": 20 }))["body"].clone());
    for (limits, said) in [
        (json!({ "chordMm": -1 }), "brep: chordMm: must be 0 or more"),
        (
            json!({ "angleDeg": 120 }),
            "brep: angleDeg: must be more than 0 and at most 90",
        ),
        (
            json!({ "angleDeg": 0 }),
            "brep: angleDeg: must be more than 0 and at most 90",
        ),
        (
            json!({ "chordMm": 0, "angleDeg": 0 }),
            "brep: angleDeg: must be more than 0 and at most 90",
        ),
        (
            json!({ "angleDeg": -5 }),
            "brep: angleDeg: must be more than 0 and at most 90",
        ),
    ] {
        let ask = |body: &Value| {
            let mut req = limits.clone();
            req["body"] = body.clone();
            refused("brep.tessellate", &req)
        };
        assert_eq!(ask(&json!(kept.0)), said, "{limits}");
        assert_eq!(ask(&old.0), said, "{limits}");
    }
    assert_eq!(
        refused("brep.tessellate", &json!({ "body": kept.0, "chordMm": "fine" })),
        "chordMm: must be a number"
    );
    assert_eq!(
        refused(
            "brep.tessellate",
            &json!({ "body": kept.0, "angleDeg": [15], "meshOutput": "raw" })
        ),
        "angleDeg: must be a number"
    );
    assert!(sx_geom::json::take_out_files().is_empty());
}

#[test]
fn keys_are_one_per_face_or_none_and_bodies_may_be_used_from_inside_a_call() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    let held = exact::count();
    let short = exact::hold(Body::cuboid([0.0; 3], [1.0; 3]).unwrap(), vec![1, 2]).map_err(|e| e.to_string());
    assert_eq!(
        short,
        Err("keys: must be one for each face of the body, or none".to_owned())
    );
    assert_eq!(exact::count(), held);
    // a key is written on its face, which holds whole numbers below 2^52 (the ones JSON carries exactly)
    let wide = exact::hold(
        Body::cuboid([0.0; 3], [1.0; 3]).unwrap(),
        vec![7, 0, 1 << 52, 3, 2, 1],
    )
    .map_err(|e| e.to_string());
    assert_eq!(wide, Err("brep: keys: must be below 2^52".to_owned()));
    assert_eq!(exact::count(), held);

    let keys = vec![7, 0, (1 << 52) - 1, 3, 2, 1];
    let a = exact::hold(Body::cuboid([0.0; 3], [1.0; 3]).unwrap(), keys.clone()).unwrap();
    let listed: Vec<u64> = read(a).answer["faces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["key"].as_u64().unwrap())
        .collect();
    assert_eq!(listed, keys);
    let (answer, _) = raw(&json!({ "body": a }));
    assert_eq!(numbers(&answer["faces"]["keys"], Value::as_u64), keys);

    // inside `with`, other bodies can be held, read and freed, and so can this one: it lasts until the call returns
    let volume = exact::with(a, |outer| {
        assert_eq!(outer.keys, keys);
        let b = exact::hold(Body::sphere([0.0; 3], 1.0).unwrap(), Vec::new()).unwrap();
        let inner = exact::with(b, |inner| inner.body.volume().unwrap()).unwrap();
        assert!((inner - 4.0 / 3.0 * PI).abs() < 1e-5);
        assert!(exact::free(b));
        assert!(exact::free(a));
        assert_eq!(exact::with(a, |_| ()), None);
        outer.body.volume().unwrap()
    })
    .unwrap();
    assert!((volume - 1.0).abs() < 1e-9);
    assert_eq!(exact::count(), held);
}
