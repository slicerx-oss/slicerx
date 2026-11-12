// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Solids joined from faces: straight and cubic curves held exactly, ruled, skinned and flat faces, which face of the
// body each given face became, and the refusals when the faces leave the solid open. Empty without the typed
// feature, so a workspace test run that names every test target passes over it.
#![cfg(feature = "typed")]
use sx_brep::{Body, Error, Path, Sheet, Surface, Tessellation};

type P = [f64; 3];

fn close(a: f64, b: f64) {
    assert!((a - b).abs() <= 1e-6 * b.abs().max(1.0), "{a} != {b}");
}

fn line(a: P, b: P) -> Path {
    Path::Lines(vec![a, b])
}

/// The straight piece from `a` to `b` as a cubic.
fn cubic(a: P, b: P) -> Path {
    let at = |t: f64| [0, 1, 2].map(|i| a[i] + (b[i] - a[i]) * t);
    Path::Cubics(vec![[a, at(1.0 / 3.0), at(2.0 / 3.0), b]])
}

/// The corners of a square of side `side` about the z axis at height `z`, counterclockwise seen from above.
fn square(side: f64, z: f64) -> [P; 4] {
    let h = side / 2.0;
    [[-h, -h, z], [h, -h, z], [h, h, z], [-h, h, z]]
}

fn ring(corners: &[P]) -> Vec<Path> {
    (0..corners.len())
        .map(|i| line(corners[i], corners[(i + 1) % corners.len()]))
        .collect()
}

/// Four sides between two squares, each between the rails `rail` makes from a bottom corner to the top corner
/// above it, then the bottom and the top.
fn tower(bottom: [P; 4], top: [P; 4], rail: fn(P, P) -> Path) -> Vec<Sheet> {
    let mut sheets: Vec<Sheet> = (0..4)
        .map(|i| {
            let j = (i + 1) % 4;
            Sheet::Ruled(rail(bottom[i], top[i]), rail(bottom[j], top[j]))
        })
        .collect();
    sheets.push(Sheet::Flat(ring(&bottom)));
    sheets.push(Sheet::Flat(ring(&top)));
    sheets
}

fn refusal(made: Result<(Body, Vec<usize>), Error>) -> String {
    made.expect_err("a refusal").to_string()
}

#[test]
fn without_the_kernel_joining_faces_says_so() {
    if sx_brep::KERNEL {
        return;
    }
    let sheets = tower(square(10.0, 0.0), square(10.0, 5.0), line);
    assert_eq!(
        refusal(Body::stitched(&sheets)),
        "this build has no B-rep kernel (packages/brep/scripts/fetch-smlib.sh, then build again)"
    );
}

// refused before the kernel is asked, so the same with the kernel or without
#[test]
fn faces_that_make_no_sense_are_refused_in_words() {
    let mut sheets = tower(square(10.0, 0.0), square(10.0, 5.0), line);
    assert_eq!(
        refusal(Body::stitched(&sheets[..1])),
        "faces: a solid needs 2 or more faces"
    );
    sheets[0] = Sheet::Ruled(line([0.0; 3], [0.0; 3]), line([1.0; 3], [2.0; 3]));
    assert_eq!(
        refusal(Body::stitched(&sheets)),
        "ruled face: a curve has a piece of no length"
    );
    let mut open = ring(&square(10.0, 5.0));
    open.pop();
    sheets[0] = Sheet::Flat(open);
    assert_eq!(
        refusal(Body::stitched(&sheets)),
        "flat face: its loop is not closed: each curve must start on the point the one before ends on"
    );
}

#[test]
fn a_block_is_joined_from_four_ruled_sides_and_two_flat_ends() {
    if !sx_brep::KERNEL {
        return;
    }
    let sheets = tower(square(10.0, 0.0), square(10.0, 5.0), line);
    let (body, order) = Body::stitched(&sheets).expect("a block");
    close(body.volume().expect("volume"), 500.0);
    let mut seen = order.clone();
    seen.sort_unstable();
    assert_eq!(
        seen,
        [0, 1, 2, 3, 4, 5],
        "each face given is one face of the body"
    );
    // each triangle lies on the face it says: sides 0 to 3 on y = -5, x = 5, y = 5, x = -5, then the two ends
    let on: [(usize, f64); 6] = [(1, -5.0), (0, 5.0), (1, 5.0), (0, -5.0), (2, 0.0), (2, 5.0)];
    let mesh = body.tessellate(&Tessellation::default()).expect("a mesh");
    assert_eq!(mesh.surfaces.len(), 6);
    assert!(mesh.surfaces.iter().all(|s| matches!(s, Surface::Plane { .. })));
    for (triangle, &face) in mesh.triangles.iter().zip(&mesh.faces) {
        let (axis, at) = on[order[face as usize]];
        for &corner in triangle {
            close(mesh.positions[corner as usize][axis], at);
        }
    }
}

