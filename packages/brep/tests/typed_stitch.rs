// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Solids joined from faces: straight and cubic curves held exactly, ruled, skinned and flat faces, which face of the
// body each given face became, the joined edges read back against the curves the faces were given, the curves a
// skinned face ends on read from the kernel, and the refusals when the faces leave the solid open or meet off their
// curves. Empty without the typed
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
    assert_eq!(sx_brep::skin_ends(&bowed_wall()), Err(Error::NoKernel));
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
    // a ruled face is a spline surface in the kernel, also where it lies in a plane
    for (surface, &sheet) in mesh.surfaces.iter().zip(&order) {
        assert_eq!(
            matches!(surface, Surface::Plane { .. }),
            sheet >= 4,
            "{surface:?}"
        );
        assert!(sheet >= 4 || *surface == Surface::Spline, "{surface:?}");
    }
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

/// A block 10 mm square and 5 mm high grown `scale` times, with the top end of one rail moved `off` mm along
/// `way`: the two sides on that rail end that far from the corner of the top face they share.
fn block_with_a_rail_end_off(scale: f64, off: f64, way: P, rail: fn(P, P) -> Path) -> Vec<Sheet> {
    let top = square(10.0 * scale, 5.0 * scale);
    let mut ends = top;
    ends[2] = [0, 1, 2].map(|i| top[2][i] + off * way[i]);
    let mut sheets = tower(square(10.0 * scale, 0.0), ends, rail);
    sheets[5] = Sheet::Flat(ring(&top));
    sheets
}

/// Every way the block is tried: straight and cubic rails, the rail end moved in the top's plane and off it.
fn each_way() -> impl Iterator<Item = (fn(P, P) -> Path, P)> {
    let rails: [fn(P, P) -> Path; 2] = [line, cubic];
    rails
        .into_iter()
        .flat_map(|rail| [[1.0, 0.0, 0.0], [0.0, 0.0, 1.0]].map(|way| (rail, way)))
}

// The kernel pulls faces together to join them and calls the result a solid. What it says it closed is held to a
// billionth of the largest coordinate given: 5e-9 mm on the block that reaches 5 mm, 2e-7 mm on the one that
// reaches 200 mm.
#[test]
fn faces_within_a_billionth_of_the_size_are_joined() {
    if !sx_brep::KERNEL {
        return;
    }
    for (rail, way) in each_way() {
        for (scale, off) in [(1.0, 0.0), (1.0, 4e-10), (1.0, 4e-9), (40.0, 1.6e-7)] {
            let sheets = block_with_a_rail_end_off(scale, off, way, rail);
            let (body, order) = Body::stitched(&sheets)
                .unwrap_or_else(|why| panic!("{off:e} mm along {way:?} at {scale}: {why}"));
            assert_eq!(order.len(), 6);
            close(body.volume().expect("volume"), 500.0 * scale.powi(3));
        }
    }
}

#[test]
fn faces_the_kernel_pulled_together_are_refused_with_the_gap_in_mm() {
    if !sx_brep::KERNEL {
        return;
    }
    // just past the limit on each block, and a gap a hundredth of a mm wide that the kernel still closes
    let cases = [
        (1.0, 6e-9, "6.000e-9"),
        (1.0, 1e-2, "1.000e-2"),
        (40.0, 2.4e-7, "2.400e-7"),
    ];
    for (rail, way) in each_way() {
        for (scale, off, said) in cases {
            let sheets = block_with_a_rail_end_off(scale, off, way, rail);
            let why = Body::stitched(&sheets).expect_err("a refusal");
            let Error::Apart { gap_mm } = &why else {
                panic!("{off:e} mm along {way:?} at {scale}: {why}");
            };
            // the gap the kernel reports is the distance the rail end was moved
            assert!((gap_mm - off).abs() <= 1e-4 * off, "{gap_mm:e} != {off:e}");
            assert_eq!(
                why.to_string(),
                format!("stitch: the faces are {said} mm apart along a side they share; they must meet")
            );
        }
    }
}

