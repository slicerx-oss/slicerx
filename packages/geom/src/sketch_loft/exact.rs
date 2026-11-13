// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! a loft as an exact solid: its matched rails handed to the kernel, one face per matched piece
//!
//! The faces are where [`super::rails`] says the loft's sides are. A piece that is a straight line on every profile
//! is a ruled face between its first and last rails, so a straight run such as a deck stays flat. A piece that is a
//! spline on every profile is skinned across all of its rails, and so is one whole circle or ellipse on every
//! profile, across every rail and back onto the first. An open loft's first and last profiles are flat
//! faces, bounded by the straight pieces' lines and, along each skinned side, by the curve that side ends on as the
//! kernel reads it off its own surface ([`sx_brep::skin_ends`]); a closed one has none, since its rails come back onto
//! the first profile and the faces meet there. The kernel joins the faces into one solid, which is read back before
//! it is kept: closed, one manifold solid, with a volume, and its edges on the curves its faces were given.
//!
//! Each skinned side is held to the drawing: at every profile it comes within [`DRAWN_MM`] of the profile as drawn,
//! or its rails are doubled, or the loft is refused. Profiles with arcs among other pieces, and a closed loft through
//! circles or ellipses, are refused for now.

use super::{Curve, Density, Match, Options, Profile, Rails};
use crate::error::{Error, Result};
use crate::exact as table;
use crate::faces;
use crate::mesh::TriMesh;
use crate::vec3::V3;
use std::f64::consts::TAU;
use sx_brep::{Body, DRAWN_MM, Path, Sheet, Tessellation, apart, skin_stations};

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

/// What kind of face the kernel was asked to make.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Straight lines from one rail to another.
    Ruled,
    /// A smooth face across several rails.
    Skinned,
    /// A flat face inside its loop.
    Flat,
}

/// A loft as a solid in the kernel.
#[derive(Debug)]
pub struct Lofted {
    pub body: Body,
    /// What each face of the body is, in the body's face order.
    pub parts: Vec<Part>,
    /// What kind of face each is, in the same order.
    pub kinds: Vec<Kind>,
    /// How far the body's edges are from the rails and the lines its faces were given, in mm, as the join reads
    /// them back.
    pub off_mm: f64,
    /// How far the body's skinned faces are from the drawn sections at the stations, in mm, as read back from the
    /// kernel's surfaces; 0 when it has none.
    pub drawn_mm: f64,
    /// How many times the rails were doubled to hold the drawing.
    pub doublings: u32,
    /// The rails it was made on.
    pub rails: Rails,
}

/// How many times a loft's rails are doubled, at most, to bring its skinned faces within [`DRAWN_MM`] of the drawn
/// sections: up to four times the rails it starts with.
pub const MOST_DOUBLINGS: u32 = 2;

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

