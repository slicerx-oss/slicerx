// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! a loft as an exact solid: its matched rails handed to the kernel, one face per matched piece
//!
//! The faces are where [`super::rails`] says the loft's sides are. A piece that is a straight line on every profile
//! is a ruled face between its first and last rails when straight lines between those two are the loft's own side
//! there: between neighboring rails, on a loft whose rails are straight, or across a piece that lies in one plane.
//! Any other such piece is skinned across all of its rails. An open loft's first and last profiles are flat faces;
//! a closed one has none, since its rails come back onto the first profile and the faces meet there. The kernel
//! joins the faces into one solid, which is read back before it is kept: closed, one manifold solid, with a volume.
//!
//! Profiles with arcs, circles or ellipses are refused for now.

use super::{Curve, Density, Match, Options, Piece, Profile, Rails};
use crate::error::{Error, Result};
use crate::exact as table;
use crate::faces;
use crate::mesh::TriMesh;
use crate::vec3::{self, V3};
use sx_brep::{Body, Path, Sheet};

/// What a face of an exact loft is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Part {
    /// The side over this piece of [`Rails::pieces`].
    Side(usize),
    /// The flat face on the first profile.
    First,
    /// The flat face on the last profile.
    Last,
}

/// A loft as a solid in the kernel.
#[derive(Debug)]
pub struct Lofted {
    pub body: Body,
    /// What each face of the body is, in the body's face order.
    pub parts: Vec<Part>,
}

fn kernel(e: &sx_brep::Error) -> Error {
    Error::geometry("loft", e.to_string())
}

/// Rail `i` as one curve through every profile: the cubics the mesh loft's rows are cut from, or straight from
/// each profile to the next.
fn rail(rails: &Rails, i: usize) -> Path {
    let spans = &rails.rails[i];
    if rails.smooth {
        return Path::Cubics(spans.clone());
    }
    let mut points: Vec<V3> = spans.iter().map(|s| s[0]).collect();
    points.extend(spans.last().map(|s| s[3]));
    Path::Lines(points)
}

/// Whether every rail of a piece lies in the plane through the piece's four corners.
fn flat(rails: &Rails, piece: &Piece, tol: f64) -> bool {
    let n = rails.rails.len();
    let at = |k: usize| &rails.rails[(piece.first + k) % n];
    let (Some(a), Some(b)) = (at(0).first(), at(0).last()) else {
        return false;
    };
    let (Some(c), Some(d)) = (at(piece.stretches).first(), at(piece.stretches).last()) else {
        return false;
    };
    let (a0, b0, a1, b1) = (a[0], b[3], c[0], d[3]);
    let Some(normal) = vec3::normalize(vec3::cross(vec3::sub(b1, a0), vec3::sub(b0, a1))) else {
        return false;
    };
    let offset = vec3::dot(normal, a0);
    (0..=piece.stretches).all(|k| {
        at(k)
            .iter()
            .flatten()
            .all(|&p| (vec3::dot(normal, p) - offset).abs() <= tol)
    })
}

/// The faces of the loft and what each is, sides in piece order and then the two ends.
fn sheets(rails: &Rails) -> Result<(Vec<Sheet>, Vec<Part>)> {
    let n = rails.rails.len();
    if !rails.ring_closed {
        return Err(Error::geometry(
            "loft",
            "open profiles make a surface, and an exact loft is a solid; close the profiles",
        ));
    }
    if rails.pieces.iter().any(|p| p.curves.iter().any(Curve::curved)) {
        return Err(Error::geometry(
            "loft",
            "an exact loft is made only through profiles of straight lines for now; these have an arc, a circle or an ellipse",
        ));
    }
    let size = rails
        .rings
        .iter()
        .flat_map(|r| r.points.iter().flatten())
        .fold(1.0f64, |m, c| m.max(c.abs()));
    let tol = size * 1e-9;
    let mut out = Vec::with_capacity(rails.pieces.len() + 2);
    let mut parts = Vec::with_capacity(rails.pieces.len() + 2);
    for (k, piece) in rails.pieces.iter().enumerate() {
        let last = (piece.first + piece.stretches) % n;
        out.push(
            if piece.stretches == 1 || !rails.smooth || flat(rails, piece, tol) {
                Sheet::Ruled(rail(rails, piece.first), rail(rails, last))
            } else {
                Sheet::Skinned(
                    (0..=piece.stretches)
                        .map(|j| rail(rails, (piece.first + j) % n))
                        .collect(),
                )
            },
        );
        parts.push(Part::Side(k));
    }
    if rails.wrap.is_none() {
        let ends = [
            (rails.rings.first(), Part::First),
            (rails.rings.last(), Part::Last),
        ];
        for (ring, part) in ends {
            let Some(ring) = ring else { continue };
            // a piece is a straight line on every profile, so an end's rim runs straight from each piece's start
            // to the next one's
            let corners: Vec<V3> = rails.pieces.iter().map(|p| ring.points[p.first]).collect();
            out.push(Sheet::Flat(
                (0..corners.len())
                    .map(|k| Path::Lines(vec![corners[k], corners[(k + 1) % corners.len()]]))
                    .collect(),
            ));
            parts.push(part);
        }
    }
    Ok((out, parts))
}

/// The loft through `rails` as a solid in the kernel.
///
/// Refuses open profiles, profiles with arcs, circles or ellipses, and anything the kernel cannot close into one
/// solid, each with its reason; then no body is left behind.
pub fn lofted(rails: &Rails) -> Result<Lofted> {
    let (sheets, parts) = sheets(rails)?;
    let (body, order) = Body::stitched(&sheets).map_err(|e| kernel(&e))?;
    Ok(Lofted {
        body,
        parts: order.iter().map(|&s| parts[s]).collect(),
    })
}