// After the join, every edge of the body is read back against the curves its two faces were given. On faces that
// meet on their curves that is rounding.
#[test]
fn the_edges_of_joined_faces_are_on_the_curves_the_faces_were_given() {
    if !sx_brep::KERNEL {
        return;
    }
    let block = tower(square(10.0, 0.0), square(10.0, 5.0), line);
    let cubic_block = tower(square(10.0, 0.0), square(10.0, 5.0), cubic);
    let tapered = tower(square(10.0, 0.0), square(6.0, 10.0), cubic);
    let big = tower(square(400.0, 0.0), square(400.0, 200.0), line);
    for (name, sheets, size) in [
        ("block", block, 5.0),
        ("block on cubic rails", cubic_block, 5.0),
        ("tapered block", tapered, 10.0),
        ("block 400 mm", big, 200.0),
    ] {
        let (_, order, off) = Body::stitched_off(&sheets).unwrap_or_else(|why| panic!("{name}: {why}"));
        assert_eq!(order.len(), 6, "{name}");
        println!("EDGES {name}: the edges are {off:e} mm from the curves given");
        assert!(off <= 1e-9 * size, "{name}: {off:e} mm");
    }
}

/// A block 10 mm square and 5 mm high whose top face is given its side from `top[0]` to `top[1]` as a cubic that
/// bows `bow` mm out in the top's plane, while the side face under it is given the straight line there. The two
/// meet at both corners and nowhere between.
fn block_with_a_bowed_top(bow: f64) -> Vec<Sheet> {
    let top = square(10.0, 5.0);
    let mut sheets = tower(square(10.0, 0.0), top, line);
    // a cubic's middle is three quarters of the way out to its two inner control points
    let out = bow * 4.0 / 3.0;
    let at = |t: f64| {
        [
            top[0][0] + (top[1][0] - top[0][0]) * t,
            top[0][1] - out,
            top[0][2],
        ]
    };
    let mut sides = ring(&top);
    sides[0] = Path::Cubics(vec![[top[0], at(1.0 / 3.0), at(2.0 / 3.0), top[1]]]);
    sheets[5] = Sheet::Flat(sides);
    sheets
}

/// A drum of radius 10 mm and 5 mm high: one face skinned across 36 straight rails around it and back onto the
/// first, and each end a flat face inside one closed curve through the rails' ends, a cubic from each to the next
/// with even-step tangents. The skin runs its own smooth curve through those ends, which is not that one: between
/// the rails they are about 5e-4 mm apart.
fn drum() -> Vec<Sheet> {
    let at = |k: usize, z: f64| {
        let (s, c) = (std::f64::consts::TAU * f64::from(u32::try_from(k % 36).unwrap()) / 36.0).sin_cos();
        [10.0 * c, 10.0 * s, z]
    };
    let rails: Vec<Path> = (0..=36).map(|k| line(at(k, 0.0), at(k, 5.0))).collect();
    let rim = |z: f64| {
        let spans: Vec<[P; 4]> = (0..36)
            .map(|k| {
                let (p0, p1, p2, p3) = (at(k + 35, z), at(k, z), at(k + 1, z), at(k + 2, z));
                let ahead = [0, 1, 2].map(|i| p1[i] + (p2[i] - p0[i]) / 6.0);
                let behind = [0, 1, 2].map(|i| p2[i] - (p3[i] - p1[i]) / 6.0);
                [p1, ahead, behind, p2]
            })
            .collect();
        Sheet::Flat(vec![Path::Cubics(spans)])
    };
    vec![Sheet::Skinned(rails), rim(0.0), rim(5.0)]
}

#[test]
fn faces_joined_off_the_curves_they_were_given_are_refused() {
    if !sx_brep::KERNEL {
        return;
    }
    // a side bowed 5e-4 mm off its neighbor's line between two corners: the gap the kernel reports shows it
    let (_, _, off) = Body::stitched_off(&block_with_a_bowed_top(1e-10)).expect("a block");
    assert!(off <= 5e-9, "{off:e}");
    let why = Body::stitched(&block_with_a_bowed_top(5e-4)).expect_err("a refusal");
    assert!(matches!(why, Error::Apart { .. }), "{why}");
    // a closed rim about 5e-4 mm off the skin it is joined to: the gap the kernel reports does not show it, the
    // edges read back do
    let why = Body::stitched(&drum()).expect_err("a refusal");
    println!("EDGES drum: {why}");
    let Error::Moved { off_mm } = &why else {
        panic!("{why}");
    };
    assert!((1e-4..=1e-3).contains(off_mm), "{off_mm:e}");
    assert_eq!(
        why.to_string(),
        format!(
            "stitch: the faces were joined along a side {off_mm:.3e} mm off the curves they were given; they must meet on them"
        )
    );
}

