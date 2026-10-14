// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors

#![cfg(feature = "cad")]

use serde_json::{Value, json};
use sx_geom::{TriMesh, boolean::Solid, build, face};

fn stored(m: &TriMesh) -> TriMesh {
    TriMesh::from_stl(&m.to_stl("fixture"), "fixture").unwrap()
}

fn imported_plate() -> TriMesh {
    let plate = build::box_mesh([0.0; 3], [40.0, 30.0, 5.0]);
    let embossed = face::extrude(
        &face::FaceFrame::for_normal([20.0, 15.0, 5.0], [0.0, 0.0, 1.0]).unwrap(),
        &serde_json::from_value(json!({"type":"text","text":"BRIDGE","sizeMm":7})).unwrap(),
        &face::Placement::default(),
        None,
        &face::ExtrudeSpec {
            distance_mm: 0.8,
            operation: face::Operation::Join,
            ..Default::default()
        },
        Some(&plate),
    )
    .unwrap();
    stored(&embossed.mesh)
}

fn flat(m: &TriMesh) -> Value {
    json!({"positions":m.positions.iter().flatten().collect::<Vec<_>>(),
           "indices":m.triangles.iter().flatten().collect::<Vec<_>>()})
}

fn edit(
    mesh: Value,
    z: f64,
    operation: &str,
    width: f64,
    angle: f64,
    encoding: &str,
) -> sx_geom::Result<Value> {
    sx_geom::json::call_value(
        "shape.extrude",
        &json!({
            "target":{"mesh":mesh},
            "frame":{"origin":[20,15,z],"normal":[0,0,1],"u":[1,0,0],"v":[0,1,0]},
            "shape":{"type":"rectangle","widthMm":width,"heightMm":12},
            "placement":{"rotationDeg":angle},
            "spec":{"operation":operation,"distanceMm":5},
            "meshOutput":encoding
        }),
        &|_| unreachable!("fixture has no external files"),
    )
}

#[test]
fn rotated_cut_on_imported_embossed_plate_refuses_storage_damage() {
    let imported = imported_plate();
    assert!(!Solid::new(&imported).unwrap().self_intersects());
    let joined = edit(flat(&imported), 5.0, "join", 20.0, 17.0, "flat").unwrap();
    for encoding in ["flat", "stlBase64", "raw"] {
        let result = edit(joined["mesh"].clone(), 10.0, "cut", 10.0, 17.0, encoding);
        assert!(result.is_err(), "cut must not return intersecting stored faces");
        let error = result
            .expect_err("cut must not return intersecting stored faces")
            .to_string();
        assert!(error.contains("mesh storage precision"), "{error}");
        assert!(error.contains("intersecting faces"), "{error}");
        assert!(sx_geom::json::take_out_files().is_empty());
    }
}

#[test]
fn aligned_cut_on_imported_embossed_plate_remains_available() {
    let joined = edit(flat(&imported_plate()), 5.0, "join", 20.0, 0.0, "flat").unwrap();
    let cut = edit(joined["mesh"].clone(), 10.0, "cut", 10.0, 0.0, "flat").unwrap();
    let crossing = sx_geom::json::call_value(
        "import.selfIntersections",
        &json!({
            "mesh":cut["mesh"],"rebuildMaxTriangles":0
        }),
        &|_| unreachable!("fixture has no external files"),
    )
    .unwrap();
    assert_eq!(crossing["crossing"], false, "{crossing}");
    assert_eq!(cut["report"]["watertight"], true);
}

#[test]
fn deliberate_disconnected_cut_pieces_are_retained() {
    let plate = build::box_mesh([0.0, 9.0, 0.0], [40.0, 21.0, 5.0]);
    let cut = edit(flat(&plate), 5.0, "cut", 2.0, 0.0, "flat").unwrap();
    assert_eq!(cut["shells"], 2);
    assert_eq!(cut["watertight"], true);
    assert!((cut["volumeMm3"].as_f64().unwrap() - 2280.0).abs() < 1e-6);
}
