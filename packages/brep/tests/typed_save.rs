// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A typed body saved as text: the `load` operation reads it back with its face keys, and the other operations
// work on what it read. Empty without the typed feature or without the kernel.
#![cfg(all(feature = "typed", sx_brep_kernel))]
use serde_json::{Value, json};
use sx_brep::{Body, Path, Sheet};

type P = [f64; 3];

fn call(op: &str, request: &Value) -> Value {
    let reply = sx_brep::call(op, &request.to_string()).unwrap_or_else(|e| panic!("{op}: {e}"));
    serde_json::from_str(&reply).expect("a JSON reply")
}

/// A tower whose top is smaller than its bottom and turned against it, with sides that bow out: four ruled spline
/// faces and two flat ends, as a loft is made.
fn tower() -> Body {
    let square = |side: f64, z: f64, turn: f64| -> [P; 4] {
        let h = side / 2.0;
        let (s, c) = turn.to_radians().sin_cos();
        [[-h, -h], [h, -h], [h, h], [-h, h]].map(|[x, y]| [x * c - y * s, x * s + y * c, z])
    };
    let (bottom, top) = (square(10.0, 0.0, 0.0), square(6.0, 10.0, 20.0));
    let rail = |a: P, b: P| {
        let at = |t: f64| {
            [
                a[0] + (b[0] - a[0]) * t + a[0].signum(),
                a[1] + (b[1] - a[1]) * t + a[1].signum(),
                a[2] + (b[2] - a[2]) * t,
            ]
        };
        Path::Cubics(vec![[a, at(1.0 / 3.0), at(2.0 / 3.0), b]])
    };
    let ring =
        |c: &[P; 4]| -> Vec<Path> { (0..4).map(|i| Path::Lines(vec![c[i], c[(i + 1) % 4]])).collect() };
    let mut sheets: Vec<Sheet> = (0..4)
        .map(|i| {
            let j = (i + 1) % 4;
            Sheet::Ruled(rail(bottom[i], top[i]), rail(bottom[j], top[j]))
        })
        .collect();
    sheets.push(Sheet::Flat(ring(&bottom)));
    sheets.push(Sheet::Flat(ring(&top)));
    Body::stitched(&sheets).expect("a tower").0
}

#[test]
fn the_old_load_reads_a_typed_body_with_its_keys() {
    let body = tower();
    let volume = body.volume().expect("volume");
    let keys = [1001, 1002, 0, 1004, 1005, 1006];
    let text = body.saved(&keys).expect("the body as text");
    let loaded = call("load", &json!({ "body": { "smb": text } }))["body"].clone();
    let info = call("info", &json!({ "body": loaded }));
    assert_eq!(info["manifold"], json!(true));
    assert_eq!(info["faces"], json!(6));
    let read = info["volumeMm3"].as_f64().expect("a volume");
    assert!((read - volume).abs() <= 1e-9 * volume, "{read} {volume}");
    // each face has the key given for it, in the same face order
    let mesh = call("tessellate", &json!({ "body": loaded }));
    let read: Vec<u64> = mesh["faces"]
        .as_array()
        .expect("faces")
        .iter()
        .map(|f| f["key"].as_u64().expect("a key"))
        .collect();
    assert_eq!(read, keys);
    // and the old operations work on it
    let cube = call("box", &json!({ "min": [0, 0, 2], "max": [20, 20, 4] }))["body"].clone();
    let joined = call("boolean", &json!({ "op": "union", "a": loaded, "b": cube }))["body"].clone();
    let info = call("info", &json!({ "body": joined }));
    assert_eq!(info["manifold"], json!(true));
    assert!(info["volumeMm3"].as_f64().expect("a volume") > volume);
    // saved again by the old operation, the keys line is the one written here
    let line = |text: &str| {
        text.lines()
            .find(|l| l.starts_with("//sx-brep keys"))
            .map(str::to_owned)
    };
    let again = call("save", &json!({ "body": loaded }))["smb"].clone();
    assert_eq!(line(again.as_str().expect("text")), line(&text));
    assert_eq!(
        line(&text).as_deref(),
        Some("//sx-brep keys 1001 1002 0 1004 1005 1006")
    );
    for b in [&loaded, &cube, &joined] {
        call("free", &json!({ "body": b }));
    }
}

#[test]
fn a_body_without_keys_has_no_keys_line() {
    let body = tower();
    let text = body.saved(&[]).expect("the body as text");
    assert!(!text.contains("//sx-brep keys"));
    assert!(
        text.lines()
            .last()
            .is_some_and(|l| l.starts_with("//sx-brep fnv1a64 "))
    );
    let loaded = call("load", &json!({ "body": { "smb": text } }))["body"].clone();
    let mesh = call("tessellate", &json!({ "body": loaded }));
    assert!(
        mesh["faces"]
            .as_array()
            .expect("faces")
            .iter()
            .all(|f| f["key"] == json!(0))
    );
    call("free", &json!({ "body": loaded }));
    assert_eq!(
        body.saved(&[1, 2, 3]).expect_err("a refusal").to_string(),
        "keys: must be one for each face of the body, or none"
    );
}