/// The faces of the loft and what each is, sides in piece order and then the two ends.
///
/// Each skinned side is read back against the drawing: at every station, the curve the kernel's surface runs along
/// there ([`skin_stations`]) is measured against that section's spline piece as drawn, both ways ([`apart`]). The
/// farthest is returned with the faces, in mm. The straight pieces' sides are ruled between the rails through the
/// drawn corners, so at each station they are the drawn line itself.
fn sheets(rails: &Rails) -> Result<(Vec<Sheet>, Vec<Part>, f64)> {
    let n = rails.rails.len();
    if !rails.ring_closed {
        return Err(Error::geometry(
            "loft",
            "open profiles make a surface, and an exact loft is a solid; close the profiles",
        ));
    }
    // a whole circle or ellipse on every profile is one piece all the way around, skinned across every rail and
    // back onto the first; arcs among other pieces are not made yet
    let round = |c: &Curve| matches!(c, Curve::Arc { .. } | Curve::Ellipse { .. });
    let whole = |c: &Curve| match *c {
        Curve::Arc { sweep, .. } | Curve::Ellipse { sweep, .. } => (sweep.abs() - TAU).abs() <= 1e-9,
        Curve::Line | Curve::Spline { .. } => false,
    };
    if rails.pieces.iter().any(|p| p.curves.iter().any(round)) {
        let one_whole = matches!(&rails.pieces[..], [p] if p.stretches == n && p.curves.iter().all(whole));
        if !one_whole {
            return Err(Error::geometry(
                "loft",
                "an exact loft is made only through profiles of straight lines and splines, or one whole circle or ellipse on every profile, for now; these have arcs",
            ));
        }
        if rails.wrap.is_some() {
            return Err(Error::geometry(
                "loft",
                "a closed loft through circles or ellipses is not made exact yet",
            ));
        }
    }
    let mut out = Vec::with_capacity(rails.pieces.len() + 2);
    let mut parts = Vec::with_capacity(rails.pieces.len() + 2);
    // for each skinned side, the curves it ends on at the first and last profiles
    let mut ends_of = Vec::with_capacity(rails.pieces.len());
    let mut drawn_mm = 0.0f64;
    for (k, piece) in rails.pieces.iter().enumerate() {
        if piece.curves.iter().all(|c| *c == Curve::Line) {
            let last = (piece.first + piece.stretches) % n;
            out.push(Sheet::Ruled(rail(rails, piece.first), rail(rails, last)));
            ends_of.push(None);
        } else {
            let across: Vec<Path> = (0..=piece.stretches)
                .map(|j| rail(rails, (piece.first + j) % n))
                .collect();
            let stations = skin_stations(&across).map_err(|e| kernel(&e))?;
            let count = rails.rings.len();
            for (k, station) in stations.iter().enumerate() {
                // a closed loft's last station is its first section again
                let (ring, curve) = (&rails.rings[k % count], &piece.curves[k % count]);
                let Some(spans) = curve.drawn_spans() else {
                    return Err(Error::geometry(
                        "loft",
                        "a skinned piece is a curve on every profile",
                    ));
                };
                let drawn = Path::Cubics(
                    spans
                        .iter()
                        .map(|span| span.map(|p| ring.frame.at(p, 0.0)))
                        .collect(),
                );
                drawn_mm = drawn_mm.max(apart(station, &drawn));
            }
            if rails.wrap.is_none()
                && let (Some(first), Some(last)) = (stations.first(), stations.last())
            {
                ends_of.push(Some((first.clone(), last.clone())));
            }
            out.push(Sheet::Skinned(across));
        }
        parts.push(Part::Side(k));
    }
    if rails.wrap.is_none() {
        let ends = [
            (rails.rings.first(), Part::First),
            (rails.rings.last(), Part::Last),
        ];
        for (ring, part) in ends {
            let Some(ring) = ring else { continue };
            // an end's rim runs straight along each straight piece, from its start to the next one's, and along
            // each skinned side's own end curve
            let corners: Vec<V3> = rails.pieces.iter().map(|p| ring.points[p.first]).collect();
            out.push(Sheet::Flat(
                ends_of
                    .iter()
                    .enumerate()
                    .map(|(k, ends)| match ends {
                        Some((first, last)) => {
                            if part == Part::First {
                                first.clone()
                            } else {
                                last.clone()
                            }
                        }
                        None => Path::Lines(vec![corners[k], corners[(k + 1) % corners.len()]]),
                    })
                    .collect(),
            ));
            parts.push(part);
        }
    }
    Ok((out, parts, drawn_mm))
}

/// Refused when a body would come out farther from its drawing than [`DRAWN_MM`].
fn within_drawing(drawn_mm: f64) -> Result<()> {
    if drawn_mm <= DRAWN_MM {
        Ok(())
    } else {
        Err(Error::geometry(
            "loft",
            format!("the exact solid came out more than {DRAWN_MM} mm from a drawn section"),
        ))
    }
}

/// A loft's rails and faces, held to its drawing.
struct Faces {
    rails: Rails,
    sheets: Vec<Sheet>,
    parts: Vec<Part>,
    /// How far its skinned faces are from the drawn sections at the stations, in mm.
    drawn_mm: f64,
    /// How many times its rails were doubled.
    doublings: u32,
}

/// The rails and faces of the loft through `profiles`, starting at `density` and doubled up to `most` times, until
/// its skinned faces are within [`DRAWN_MM`] of the drawn sections at every station. A loft with no skinned face
/// takes no doubling. Refused when they are not within it after the last doubling.
fn drawn_sheets(profiles: &[Profile], opts: &Options, density: &Density, most: u32) -> Result<Faces> {
    let mut density = *density;
    let mut doublings = 0;
    loop {
        let rails = match super::rails(profiles, opts, &density)? {
            Match::Rails(rails) => rails,
            Match::Unmatched(why) => return Err(Error::geometry("loft", why)),
        };
        let (sheets, parts, drawn_mm) = sheets(&rails)?;
        if drawn_mm <= DRAWN_MM || doublings == most {
            within_drawing(drawn_mm)?;
            return Ok(Faces {
                rails,
                sheets,
                parts,
                drawn_mm,
                doublings,
            });
        }
        density = Density {
            arc_step_deg: density.arc_step_deg / 2.0,
            least: density.least * 2,
        };
        doublings += 1;
    }
}