/// How many of something a face or a part has been seen with.
#[derive(Clone, Copy, PartialEq)]
enum Seen {
    None,
    One(usize),
    Many,
}

impl Seen {
    fn with(self, other: usize) -> Self {
        match self {
            Self::None => Self::One(other),
            Self::One(same) if same == other => self,
            _ => Self::Many,
        }
    }
}

/// For each of `parts`, the face of the mesh loft that is the same face, when one is: the two cover the same part
/// of the loft, all of it.
///
/// The mesh loft cuts its sides the other way: between each two profiles every flat quad is a plane (joined to
/// the coplanar ones it meets) and the rest of that span is one face. So a side is the same face only when it
/// stays in one plane from the first profile to the last. The two ends always are.
fn same_faces(rails: &Rails, parts: &[Part], mesh: &TriMesh) -> Vec<Option<usize>> {
    let none = vec![None; parts.len()];
    let n = rails.rails.len();
    let Some(f) = mesh.faces.as_ref().filter(|f| f.fit(mesh)) else {
        return none;
    };
    let (Some(first), Some(last)) = (rails.rings.first(), rails.rings.last()) else {
        return none;
    };
    let size = mesh
        .positions
        .iter()
        .flatten()
        .fold(1.0f64, |m, c| m.max(c.abs()));
    let tol = size * 1e-9;
    // the mesh loft's points are its rows one after another, each row a ring of the loft; its side triangles can be
    // told to their stretch only when those rings are the rails' own
    let bits = |p: &V3| p.map(f64::to_bits);
    let rows_match = n > 0
        && mesh.positions.len().is_multiple_of(n)
        && mesh.positions.len() >= 2 * n
        && mesh.positions[..n]
            .iter()
            .map(bits)
            .eq(first.points.iter().map(bits));
    let mut piece_of = vec![usize::MAX; n];
    for (k, piece) in rails.pieces.iter().enumerate() {
        for j in 0..piece.stretches {
            piece_of[(piece.first + j) % n] = k;
        }
    }
    let part_at = |part: Part| parts.iter().position(|&p| p == part);
    let on = |ring: &super::Ring, t: &[u32; 3]| {
        t.iter()
            .all(|&v| ring.frame.height(mesh.positions[v as usize]).abs() <= tol)
    };
    let mut of_face = vec![Seen::None; f.table.len()];
    let mut of_part = vec![Seen::None; parts.len()];
    for (t, &face) in mesh.triangles.iter().zip(&f.ids) {
        let rows = t.map(|v| v as usize / n.max(1));
        let end = rails.wrap.is_none() && rows[0] == rows[1] && rows[1] == rows[2];
        let part = if rows_match && !end {
            // a side triangle starts on its quad's first corner
            Some(piece_of[t[0] as usize % n])
                .filter(|&k| k != usize::MAX)
                .and_then(|k| part_at(Part::Side(k)))
        } else if on(first, t) {
            part_at(Part::First)
        } else if on(last, t) {
            part_at(Part::Last)
        } else {
            None
        };
        let face = face as usize;
        match part {
            Some(part) => {
                of_face[face] = of_face[face].with(part);
                of_part[part] = of_part[part].with(face);
            }
            // a triangle of no part: its face is no part's alone
            None => of_face[face] = Seen::Many,
        }
    }
    of_part
        .iter()
        .enumerate()
        .map(|(part, &seen)| match seen {
            Seen::One(face) if of_face[face] == Seen::One(part) => Some(face),
            _ => None,
        })
        .collect()
}

/// Makes the loft through `rails` an exact solid, keeps it in the engine's table and returns its number.
///
/// `mesh` is the mesh loft of the same profiles ([`super::loft_with`]). Inside a step that keys its faces
/// ([`faces::with_key_salt`]) both get their keys here, from one run of the step's numbers: the mesh loft's faces
/// the keys they would have had without the exact body, and each face of the body the key of the mesh face that
/// is the same face, or a key of its own after the mesh loft's when none is. So a face picked on the mesh loft
/// and on the exact one has one key where the two are one face. Outside a keyed step neither gets keys.
pub fn hold(rails: &Rails, mesh: &mut TriMesh) -> Result<u32> {
    let (sheets, parts) = sheets(rails)?;
    let (body, order) = Body::stitched(&sheets).map_err(|e| kernel(&e))?;
    let same = same_faces(rails, &parts, mesh);
    let mesh_faces = mesh.faces.as_ref().map_or(0, |f| f.table.len());
    let fresh = faces::fresh_keys(mesh_faces + parts.len());
    if fresh.is_empty() {
        return table::hold(body, Vec::new());
    }
    let keys = order
        .iter()
        .map(|&part| fresh[same[part].unwrap_or(mesh_faces + part)])
        .collect();
    if let Some(f) = mesh.faces.as_mut() {
        f.keys = fresh[..mesh_faces].to_vec();
    }
    table::hold(body, keys)
}

/// The loft through `profiles` made an exact solid and kept, beside its mesh loft `mesh`; see [`hold`].
///
/// Refuses, with the reason, profiles that cannot be matched piece to piece and a loft thickened into a shell.
/// Whatever the mesh loft refuses is refused here in the same words.
pub fn hold_through(profiles: &[Profile], opts: &Options, mesh: &mut TriMesh) -> Result<u32> {
    if opts.thicken.is_some() {
        return Err(Error::geometry(
            "loft",
            "a loft thickened into a shell is not made exact yet",
        ));
    }
    match super::rails(profiles, opts, &Density::default())? {
        Match::Rails(rails) => hold(&rails, mesh),
        Match::Unmatched(why) => Err(Error::geometry("loft", why)),
    }
}