/// Seven straight rails 5 mm high standing on a curve: a wall bowed in plan, from x 0 to 12.
fn bowed_wall() -> Vec<Path> {
    (0_u8..7)
        .map(|k| {
            let x = 2.0 * f64::from(k);
            let y = 0.1 * (x - 6.0) * (x - 6.0);
            line([x, y, 0.0], [x, y, 5.0])
        })
        .collect()
}

/// The ends of a curve as its first and last control points.
fn ends_of(path: &Path) -> (P, P) {
    match path {
        Path::Lines(points) => (points[0], points[points.len() - 1]),
        Path::Cubics(spans) => (spans[0][0], spans[spans.len() - 1][3]),
    }
}

#[test]
fn the_curves_a_skinned_face_ends_on_are_refused_in_words_before_the_kernel_is_asked() {
    assert_eq!(
        sx_brep::skin_ends(&bowed_wall()[..1])
            .expect_err("a refusal")
            .to_string(),
        "skinned face: a face runs across 2 or more curves"
    );
    let mut mixed = bowed_wall();
    mixed[3] = cubic([6.0, 0.0, 0.0], [6.0, 0.0, 5.0]);
    assert_eq!(
        sx_brep::skin_ends(&mixed).expect_err("a refusal").to_string(),
        "skinned face: its curves must be of one kind and have as many pieces each"
    );
}

// A face skinned across curves runs its own smooth curve through their ends. Read from the kernel, that curve bounds
// a flat face that meets the skin exactly: the solid closes with its edges on the curves given, to rounding.
#[test]
fn a_skinned_face_s_ends_are_read_from_the_kernel_and_close_a_solid() {
    if !sx_brep::KERNEL {
        return;
    }
    let rails = bowed_wall();
    let (bottom, top) = sx_brep::skin_ends(&rails).expect("its ends");
    // the first and last rails stand at y 0.1 (x - 6)^2, which is 3.6 to rounding
    let (first_ends, last_ends) = (ends_of(&rails[0]), ends_of(&rails[6]));
    for (end, (start_want, finish_want), z) in [
        (&bottom, (first_ends.0, last_ends.0), 0.0),
        (&top, (first_ends.1, last_ends.1), 5.0),
    ] {
        // exactly from the first rail's end to the last one's, on the plane of the rails' ends
        assert_eq!(ends_of(end), (start_want, finish_want), "{end:?}");
        let points: Vec<P> = match end {
            Path::Lines(points) => points.clone(),
            Path::Cubics(spans) => spans.iter().flatten().copied().collect(),
        };
        assert!(points.iter().all(|p| (p[2] - z).abs() <= 1e-12), "{end:?}");
    }
    let (first, last) = (rails[0].clone(), rails[6].clone());
    let end = |curve: Path, from: P, to: P| Sheet::Flat(vec![curve, line(from, to)]);
    let sheets = vec![
        Sheet::Skinned(rails),
        Sheet::Ruled(last, first),
        end(bottom, last_ends.0, first_ends.0),
        end(top, last_ends.1, first_ends.1),
    ];
    let (body, order, off) = Body::stitched_off(&sheets).expect("a bowed block");
    println!("EDGES bowed wall closed on its read ends: {off:e} mm");
    assert_eq!(order.len(), 4);
    assert!(off <= 1e-9 * 12.0, "{off:e}");
    // the area under the bow, y from 0.1 (x - 6)^2 up to 3.6, is 28.8 mm2 for a straight-sided bow; the skin bows
    // a little differently between the rails, so only the sign and size are held
    let volume = body.volume().expect("volume");
    assert!(volume > 100.0 && volume < 200.0, "{volume}");
}
