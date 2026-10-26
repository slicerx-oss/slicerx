// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A layer height the user sets prints as set. The printer's `max_layer_height` and `min_layer_height` bound generated
//! variable layers and support layers; they never lower or raise a fixed, first layer or per-object height. The only
//! hard limits are the nozzle (a taller layer is refused) and 0.04 mm (a thinner one is refused), each with a layer
//! height message.

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use common::organic_models::cuboid;
use sx_core::api::{Error, Mesh, SliceRequest, SliceRun};

/// A 0.4 mm nozzle printer whose profile limits layers to 0.08 to 0.28 mm, as the stock 0.4 mm profiles of several
/// printers do, with a 0.2 mm first layer.
fn printer(extra: &Value) -> Value {
    let mut c = json!({
        "nozzle_diameter": [0.4],
        "max_layer_height": ["0.28"],
        "min_layer_height": ["0.08"],
        "initial_layer_print_height": 0.2,
        "layer_height": 0.2,
        "brim_width": 0,
    });
    c.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    c
}

fn request(config: &Value, settings: &Value, options: &Value) -> SliceRequest {
    let mut opts = json!({"flavor": "marlin2", "emitPreview": false});
    opts.as_object_mut()
        .unwrap()
        .extend(options.as_object().unwrap().clone());
    serde_json::from_value(json!({
        "plate": {"objects": [{
            "id": "cube",
            "mesh": "cube",
            "settings": settings,
            "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1],
        }]},
        "config": config,
        "options": opts,
    }))
    .unwrap()
}

/// Slices a 20 mm cube.
fn run(config: &Value, settings: &Value, options: &Value) -> sx_core::Result<SliceRun> {
    let req = request(config, settings, options);
    let mesh = Arc::new(Mesh {
        name: "cube".to_owned(),
        parts: vec![cuboid("cube", [0.0, 0.0, 0.0], [20.0, 20.0, 20.0])],
        ..Mesh::default()
    });
    common::run_request(&req, &move |_| Ok(mesh.clone()))
}

fn slice(config: &Value) -> SliceRun {
    run(config, &json!({}), &json!({})).unwrap()
}

/// The layer tops, and each layer's thickness.
fn layers(run: &SliceRun) -> (Vec<f64>, Vec<f64>) {
    let z: Vec<f64> = run.report.layer_z.iter().map(|&z| f64::from(z)).collect();
    let h = z
        .iter()
        .scan(0.0, |prev, &t| {
            let d = t - *prev;
            *prev = t;
            Some(d)
        })
        .collect();
    (z, h)
}

/// `n` layers, the first `first` mm thick and every other `rest` mm, ending at `last`.
fn assert_layers(run: &SliceRun, n: usize, first: f64, rest: f64, last: f64) {
    let (z, h) = layers(run);
    assert_eq!(z.len(), n, "layer tops {z:?}");
    assert!((h[0] - first).abs() < 1e-4, "first layer {}", h[0]);
    for (i, t) in h.iter().enumerate().skip(1) {
        assert!((t - rest).abs() < 1e-4, "layer {} is {t} mm, not {rest}", i + 1);
    }
    assert!((z[n - 1] - last).abs() < 1e-4, "last top {}", z[n - 1]);
}

fn clamped(run: &SliceRun) -> bool {
    run.report
        .warnings
        .iter()
        .any(|w| w.message.contains("layer height"))
}

#[test]
fn a_layer_above_the_printer_maximum_prints_as_set() {
    let r = slice(&printer(&json!({"layer_height": 0.32})));
    assert_layers(&r, 63, 0.2, 0.32, 20.04);
    assert!(!clamped(&r), "{:?}", r.report.warnings);
    let r = slice(&printer(&json!({"layer_height": 0.36})));
    assert_layers(&r, 56, 0.2, 0.36, 20.0);
}

#[test]
fn a_lower_printer_maximum_does_not_cap_it_either() {
    let r = slice(&printer(
        &json!({"layer_height": 0.32, "max_layer_height": ["0.24"], "enable_support": false}),
    ));
    assert_layers(&r, 63, 0.2, 0.32, 20.04);
}

