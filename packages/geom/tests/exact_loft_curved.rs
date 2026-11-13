// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A loft through one whole circle or ellipse on every profile as an exact solid: its three faces, held to its drawing
// at every profile, how far it is from the mesh loft and from the true circles and ellipses, its faces' keys, the
// op's reply beside the mesh loft's, and the profiles still refused. Empty without the brep feature, so a workspace
// test run that names every test target passes over it.
#![cfg(feature = "brep")]
#[allow(
    dead_code,
    reason = "each test file uses its own share of what they have in common"
)]
mod common;

use common::{farthest_from, mesh_loft_keeps_corners, rounded, sha256};
use serde_json::{Value, json};
use std::f64::consts::TAU;
use std::fmt::Write as _;
use sx_brep::{Surface, Tessellation};
use sx_geom::exact as table;
use sx_geom::face::{self, Operation};
use sx_geom::faces;
use sx_geom::fm::Fm;
use sx_geom::mesh::TriMesh;
use sx_geom::sketch_loft::exact::{self, Kind, Part};
use sx_geom::sketch_loft::{self, Curve, Density, Options, Profile};
use sx_geom::vec3::{self, V3};

/// Two lofts through ellipses as an app sends them: five stations lofted smooth, and two lofted straight.
fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/exact-loft-curved.json")).unwrap()
}

fn level(z: f64, lp: &Value) -> Value {
    json!({
        "frame": { "origin": [0, 0, z], "normal": [0, 0, 1], "u": [1, 0, 0], "v": [0, 1, 0] },
        "loops": [lp],
    })
}

fn circle(d: f64) -> Value {
    json!({ "type": "circle", "center": [0, 0], "diameterMm": d })
}

fn ellipse(w: f64, h: f64) -> Value {
    json!({ "type": "ellipse", "center": [0, 0], "widthMm": w, "heightMm": h, "angleDeg": 0 })
}

/// The lofts made exact here: the fixture's two, and two of plain circles.
fn cases() -> Vec<(&'static str, Value)> {
    let f = fixture();
    vec![
        ("smooth, five ellipses", f["smoothFiveEllipses"].clone()),
        ("straight, two ellipses", f["ruledTwoEllipses"].clone()),
        (
            "straight, circle to circle",
            json!({ "profiles": [level(0.0, &circle(20.0)), level(20.0, &circle(24.0))] }),
        ),
        (
            "smooth, circle to ellipse to circle",
            json!({
                "profiles": [level(0.0, &circle(20.0)), level(10.0, &ellipse(26.0, 18.0)), level(20.0, &circle(16.0))],
                "smooth": true,
            }),
        ),
    ]
}

fn parsed(request: &Value) -> (Vec<Profile>, Options) {
    let opts = json!({ "smooth": request["smooth"].as_bool().unwrap_or(false) });
    (
        serde_json::from_value(request["profiles"].clone()).unwrap(),
        serde_json::from_value(opts).unwrap(),
    )
}

/// A profile's circle or ellipse where it lies.
struct Section {
    origin: V3,
    u: V3,
    v: V3,
    center: [f64; 2],
    half: [f64; 2],
    turn: f64,
}

fn section(profile: &Value) -> Section {
    let v3 = |x: &Value| -> V3 { [0, 1, 2].map(|k| x[k].as_f64().unwrap()) };
    let f = &profile["frame"];
    let l = &profile["loops"][0];
    let half = if l["type"] == "circle" {
        let r = l["diameterMm"].as_f64().unwrap() / 2.0;
        [r, r]
    } else {
        [
            l["widthMm"].as_f64().unwrap() / 2.0,
            l["heightMm"].as_f64().unwrap() / 2.0,
        ]
    };
    Section {
        origin: v3(&f["origin"]),
        u: v3(&f["u"]),
        v: v3(&f["v"]),
        center: [l["center"][0].as_f64().unwrap(), l["center"][1].as_f64().unwrap()],
        half,
        turn: l["angleDeg"].as_f64().unwrap_or(0.0).to_radians(),
    }
}

