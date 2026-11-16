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
    // a rim above the block whose sides lie in the block's planes, apart from them
    let rim = body(call(
        "box",
        &json!({"min": [5,0,7], "max": [25,10,8], "keySalt": 73}),
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
    // the post's front, 2 mm in, lies in no other plane and keeps its key
    let mut want = vec![(0, block_front), (0, rim_front), (post_front, 0)];
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