/// A support line as wide as the layer is no reason to refuse when support is off: it never prints.
#[test]
fn a_support_width_equal_to_the_layer_is_fine_with_support_off() {
    let ender = json!({
        "layer_height": 0.38,
        "max_layer_height": ["0.35"],
        "min_layer_height": ["0.1"],
        "support_line_width": 0.38,
        "enable_support": false,
    });
    let r = slice(&printer(&ender));
    assert_layers(&r, 53, 0.2, 0.38, 19.96);
    // With support on the support line still has to be wider than the layer.
    let mut on = printer(&ender);
    on["enable_support"] = json!(true);
    let e = run(&on, &json!({}), &json!({})).unwrap_err();
    assert!(
        matches!(
            e,
            Error::Config {
                key: "support_line_width",
                ..
            }
        ),
        "{e}"
    );
}

#[test]
fn a_layer_below_the_printer_minimum_prints_as_set() {
    let r = slice(&printer(&json!({"layer_height": 0.05})));
    assert_layers(&r, 397, 0.2, 0.05, 20.0);
    let r = slice(&printer(
        &json!({"layer_height": 0.06, "max_layer_height": ["0.35"], "min_layer_height": ["0.1"]}),
    ));
    assert_layers(&r, 331, 0.2, 0.06, 20.0);
}

#[test]
fn a_first_layer_and_layers_above_the_maximum_print_as_set() {
    let r = slice(&printer(
        &json!({"layer_height": 0.32, "initial_layer_print_height": 0.32}),
    ));
    assert_layers(&r, 62, 0.32, 0.32, 19.84);
}

#[test]
fn an_objects_own_layer_height_above_the_maximum_prints_as_set() {
    let r = run(&printer(&json!({})), &json!({"layer_height": 0.32}), &json!({})).unwrap();
    assert_layers(&r, 63, 0.2, 0.32, 20.04);
}

/// Heights between the limits and the first layer alone were never moved.
#[test]
fn heights_inside_the_limits_are_unchanged() {
    assert_layers(&slice(&printer(&json!({}))), 100, 0.2, 0.2, 20.0);
    assert_layers(
        &slice(&printer(&json!({"layer_height": 0.12}))),
        166,
        0.2,
        0.12,
        20.0,
    );
    let r = slice(&printer(&json!({"initial_layer_print_height": 0.32})));
    assert_layers(&r, 99, 0.32, 0.2, 19.92);
}

/// The two hard limits refuse with a layer height message, on the plain request path and on the listed one (a
/// project, or `configReport`), which once sliced a 0.03 mm layer at the default 0.2 mm with only a note.
#[test]
fn a_layer_past_the_hard_limits_is_refused_with_a_layer_height_message() {
    for options in [json!({}), json!({"configReport": true})] {
        let e = run(&printer(&json!({"layer_height": 0.03})), &json!({}), &options).unwrap_err();
        assert!(
            matches!(&e, Error::Config { key: "layer_height", reason } if reason.contains("below the 0.04 mm minimum")),
            "{options}: {e}"
        );
        let e = run(&printer(&json!({"layer_height": 0.44})), &json!({}), &options).unwrap_err();
        assert!(
            matches!(&e, Error::Config { key: "layer_height", reason }
                if reason.contains("cannot exceed the 0.4 mm nozzle diameter")),
            "{options}: {e}"
        );
        // A bridge line no wider than the nozzle is not what the message is about.
        let e = run(
            &printer(&json!({"layer_height": 0.44, "bridge_line_width": 0.4})),
            &json!({}),
            &options,
        )
        .unwrap_err();
        assert!(
            matches!(
                &e,
                Error::Config {
                    key: "layer_height",
                    ..
                }
            ),
            "{options}: {e}"
        );
    }
    // An object's own height too.
    let e = run(&printer(&json!({})), &json!({"layer_height": 0.44}), &json!({})).unwrap_err();
    assert!(
        matches!(
            &e,
            Error::Config {
                key: "layer_height",
                ..
            }
        ),
        "{e}"
    );
}