fn kind(sheet: &Sheet) -> Kind {
    match sheet {
        Sheet::Ruled(..) => Kind::Ruled,
        Sheet::Skinned(_) => Kind::Skinned,
        Sheet::Flat(_) => Kind::Flat,
    }
}

/// The loft through `rails` as a solid in the kernel.
///
/// Refuses open profiles, profiles with arcs, circles or ellipses, and anything the kernel cannot close into one
/// solid or whose edges it would move off the curves given, each with its reason; then no body is left behind.
pub fn lofted(rails: &Rails) -> Result<Lofted> {
    let (sheets, parts, drawn_mm) = sheets(rails)?;
    within_drawing(drawn_mm)?;
    stitched(rails.clone(), &sheets, &parts, drawn_mm, 0)
}

/// The loft through `profiles` as a solid in the kernel, on rails matched at `density` and doubled up to `most`
/// times until it holds its drawing (see [`drawn_sheets`]).
///
/// Refuses what [`lofted`] refuses, and a loft whose skinned faces are still more than [`DRAWN_MM`] from a drawn
/// section after the last doubling.
pub fn lofted_through(profiles: &[Profile], opts: &Options, density: &Density, most: u32) -> Result<Lofted> {
    let d = drawn_sheets(profiles, opts, density, most)?;
    stitched(d.rails, &d.sheets, &d.parts, d.drawn_mm, d.doublings)
}

fn stitched(rails: Rails, sheets: &[Sheet], parts: &[Part], drawn_mm: f64, doublings: u32) -> Result<Lofted> {
    let (body, order, off_mm) = Body::stitched_off(sheets).map_err(|e| kernel(&e))?;
    Ok(Lofted {
        body,
        parts: order.iter().map(|&s| parts[s]).collect(),
        kinds: order.iter().map(|&s| kind(&sheets[s])).collect(),
        off_mm,
        drawn_mm,
        doublings,
        rails,
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
    let (sheets, parts, drawn_mm) = sheets(rails)?;
    within_drawing(drawn_mm)?;
    held(rails, &sheets, &parts, mesh)
}

/// Refused when the body's triangles cannot be brought within the default chord of its surface inside the limits
/// tessellation keeps: a body is shown by its triangles, and none that miss its surface are handed out. The loft
/// is then made as a mesh, with this as the reason.
fn shown(body: &Body) -> Result<()> {
    let how = Tessellation::default();
    match body.tessellate(&how) {
        Ok(_) => Ok(()),
        Err(sx_brep::Error::Coarse { .. }) => Err(Error::geometry(
            "loft",
            format!(
                "the exact solid could not be shown within {} mm of its surface, so this loft was made as a mesh",
                how.chord_mm
            ),
        )),
        Err(other) => Err(kernel(&other)),
    }
}

fn held(rails: &Rails, sheets: &[Sheet], parts: &[Part], mesh: &mut TriMesh) -> Result<u32> {
    let (body, order) = Body::stitched(sheets).map_err(|e| kernel(&e))?;
    shown(&body)?;
    let same = same_faces(rails, parts, mesh);
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
/// The rails are doubled up to [`MOST_DOUBLINGS`] times until the solid holds its drawing ([`lofted_through`]).
///
/// Refuses, with the reason, profiles that cannot be matched piece to piece, a loft thickened into a shell, and one
/// that does not come within [`DRAWN_MM`] of its drawing. Whatever the mesh loft refuses is refused here in the same
/// words.
pub fn hold_through(profiles: &[Profile], opts: &Options, mesh: &mut TriMesh) -> Result<u32> {
    if opts.thicken.is_some() {
        return Err(Error::geometry(
            "loft",
            "a loft thickened into a shell is not made exact yet",
        ));
    }
    let d = drawn_sheets(profiles, opts, &Density::default(), MOST_DOUBLINGS)?;
    held(&d.rails, &d.sheets, &d.parts, mesh)
}