#[test]
fn cubic_rails_are_held_exactly() {
    if !sx_brep::KERNEL {
        return;
    }
    // a square of 10 mm narrowing to one of 6 mm over 10 mm: h / 3 * (A + a + sqrt(A * a))
    let sheets = tower(square(10.0, 0.0), square(6.0, 10.0), cubic);
    let (body, order) = Body::stitched(&sheets).expect("a tapered block");
    close(body.volume().expect("volume"), 10.0 / 3.0 * (100.0 + 36.0 + 60.0));
    assert_eq!(order.len(), 6);
    let (min, max) = body.bounds().expect("bounds");
    for i in 0..3 {
        close(min[i], [-5.0, -5.0, 0.0][i]);
        close(max[i], [5.0, 5.0, 10.0][i]);
    }
}

#[test]
fn a_skinned_face_passes_through_every_rail() {
    if !sx_brep::KERNEL {
        return;
    }
    // five rails side by side along x, the middle ones lifted: a cushion over a 10 by 4 mm rectangle. The rails
    // start on one straight line and end on another, so the cushion's rim is the rectangle.
    let lift = [0.0, 2.0, 3.0, 2.0, 0.0];
    let rails: Vec<Path> = lift
        .iter()
        .zip(0_u8..)
        .map(|(&z, k)| {
            let y = f64::from(k);
            Path::Cubics(vec![[
                [0.0, y, 0.0],
                [10.0 / 3.0, y, z],
                [20.0 / 3.0, y, z],
                [10.0, y, 0.0],
            ]])
        })
        .collect();
    let rim: [P; 4] = [
        [0.0, 0.0, 0.0],
        [0.0, 4.0, 0.0],
        [10.0, 4.0, 0.0],
        [10.0, 0.0, 0.0],
    ];
    let sheets = [Sheet::Skinned(rails), Sheet::Flat(ring(&rim))];
    let (body, order) = Body::stitched(&sheets).expect("a cushion");
    let volume = body.volume().expect("volume");
    println!("SKIN cushion volume {volume:.9} order {order:?}");
    assert!(volume > 0.0);
    let (min, max) = body.bounds().expect("bounds");
    println!("SKIN cushion bounds {min:?} {max:?}");
    // the middle rail's highest point: a cubic with its two inner control points at 3 peaks at three quarters of it
    assert!((max[2] - 2.25).abs() < 1e-3, "{max:?}");
    assert!(min[2].abs() < 1e-6, "{min:?}");
    let mesh = body.tessellate(&Tessellation::default()).expect("a mesh");
    let skin = order.iter().position(|&s| s == 0).unwrap();
    assert_eq!(mesh.surfaces[skin], Surface::Spline);
    assert!(matches!(mesh.surfaces[1 - skin], Surface::Plane { .. }));
}

#[test]
fn faces_that_leave_a_gap_make_no_body() {
    if !sx_brep::KERNEL {
        return;
    }
    // the top lifted off the sides
    let mut lifted = tower(square(10.0, 0.0), square(10.0, 5.0), line);
    lifted[5] = Sheet::Flat(ring(&square(10.0, 6.0)));
    let why = refusal(Body::stitched(&lifted));
    println!("GAP lifted top: {why}");
    assert_eq!(why, "stitch: the result is not a solid: its faces do not close");
    // a side left out
    let mut missing = tower(square(10.0, 0.0), square(10.0, 5.0), line);
    missing.remove(2);
    let why = refusal(Body::stitched(&missing));
    println!("GAP missing side: {why}");
    assert_eq!(why, "stitch: the result is not a solid: its faces do not close");
}