/// The straight loft between two sections as it truly is: the straight line from each point of one true curve to the
/// point of the next at the same parameter, as triangles, `around` points around and `along` steps between.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "point numbers and steps of a small grid"
)]
fn ruled_between(sections: &[Section], around: usize, along: usize) -> (Vec<V3>, Vec<[u32; 3]>) {
    let mut positions = Vec::new();
    let mut triangles = Vec::new();
    for pair in sections.windows(2) {
        let (a, b) = (true_points(&pair[0], around), true_points(&pair[1], around));
        let base = positions.len();
        for step in 0..=along {
            let s = step as f64 / along as f64;
            positions.extend(
                a.iter()
                    .zip(&b)
                    .map(|(&p, &q)| vec3::add(p, vec3::scale(vec3::sub(q, p), s))),
            );
        }
        let at = |step: usize, k: usize| (base + step * around + k % around) as u32;
        for step in 0..along {
            for k in 0..around {
                triangles.push([at(step, k), at(step, k + 1), at(step + 1, k + 1)]);
                triangles.push([at(step, k), at(step + 1, k + 1), at(step + 1, k)]);
            }
        }
    }
    (positions, triangles)
}

/// How far the mesh loft of a smooth circle to ellipse to circle is from its exact body, as measured on 2026-11-13: the
/// largest of its points, at z 5.25, where the two smooth interpolations part between the stations.
const KNOWN_SMOOTH_PATH_DIFFERENCE_MM: f64 = 0.115_782_456;
/// The same difference the other way, as measured: how far the body's points are from that mesh loft.
const KNOWN_SMOOTH_PATH_DIFFERENCE_BODY_MM: f64 = 0.115_686_026;

