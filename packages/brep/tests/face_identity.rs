// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// stored face keys must resolve uniquely before an edit.
#![cfg(sx_brep_kernel)]
use serde_json::{Value, json};

fn call(op: &str, request: &Value) -> Value {
    serde_json::from_str(&sx_brep::call(op, &request.to_string()).expect("kernel call")).unwrap()
}

#[test]
fn missing_face_key_does_not_pick_the_face_at_the_old_point() {
    let b = call("box", &json!({"min": [0,0,0], "max": [20,20,20], "keySalt": 71}))["body"]
        .as_u64()
        .unwrap();
    let mesh = call("tessellate", &json!({"body": b}));
    let absent = mesh["faces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["key"].as_u64().unwrap())
        .max()
        .unwrap()
        + 1;
    let result = sx_brep::call(
        "push",
        &json!({"body": b, "at": [5,5,20], "normal": [0,0,1], "distanceMm": 1, "faceKey": absent})
            .to_string(),
    );
    let error = result.expect_err("a missing key must stop for repair instead of selecting another face");
    assert!(
        error.starts_with("faceReference:") && error.contains("repair"),
        "{error}"
    );
    call("free", &json!({"body": b}));
}

#[test]
fn split_face_key_does_not_choose_a_fragment_even_under_the_old_point() {
    let b = call("box", &json!({"min": [0,0,0], "max": [20,20,20], "keySalt": 71}))["body"]
        .as_u64()
        .unwrap();
    let mesh = call("tessellate", &json!({"body": b}));
    let top = mesh["faces"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["surface"]["normal"][2].as_f64() == Some(1.0))
        .unwrap()["key"]
        .as_u64()
        .unwrap();
    let tool = call("box", &json!({"min": [6,-1,17], "max": [8,21,21], "keySalt": 72}))["body"]
        .as_u64()
        .unwrap();
    let split = call(
        "boolean",
        &json!({"op": "difference", "a": b, "b": tool, "keySalt": 73}),
    )["body"]
        .as_u64()
        .unwrap();
    let faces = call("tessellate", &json!({"body": split}));
    assert_eq!(
        faces["faces"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|f| f["key"].as_u64() == Some(top))
            .count(),
        2
    );
    let result = sx_brep::call(
        "push",
        &json!({"body": split, "at": [5,5,20], "normal": [0,0,1], "distanceMm": 1, "faceKey": top})
            .to_string(),
    );
    let error = result.expect_err("a split key must stop for repair instead of selecting a fragment");
    assert!(
        error.starts_with("faceReference:") && error.contains("repair"),
        "{error}"
    );
    let front = mesh["faces"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["surface"]["normal"][1].as_f64() == Some(-1.0))
        .unwrap()["key"]
        .as_u64()
        .unwrap();
    let error = sx_brep::call("chamfer", &json!({"body": split, "edges": [{"a": [0,0,20], "b": [6,0,20], "face": [0,0,1], "keys": [top,front]}], "distanceMm": 1}).to_string()).unwrap_err();
    assert!(
        error.starts_with("faceReference:") && error.contains("split") && error.contains("repair"),
        "{error}"
    );
    for body in [split, tool, b] {
        call("free", &json!({"body": body}));
    }
}

#[test]
fn a_face_a_union_clears_the_key_of_keeps_it_as_where_it_came_from_and_still_asks_for_repair() {
    let body = |r: Value| r["body"].as_u64().unwrap();
    let block = body(call(
        "box",
        &json!({"min": [0,0,0], "max": [30,10,4], "keySalt": 71}),
    ));
    let post = body(call(
        "box",
        &json!({"min": [10,2,3], "max": [20,8,8], "keySalt": 72}),
    ));
    // a rim on the block whose sides lie in the block's planes and meet them along its top edges
    let rim = body(call(
        "box",
        &json!({"min": [5,0,4], "max": [25,10,5], "keySalt": 73}),
    ));
    // the key and where it came from of each face facing -y, in order
    let fronts = |b: &Value| {
        let mut out: Vec<(u64, u64)> = call("tessellate", &json!({"body": b}))["faces"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|f| f["surface"]["normal"][1].as_f64() == Some(-1.0))
            .map(|f| (f["key"].as_u64().unwrap(), f["from"].as_u64().unwrap_or(0)))
            .collect();
        out.sort_unstable();
        out
    };
    let [(block_front, 0)] = fronts(&json!(block))[..] else {
        panic!("one keyed front")
    };
    let [(rim_front, 0)] = fronts(&json!(rim))[..] else {
        panic!("one keyed rim front")
    };
    let [(post_front, 0)] = fronts(&json!(post))[..] else {
        panic!("one keyed post front")
    };
    let up = body(call(
        "boolean",
        &json!({"op": "union", "a": block, "b": post, "keySalt": 74}),
    ));
    let joined = body(call(
        "boolean",
        &json!({"op": "union", "a": up, "b": rim, "keySalt": 75}),
    ));
    // the block's and the rim's fronts meet, so the kernel merges them into one face, which keeps the block's key as
    // where it came from; the post's front, 2 mm in, lies in no other plane and keeps its key
    assert_ne!(block_front, rim_front);
    let mut want = vec![(0, block_front), (post_front, 0)];
    want.sort_unstable();
    assert_eq!(fronts(&json!(joined)), want);
    // saved and read back, the faces still say where they came from
    let smb = call("save", &json!({"body": joined}))["smb"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        smb.contains("\n//sx-brep from "),
        "{}",
        &smb[smb.len().saturating_sub(200)..]
    );
    assert_eq!(fronts(&json!({"smb": smb})), want);
    // the old key names no face now: a push by it stops for repair
    let error = sx_brep::call(
        "push",
        &json!({"body": joined, "at": [15,0,2], "normal": [0,-1,0], "distanceMm": 1, "faceKey": block_front})
            .to_string(),
    )
    .expect_err("a cleared key must stop for repair");
    assert!(
        error.starts_with("faceReference:") && error.contains("repair"),
        "{error}"
    );
    for b in [joined, up, rim, post, block] {
        call("free", &json!({"body": b}));
    }
}

#[test]
fn missing_edge_face_keys_report_identity_repair_instead_of_mesh_fallback() {
    let b = call("box", &json!({"min": [0,0,0], "max": [20,20,20], "keySalt": 71}))["body"]
        .as_u64()
        .unwrap();
    let error = sx_brep::call("chamfer", &json!({"body": b, "edges": [{"a": [20,20,0], "b": [20,20,20], "face": [1,0,0], "keys": [1,2]}], "distanceMm": 1}).to_string()).unwrap_err();
    assert!(
        error.starts_with("faceReference:") && error.contains("missing") && error.contains("repair"),
        "{error}"
    );
    call("free", &json!({"body": b}));
}

#[test]
fn invalid_edge_keys_require_repair() {
    let b = call("box", &json!({"min": [0,0,0], "max": [20,20,20], "keySalt": 71}))["body"]
        .as_u64()
        .unwrap();
    for keys in [
        json!(null),
        json!([]),
        json!([1]),
        json!([0, 2]),
        json!([-1, 2]),
        json!([1.5, 2]),
        json!(["1", 2]),
        json!([4_503_599_627_370_496_u64, 2]),
    ] {
        let error = sx_brep::call("chamfer", &json!({"body": b, "edges": [{"a": [20,20,0], "b": [20,20,20], "face": [1,0,0], "keys": keys}], "distanceMm": 1}).to_string()).unwrap_err();
        assert!(
            error.starts_with("faceReference:") && error.contains("invalid") && error.contains("repair"),
            "{error}"
        );
    }
    call("free", &json!({"body": b}));
}

// the key of the face of `body` that faces along `normal`, from a body that has one such face
fn key_facing(body: u64, normal: [f64; 3]) -> u64 {
    let mesh = call("tessellate", &json!({"body": body}));
    let faces: Vec<&Value> = mesh["faces"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| (0..3).all(|k| f["surface"]["normal"][k].as_f64() == Some(normal[k])))
        .collect();
    assert_eq!(faces.len(), 1, "{normal:?}");
    faces[0]["key"].as_u64().unwrap()
}

fn keys_of(body: u64) -> Vec<u64> {
    call("tessellate", &json!({"body": body}))["faces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["key"].as_u64().unwrap())
        .collect()
}

fn join(a: u64, b: u64, salt: u64) -> u64 {
    call(
        "boolean",
        &json!({"op": "union", "a": a, "b": b, "keySalt": salt}),
    )["body"]
        .as_u64()
        .unwrap()
}

#[test]
fn a_join_keeps_the_keys_of_faces_in_one_plane_that_do_not_meet() {
    // a wall 30 by 10 by 10, a post on it, and a rim on the post 2 mm above the wall whose four sides lie in the
    // planes of the wall's
    let wall = call("box", &json!({"min": [0,0,0], "max": [30,10,10], "keySalt": 81}))["body"]
        .as_u64()
        .unwrap();
    let post = call("box", &json!({"min": [12,3,10], "max": [18,7,12], "keySalt": 82}))["body"]
        .as_u64()
        .unwrap();
    let rim = call("box", &json!({"min": [0,0,12], "max": [30,10,14], "keySalt": 83}))["body"]
        .as_u64()
        .unwrap();
    let sides = [
        [0.0, -1.0, 0.0],
        [0.0, 1.0, 0.0],
        [-1.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
    ];
    let wall_sides: Vec<u64> = sides.iter().map(|n| key_facing(wall, *n)).collect();
    let rim_sides: Vec<u64> = sides.iter().map(|n| key_facing(rim, *n)).collect();
    let posted = join(wall, post, 84);
    let joined = join(posted, rim, 85);
    let keys = keys_of(joined);
    for key in wall_sides.iter().chain(&rim_sides) {
        assert_eq!(keys.iter().filter(|k| *k == key).count(), 1, "{key} in {keys:?}");
    }
    // a reference to a wall side still finds it
    let pushed = call(
        "push",
        &json!({"body": joined, "at": [15,0,5], "normal": [0,-1,0], "distanceMm": 1, "faceKey": wall_sides[0]}),
    );
    assert!(pushed["body"].as_u64().is_some(), "{pushed}");
    for body in [pushed["body"].as_u64().unwrap(), joined, posted, rim, post, wall] {
        call("free", &json!({"body": body}));
    }
}

#[test]
fn a_join_still_clears_the_keys_of_faces_in_one_plane_that_meet() {
    // two blocks side by side: their fronts meet along x 30, so the join can make them one face
    let a = call("box", &json!({"min": [0,0,0], "max": [30,10,10], "keySalt": 91}))["body"]
        .as_u64()
        .unwrap();
    let b = call("box", &json!({"min": [30,0,0], "max": [40,10,10], "keySalt": 92}))["body"]
        .as_u64()
        .unwrap();
    let fronts = [key_facing(a, [0.0, -1.0, 0.0]), key_facing(b, [0.0, -1.0, 0.0])];
    let joined = join(a, b, 93);
    let keys = keys_of(joined);
    for key in fronts {
        assert!(!keys.contains(&key), "{key} in {keys:?}");
    }
    let result = sx_brep::call(
        "push",
        &json!({"body": joined, "at": [15,0,5], "normal": [0,-1,0], "distanceMm": 1, "faceKey": fronts[0]})
            .to_string(),
    );
    let error = result.expect_err("a key a join cleared must stop for repair");
    assert!(
        error.starts_with("faceReference:") && error.contains("repair"),
        "{error}"
    );
    for body in [joined, b, a] {
        call("free", &json!({"body": body}));
    }
}
