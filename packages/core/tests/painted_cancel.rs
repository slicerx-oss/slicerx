// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A canceled painted slice stops while its paint is cut. A session of a painted plate with several filaments cuts
//! the paint of every layer while it is built (to learn which filaments each layer prints), and that is the dearest
//! part of a painted slice: a cancel read only between stages let a canceled painted slice run on to the end of it.

mod common;

use serde_json::json;
use std::sync::Arc;
use std::time::{Duration, Instant};

use sx_core::api::{self, Mesh, MeshPart, SliceRequest};
use sx_core::paint::PaintFacet;
use sx_core::{Error, Progress, Stage};

/// Cancels once `after` has passed since `start`.
struct CancelAfter {
    start: Instant,
    after: Duration,
}

impl Progress for CancelAfter {
    fn report(&self, _: Stage, _: f32) {}
    fn cancelled(&self) -> bool {
        self.start.elapsed() >= self.after
    }
}

/// A slab 120 x 120 mm and 1 mm tall on filament 1, its low Y side painted filament 2 and its low X side filament
/// 3: five layers, each with a painted wall all the way along two sides, so each layer's paint fills a grid of the
/// whole slab.
fn painted_slab() -> Mesh {
    let (lo, hi) = ([0.0f32, 0.0, 0.0], [120.0f32, 120.0, 1.0]);
    let positions: Vec<[f32; 3]> = (0..8)
        .map(|i| {
            [
                if i & 1 == 0 { lo[0] } else { hi[0] },
                if i & 2 == 0 { lo[1] } else { hi[1] },
                if i & 4 == 0 { lo[2] } else { hi[2] },
            ]
        })
        .collect();
    let triangles: Vec<[u32; 3]> = vec![
        [0, 2, 1],
        [1, 2, 3],
        [4, 5, 6],
        [5, 7, 6],
        [0, 1, 4],
        [1, 5, 4],
        [2, 6, 3],
        [3, 6, 7],
        [0, 4, 2],
        [2, 4, 6],
        [1, 3, 5],
        [3, 7, 5],
    ];
    let corners = |t: usize| triangles[t].map(|v| positions[v as usize]);
    // Triangles 4 and 5 are the low Y side, 8 and 9 the low X side.
    let paint: Vec<PaintFacet> = [(4, 2), (5, 2), (8, 3), (9, 3)]
        .into_iter()
        .map(|(t, state)| PaintFacet { v: corners(t), state })
        .collect();
    Mesh {
        name: "slab".into(),
        parts: vec![MeshPart {
            name: "slab".into(),
            slot: 1,
            positions,
            triangles,
            paint,
            ..MeshPart::default()
        }],
        ..Mesh::default()
    }
}

fn request() -> SliceRequest {
    serde_json::from_value(json!({
        "plate": {"objects": [{"id": "s", "name": "s", "mesh": "s", "transform": [
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 68.0, 68.0, 0.0, 1.0]}]},
        "config": common::with_base(&json!({
            "filament_colour": ["#FFFFFF", "#000000", "#FF0000"],
            "enable_prime_tower": false,
            "layer_height": 0.2,
            "initial_layer_print_height": 0.2,
        })),
        "options": {"flavor": "marlin2"},
    }))
    .unwrap()
}

#[test]
fn a_canceled_painted_slice_stops_while_its_paint_is_cut() {
    let mesh = Arc::new(painted_slab());
    let req = request();
    let meshes = move |_: &str| Ok(mesh.clone());
    // Canceled from the start, so what is set up once per run is ready before the runs that are timed.
    let at_once = CancelAfter {
        start: Instant::now(),
        after: Duration::ZERO,
    };
    assert!(matches!(
        api::prepare_with(&req, &meshes, &at_once).map(|_| ()),
        Err(Error::Cancelled)
    ));
    let t = Instant::now();
    let whole = api::prepare(&req, &meshes).unwrap();
    let full = t.elapsed();
    assert!(whole.session().layer_count() >= 5);
    drop(whole);
    // Canceled a tenth of the way in, while the layers' paint is cut side by side: the run ends soon after, long
    // before a whole run would.
    let cancel = CancelAfter {
        start: Instant::now(),
        after: full / 10,
    };
    let err = api::prepare_with(&req, &meshes, &cancel).map(|_| ()).unwrap_err();
    let stopped = cancel.start.elapsed();
    assert!(matches!(err, Error::Cancelled), "{err}");
    assert!(
        stopped * 2 < full,
        "canceled after {:?}, the run stopped after {stopped:?}; a whole run takes {full:?}",
        cancel.after
    );
}