/// Points on a profile's true circle or ellipse, in space, `count` of them evenly by angle.
#[allow(clippy::cast_precision_loss, reason = "a point count")]
fn true_points(s: &Section, count: usize) -> Vec<V3> {
    let (st, ct) = s.turn.m_sin_cos();
    (0..count)
        .map(|k| {
            let t = std::f64::consts::TAU * k as f64 / count as f64;
            let (x, y) = (s.half[0] * t.m_cos(), s.half[1] * t.m_sin());
            let (x, y) = (s.center[0] + ct * x - st * y, s.center[1] + st * x + ct * y);
            vec3::add(s.origin, vec3::add(vec3::scale(s.u, x), vec3::scale(s.v, y)))
        })
        .collect()
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "one walk through each case's checks reads best in one place"
)]
fn one_whole_circle_or_ellipse_on_every_profile_lofts_to_three_exact_faces_held_to_the_drawing() {
    if !sx_brep::KERNEL {
        return;
    }
    let start = table::count();
    let mut report = String::new();
    for (name, request) in cases() {
        let (profiles, opts) = parsed(&request);
        let lofted = exact::lofted_through(&profiles, &opts, &Density::default(), exact::MOST_DOUBLINGS)
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        let rails = &lofted.rails;
        assert_eq!(rails.pieces.len(), 1, "{name}");
        assert_eq!(rails.pieces[0].stretches, rails.rails.len(), "{name}");
        // one skinned side all the way around and two flat ends
        let mut faces: Vec<(Part, Kind)> = lofted
            .parts
            .iter()
            .copied()
            .zip(lofted.kinds.iter().copied())
            .collect();
        faces.sort_by_key(|(p, _)| match p {
            Part::Side(k) => *k,
            Part::First => 1000,
            Part::Last => 1001,
        });
        assert_eq!(
            faces,
            [
                (Part::Side(0), Kind::Skinned),
                (Part::First, Kind::Flat),
                (Part::Last, Kind::Flat)
            ],
            "{name}"
        );
        // its ends are the curves the kernel's own side ends on, so the join moves no edge: the rim the stitch once
        // closed 5e-4 mm off is now on the curves given to rounding, or the loft is refused
        let largest = rails
            .rings
            .iter()
            .flat_map(|r| r.points.iter().flatten())
            .fold(1.0f64, |m, c| m.max(c.abs()));
        assert!(lofted.off_mm <= 1e-9 * largest, "{name}: {:e} mm", lofted.off_mm);
        assert!(
            lofted.drawn_mm <= sx_brep::DRAWN_MM,
            "{name}: {} mm",
            lofted.drawn_mm
        );
        let shown = lofted.body.tessellate(&Tessellation::default()).expect("a mesh");
        // the kernel's own triangles, fine enough to measure to a hundredth of a millimeter, checked by their volume.
        // They are for measuring only and not held to their chord
        let close = lofted
            .body
            .tessellate_as_made(&Tessellation {
                chord_mm: 1e-4,
                max_edge_mm: 0.25,
                ..Tessellation::default()
            })
            .expect("a fine mesh");
        let volume = lofted.body.volume().expect("volume");
        let tessellated: f64 = close
            .triangles
            .iter()
            .map(|t| {
                let [a, b, c] = t.map(|v| close.positions[v as usize]);
                vec3::dot(a, vec3::cross(b, c)) / 6.0
            })
            .sum();
        assert!(
            (tessellated - volume).abs() <= 1e-4 * volume,
            "{name}: {tessellated} against {volume}"
        );
        assert!(shown.normals.iter().all(Option::is_some), "{name}");
        let side = shown
            .surfaces
            .iter()
            .position(|s| matches!(s, Surface::Spline))
            .expect("a spline side");
        for m in [&shown, &close] {
            let seams: Vec<_> = m.edges.iter().filter(|e| e.faces[0] == e.faces[1]).collect();
            assert_eq!(seams.len(), 1, "{name}");
            assert_eq!(seams[0].faces[0] as usize, side, "{name}");
        }
        // every profile's true circle or ellipse within 0.01 mm of the body
        let sections: Vec<Section> = request["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .map(section)
            .collect();
        let mut to_drawing = 0.0f64;
        for (k, s) in sections.iter().enumerate() {
            let off = farthest_from(&true_points(s, 2048), &close.positions, &close.triangles, 0.5);
            assert!(
                off <= sx_brep::DRAWN_MM,
                "{name}: profile {} is {off} mm off the body",
                k + 1
            );
            to_drawing = to_drawing.max(off);
        }
        // and, a loft that keeps no corners, near the mesh loft: the mesh loft's points within 0.01 mm of the body
        assert!(mesh_loft_keeps_corners(&request["profiles"]), "{name}");
        let mesh = sketch_loft::loft_with(&profiles, &opts).unwrap();
        // the mesh loft meets the drawn sections within 0.01 mm too
        for (k, s) in sections.iter().enumerate() {
            let off = farthest_from(&true_points(s, 2048), &mesh.positions, &mesh.triangles, 0.5);
            assert!(
                off <= sx_brep::DRAWN_MM,
                "{name}: profile {} is {off} mm off the mesh loft",
                k + 1
            );
        }
        let back = farthest_from(&mesh.positions, &close.positions, &close.triangles, 0.5);
        let record = name == "smooth, circle to ellipse to circle";
        if record {
            // a record: the body and the mesh loft both meet the drawn sections within 0.01 mm, as above; between
            // the stations nothing was drawn, and there the two smooth interpolations take different paths. The
            // difference is kept as measured, and this fails if it moves
            assert!(
                (back - KNOWN_SMOOTH_PATH_DIFFERENCE_MM).abs() <= 1e-6,
                "{name}: the known difference is no longer {KNOWN_SMOOTH_PATH_DIFFERENCE_MM} mm but {back} mm"
            );
        } else {
            assert!(back <= 0.01, "{name}: the mesh loft is {back:e} mm off the body");
        }
        let out = if request["smooth"].as_bool().unwrap_or(false) {
            // a smooth loft's body within 0.01 mm of the mesh loft, but for the record above, kept as measured
            let out = farthest_from(&close.positions, &mesh.positions, &mesh.triangles, 0.5);
            if record {
                assert!(
                    (out - KNOWN_SMOOTH_PATH_DIFFERENCE_BODY_MM).abs() <= 1e-6,
                    "{name}: the known difference is no longer {KNOWN_SMOOTH_PATH_DIFFERENCE_BODY_MM} mm but {out} mm"
                );
            } else {
                assert!(out <= 0.01, "{name}: the body is {out:e} mm off the mesh loft");
            }
            format!("body to mesh loft {out:.6} mm")
        } else {
            // a straight loft is the ruled surface between the true sections, the straight line between their points
            // at the same parameter, and the body is held to that both ways. Not to the mesh loft: between a 20 and a
            // 24 mm circle the mesh loft lies up to 0.073 mm inside the true cone at mid-height, by its own facets
            let (ruled, strips) = ruled_between(&sections, 2048, 64);
            let side_points: Vec<V3> = close
                .triangles
                .iter()
                .zip(&close.faces)
                .filter(|&(_, &f)| f as usize == side)
                .flat_map(|(t, _)| t.map(|v| close.positions[v as usize]))
                .collect();
            let to = farthest_from(&side_points, &ruled, &strips, 0.5);
            let from = farthest_from(&ruled, &close.positions, &close.triangles, 0.5);
            assert!(
                to <= sx_brep::DRAWN_MM && from <= sx_brep::DRAWN_MM,
                "{name}: {to:e} and {from:e} mm"
            );
            format!("body to the true ruled surface {to:.6} mm, the true ruled surface to body {from:.6} mm")
        };
        println!(
            "DIST {name}: {out}, mesh loft to body {back:.6} mm, true sections to body {to_drawing:.6} mm"
        );
        // the volume within 0.2 percent of the true frustum where there is one, else of the mesh loft's
        let mesh_volume: f64 = mesh
            .triangles
            .iter()
            .map(|t| {
                let [a, b, c] = t.map(|v| mesh.positions[v as usize]);
                vec3::dot(a, vec3::cross(b, c)) / 6.0
            })
            .sum();
        let want = if name == "straight, circle to circle" {
            // a cone cut between radii 10 and 12, 20 high
            std::f64::consts::PI * 20.0 / 3.0 * (100.0 + 120.0 + 144.0)
        } else {
            mesh_volume
        };
        let share = (volume - want) / want;
        assert!(share.abs() < 0.002, "{name}: volume {volume} against {want}");
        writeln!(
            report,
            "DIST {name}: {} rails after {} doublings, edges {:e} mm, drawing {:e} mm by read-back and {to_drawing:.6} mm \
             by tessellation, {out}, mesh loft to body {back:.6} mm, volume {volume:.6} against \
             {want:.6} mm3 ({:+.4} percent)",
            rails.rails.len(),
            lofted.doublings,
            lofted.off_mm,
            lofted.drawn_mm,
            share * 100.0,
        )
        .unwrap();
    }
    print!("{report}");
    assert_eq!(table::count(), start);
}

// A straight loft from one circle to a larger one is a cone between them, but it is made as a skinned side, and the
// face table sorts it among the five kinds by what the kernel calls it: a later step that looks for a cone (a fillet,
// a hole by its face) sees a spline face, "other" in the table.
#[test]
fn a_straight_loft_from_circle_to_circle_has_a_spline_side_not_a_cone() {
    if !sx_brep::KERNEL {
        return;
    }
    let request =
        json!({ "profiles": [level(0.0, &circle(20.0)), level(20.0, &circle(24.0))], "exact": true });
    let reply: Value = serde_json::from_str(&op("sketch.loft", &request)).unwrap();
    let body = reply["body"].as_u64().expect("a body");
    let mesh: Value = serde_json::from_str(&op("brep.tessellate", &json!({ "body": body }))).unwrap();
    let kernel_kinds: Vec<&str> = mesh["surfaces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["kind"].as_str().unwrap())
        .collect();
    let table_kinds: Vec<&str> = mesh["faces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["surface"]["kind"].as_str().unwrap())
        .collect();
    println!("KINDS circle to circle: kernel {kernel_kinds:?}, face table {table_kinds:?}");
    let mut sorted_kernel = kernel_kinds.clone();
    sorted_kernel.sort_unstable();
    assert_eq!(sorted_kernel, ["plane", "plane", "spline"]);
    // as it is today: the side is "other" in the face table, not a cone or a cylinder (a known gap)
    let mut sorted_table = table_kinds.clone();
    sorted_table.sort_unstable();
    assert_eq!(sorted_table, ["other", "plane", "plane"]);
    assert_eq!(op("brep.free", &json!({ "body": body })), "{\"freed\":true}");
}

/// The mesh loft's reply for each case, held to the bytes the code before whole circles and ellipses were made
/// exact gave: SHA-256 of the reply, recorded from it.
const MESH_REPLIES: [(&str, &str); 4] = [
    (
        "smooth, five ellipses",
        "79058c7ca11c121b0e65227fadaea39c732ccbe55d0dc38c0438462a3245296f",
    ),
    (
        "straight, two ellipses",
        "6602d77c33d8aa330f757e65c325f6e33e4ecff575f3bbb864913ca4d6d4006c",
    ),
    (
        "straight, circle to circle",
        "288e17d5cb7bd9e539dff3a6f86c302c2c7437097ee277de50d291b5e9670760",
    ),
    (
        "smooth, circle to ellipse to circle",
        "5574b2746942fa2772cf8ee373dc868fe1a97c8f821cb6986b7591b106c4b96e",
    ),
];

#[test]
fn the_mesh_loft_of_circles_and_ellipses_is_the_same_to_the_byte() {
    for ((name, request), (named, want)) in cases().into_iter().zip(MESH_REPLIES) {
        assert_eq!(name, named);
        let reply = sx_geom::json::call("sketch.loft", &request.to_string()).unwrap();
        assert_eq!(sha256(reply.as_bytes()), want, "{name}");
    }
}

/// The plane each face of a body lies in, as a unit normal and its offset; none for a face not in one plane.
fn planes(mesh: &sx_brep::Mesh) -> Vec<Option<(V3, f64)>> {
    let mut found: Vec<Option<(V3, f64)>> = vec![None; mesh.surfaces.len()];
    let mut flat = vec![true; mesh.surfaces.len()];
    for (triangle, &face) in mesh.triangles.iter().zip(&mesh.faces) {
        let face = face as usize;
        let corners = triangle.map(|v| mesh.positions[v as usize]);
        let [a, b, c] = corners;
        if found[face].is_none() {
            found[face] = vec3::normalize(vec3::cross(vec3::sub(b, a), vec3::sub(c, a)))
                .map(|normal| (normal, vec3::dot(normal, a)));
        }
        let on = found[face].is_some_and(|(normal, offset)| {
            corners
                .iter()
                .all(|&p| (vec3::dot(normal, p) - offset).abs() < 1e-9)
        });
        flat[face] = flat[face] && on;
    }
    found
        .into_iter()
        .zip(flat)
        .map(|(plane, flat)| plane.filter(|_| flat))
        .collect()
}

/// The key of the mesh's face on this plane.
fn key_on(mesh: &TriMesh, plane: (V3, f64)) -> Option<u64> {
    let f = mesh.faces.as_ref()?;
    let at = f.table.iter().position(|s| match *s {
        faces::Surface::Plane { normal, offset } => {
            vec3::len(vec3::sub(normal, plane.0)) < 1e-9 && (offset - plane.1).abs() < 1e-9
        }
        _ => false,
    })?;
    f.keys.get(at).copied()
}

#[test]
fn the_ends_take_the_mesh_loft_s_keys_and_the_side_its_own() {
    if !sx_brep::KERNEL {
        return;
    }
    let start = table::count();
    for (name, request) in cases() {
        let (profiles, opts) = parsed(&request);
        let step = Some(0x5eed_1234);
        let alone = faces::with_key_salt(step, || {
            let mesh = sketch_loft::loft_with(&profiles, &opts).unwrap();
            face::apply(mesh, Operation::New, None).unwrap()
        });
        let (handle, beside) = faces::with_key_salt(step, || {
            let mut mesh = sketch_loft::loft_with(&profiles, &opts).unwrap();
            let handle = exact::hold_through(&profiles, &opts, &mut mesh).unwrap();
            (handle, face::apply(mesh, Operation::New, None).unwrap())
        });
        // the mesh loft's own answer does not change: the same points, triangles, faces and keys
        assert_eq!(beside.mesh, alone.mesh, "{name}");
        let mesh = alone.mesh;
        let (planes, keys) = table::with(handle, |held| {
            (
                planes(&held.body.tessellate(&Tessellation::default()).unwrap()),
                held.keys.clone(),
            )
        })
        .expect("held");
        assert!(table::free(handle));
        assert_eq!(keys.len(), 3, "{name}");
        assert!(keys.iter().all(|&k| k != 0), "{name}");
        let mut each = keys.clone();
        each.sort_unstable();
        each.dedup();
        assert_eq!(each.len(), 3, "{name}: every face has a key of its own");
        let mesh_keys = &mesh.faces.as_ref().unwrap().keys;
        let mut ends = 0;
        for (plane, key) in planes.iter().zip(&keys) {
            match plane {
                Some(plane) => {
                    assert_eq!(key_on(&mesh, *plane), Some(*key), "{name}: {plane:?}");
                    ends += 1;
                }
                // the mesh loft's side is cut into many faces, none of them the whole side
                None => assert!(!mesh_keys.contains(key), "{name}"),
            }
        }
        assert_eq!(ends, 2, "{name}");
    }
    assert_eq!(table::count(), start);
}

// ---- the op: sketch.loft asked to be exact

fn op(name: &str, request: &Value) -> String {
    sx_geom::json::call(name, &request.to_string()).unwrap_or_else(|e| panic!("{name}: {e}"))
}

/// A reply's text with one of its fields taken out, comma and all.
fn without(reply: &str, field: &str) -> String {
    let (with_next, with_last) = (format!("{field},"), format!(",{field}"));
    assert!(reply.contains(field), "no {field} in the reply");
    if reply.contains(&with_next) {
        reply.replacen(&with_next, "", 1)
    } else {
        reply.replacen(&with_last, "", 1)
    }
}

/// The text of one field of a reply as the reply prints it.
fn printed(reply: &Value, key: &str) -> String {
    format!("\"{key}\":{}", reply[key])
}

#[test]
fn the_reply_is_the_mesh_loft_s_own_byte_for_byte_plus_the_body() {
    if !sx_brep::KERNEL {
        return;
    }
    let start = table::count();
    for (name, mut request) in cases() {
        for keyed in [true, false] {
            request["withFaces"] = json!(true);
            if keyed {
                request["keySalt"] = json!(77);
            } else if let Some(o) = request.as_object_mut() {
                o.remove("keySalt");
            }
            if let Some(o) = request.as_object_mut() {
                o.remove("exact");
                o.remove("save");
            }
            let plain = op("sketch.loft", &request);
            request["exact"] = json!(true);
            let asked = op("sketch.loft", &request);
            let reply: Value = serde_json::from_str(&asked).unwrap();
            let handle = reply["body"]
                .as_u64()
                .unwrap_or_else(|| panic!("{name}: {asked:.300}"));
            assert!(
                u32::try_from(handle).is_ok_and(|h| table::with(h, |_| ()).is_some()),
                "{name}"
            );
            let keys = reply["bodyKeys"].as_array().expect("its keys");
            assert_eq!(keys.len(), if keyed { 3 } else { 0 }, "{name}");
            let rest = without(
                &without(&asked, &printed(&reply, "body")),
                &printed(&reply, "bodyKeys"),
            );
            assert_eq!(rest, plain, "{name}, keyed {keyed}");
            assert_eq!(op("brep.free", &json!({ "body": handle })), "{\"freed\":true}");
            // asked as text: the same reply with the solid's text, nothing left in the table
            request["save"] = json!(true);
            let texted = op("sketch.loft", &request);
            let reply: Value = serde_json::from_str(&texted).unwrap();
            assert!(reply["bodySmb"].is_string(), "{name}");
            assert_eq!(
                without(&texted, &printed(&reply, "bodySmb")),
                plain,
                "{name}, keyed {keyed}"
            );
            assert_eq!(table::count(), start);
        }
    }
}

/// Six circles around a ring of radius 40 about z, each on the plane through the axis.
fn ring_of_circles() -> Value {
    let stations: Vec<Value> = (0_u8..6)
        .map(|k| {
            let (s, c) = (std::f64::consts::TAU * f64::from(k) / 6.0).m_sin_cos();
            json!({
                "frame": { "origin": [40.0 * c, 40.0 * s, 0], "normal": [-s, c, 0], "u": [c, s, 0], "v": [0, 0, 1] },
                "loops": [circle(12.0)],
            })
        })
        .collect();
    Value::Array(stations)
}

#[test]
fn profiles_this_does_not_cover_answer_as_before_and_say_what_is_covered() {
    if !sx_brep::KERNEL {
        return;
    }
    let start = table::count();
    let covered = "An exact loft is made only through profiles of straight lines and splines, or one whole circle or ellipse on every profile, for now; these have arcs.";
    let square = json!({ "points": [[-10, -10], [10, -10], [10, 10], [-10, 10]] });
    let cases = [
        (
            json!({ "profiles": [level(0.0, &rounded(40.0, 24.0, 6.0)), level(20.0, &rounded(30.0, 20.0, 4.0))] }),
            covered.to_string(),
        ),
        (
            json!({ "profiles": [level(0.0, &circle(20.0)), level(20.0, &square)], "smooth": true }),
            covered.to_string(),
        ),
        (
            json!({ "profiles": ring_of_circles(), "closed": true }),
            "A closed loft through circles or ellipses is not made exact yet.".to_string(),
        ),
    ];
    for (mut request, why) in cases {
        let plain = op("sketch.loft", &request);
        request["exact"] = json!(true);
        let asked = op("sketch.loft", &request);
        let reply: Value = serde_json::from_str(&asked).unwrap();
        assert_eq!(reply["exact"], json!({ "made": false, "why": why }));
        assert!(reply.get("body").is_none() && reply.get("bodySmb").is_none());
        assert_eq!(without(&asked, &printed(&reply, "exact")), plain);
    }
    assert_eq!(table::count(), start);
}

// A circle or ellipse is measured against as drawn through cubic arcs, a span to each 32nd of a turn: each span's
// points stay within a ten millionth of a millimeter of the true curve on these, and it starts and ends on the
// curve's own points.
/// A curve, its center, its half axes, its turn and where it starts.
type ArcCase = (Curve, [f64; 2], [f64; 2], f64, f64);

#[test]
fn a_whole_circle_or_ellipse_is_drawn_as_cubic_arcs_on_the_true_curve() {
    let cases: [ArcCase; 2] = [
        (
            Curve::Arc {
                center: [1.0, 2.0],
                radius: 13.0,
                from: 0.3,
                sweep: TAU,
            },
            [1.0, 2.0],
            [13.0, 13.0],
            0.0,
            0.3,
        ),
        (
            Curve::Ellipse {
                center: [-2.0, 0.5],
                half_width: 13.0,
                half_height: 9.0,
                turn: 0.4,
                from: 0.0,
                sweep: -TAU,
            },
            [-2.0, 0.5],
            [13.0, 9.0],
            0.4,
            0.0,
        ),
    ];
    for (curve, center, [wide, high], turn, from) in cases {
        let spans = curve.drawn_spans().expect("its spans");
        assert_eq!(spans.len(), 32, "{curve:?}");
        let (st, ct) = turn.m_sin_cos();
        let start = [
            center[0] + ct * wide * from.m_cos() - st * high * from.m_sin(),
            center[1] + st * wide * from.m_cos() + ct * high * from.m_sin(),
        ];
        assert!((spans[0][0][0] - start[0]).abs() < 1e-12 && (spans[0][0][1] - start[1]).abs() < 1e-12);
        let (end, first) = (spans[31][3], spans[0][0]);
        assert!(
            (end[0] - first[0]).m_hypot(end[1] - first[1]) < 1e-12,
            "{curve:?}: it closes on itself"
        );
        let mut worst = 0.0f64;
        for span in &spans {
            for step in 0..=100 {
                let along = f64::from(step) / 100.0;
                let rest = 1.0 - along;
                let weights = [
                    rest * rest * rest,
                    3.0 * rest * rest * along,
                    3.0 * rest * along * along,
                    along * along * along,
                ];
                let point = [0, 1].map(|axis| (0..4).map(|j| weights[j] * span[j][axis]).sum::<f64>());
                // back onto the unit circle: how far out or in it is, as a share, times the larger half axis
                let (dx, dy) = (point[0] - center[0], point[1] - center[1]);
                let (across, up) = ((ct * dx + st * dy) / wide, (ct * dy - st * dx) / high);
                worst = worst.max((across.m_hypot(up) - 1.0).abs() * wide.max(high));
            }
        }
        println!("ARCS {curve:?}: {worst:e} mm off the true curve");
        assert!(worst <= 1e-7, "{curve:?}: {worst:e}");
    }
}
