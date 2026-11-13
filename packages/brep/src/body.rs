// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! a solid as a Rust value: made checked, read through its faces and edges, freed when dropped

use crate::error::{Error, Result};
use crate::kernel::{self, EdgeRef, FaceRef, Solid};
use crate::values::{Placement, Shape};
use std::marker::PhantomData;

/// A solid in the kernel.
///
/// Ownership lives here and nowhere else. A body owns its kernel solid: dropping the body frees it, and nothing
/// else may. An op that makes a body from others takes them by value when the kernel uses them up, so a result
/// that shares memory with an input can never be freed twice or read after it is gone. A [`Face`] or an [`Edge`]
/// borrows its body: it cannot outlive it, and cannot be held across a change to it.
///
/// No body exists unchecked. Every one is made by [`Body::checked`], which refuses bad inputs before the kernel
/// sees them and reads the result back before handing it out, because the kernel reports success for some bodies
/// that are not solids.
///
/// A body is tied to the thread that made it (it is neither `Send` nor `Sync`). Calls from several threads are
/// safe all the same: each call takes the kernel's one lock, the lock `call` takes.
///
/// ```compile_fail
/// let face = {
///     let body = sx_brep::Body::cuboid([0.0; 3], [1.0; 3]).unwrap();
///     body.faces().unwrap().remove(0)
/// };
/// face.surface();
/// ```
///
/// ```compile_fail
/// fn send<T: Send>(_: T) {}
/// send(sx_brep::Body::cuboid([0.0; 3], [1.0; 3]).unwrap());
/// ```
#[derive(Debug)]
pub struct Body {
    solid: Solid,
    // a raw pointer is neither Send nor Sync, and so neither is a body, with the kernel or without
    thread: PhantomData<*const ()>,
}

/// A face's key is below this: 52 bits, which a JSON number holds exactly.
const KEY_LIMIT: u64 = 1 << 52;

/// How far from a plane a face may be, in mm, and still be a plane where faces are sorted into kinds
/// ([`Face::flat_within`]): a tapered extrude's flat sides are ruled surfaces, flat to 1e-5 mm. A sorting only. What
/// the kernel made is checked against what it was given far more closely (`readback.rs`), and that limit is another.
/// The older operations sort by the same number (`cpp/sx_keys.h`).
pub const FLAT_KIND_MM: f64 = 1e-4;

/// How closely [`Body::volume`] asks the kernel to integrate, relative to the volume.
const VOLUME_ACCURACY: f64 = 1e-6;

/// How closely the read-back asks for the volume it tests. What it tests is that the volume is a number and above
/// zero, and within 1 percent a real part's volume cannot change sign, while the integral at [`VOLUME_ACCURACY`]
/// runs over every trimmed face and costs a hull with a few hundred portholes over a minute a cut. A body that is
/// open or not one manifold solid is caught by the edge and manifold checks before the volume is asked. The one
/// gap: a closed body of exactly no volume could read slightly above zero at this accuracy; no operation makes one.
const SOLID_TEST_ACCURACY: f64 = 1e-2;

fn finite(what: &'static str, v: f64) -> Result<()> {
    if v.is_finite() {
        Ok(())
    } else {
        Err(Error::input(what, "must be a finite number"))
    }
}

fn point(what: &'static str, p: [f64; 3]) -> Result<()> {
    p.into_iter().try_for_each(|c| finite(what, c))
}

fn positive(what: &'static str, v: f64) -> Result<()> {
    finite(what, v)?;
    if v > 0.0 {
        Ok(())
    } else {
        Err(Error::input(what, "must be more than 0 mm"))
    }
}

/// What is wrong with a body the kernel returned, from what was read back of it, or none for a solid.
fn not_a_solid(closed: bool, manifold: bool, volume: f64) -> Option<&'static str> {
    if !closed {
        Some("it is not closed")
    } else if !manifold {
        Some("it is not one manifold solid")
    } else if !volume.is_finite() {
        Some("its volume is not a number")
    } else if volume <= 0.0 {
        Some("it encloses no volume")
    } else {
        None
    }
}

impl Body {
    /// The one place a body is made. `inputs` refuses what the kernel must not be asked, in plain words, before
    /// `make` calls it. What the kernel then returns is read back: every edge closed between two face sides, one
    /// manifold solid, and a volume that is finite and above zero, asked for at [`SOLID_TEST_ACCURACY`]. Anything
    /// else is dropped here and refused.
    pub(crate) fn checked(
        op: &'static str,
        inputs: impl FnOnce() -> Result<()>,
        make: impl FnOnce() -> Result<Solid>,
    ) -> Result<Self> {
        inputs()?;
        let solid = make()?;
        let closed = solid.edges()?.iter().all(|edge| edge.is_manifold());
        if let Some(why) = not_a_solid(closed, solid.is_manifold()?, solid.volume(SOLID_TEST_ACCURACY)?) {
            return Err(Error::NotSolid { op, why });
        }
        Ok(Self {
            solid,
            thread: PhantomData,
        })
    }

    /// A box from its lowest corner, `size` mm along x, y and z.
    pub fn cuboid(corner: [f64; 3], size: [f64; 3]) -> Result<Self> {
        Self::checked(
            "box",
            || {
                point("corner", corner)?;
                size.into_iter().try_for_each(|s| positive("size", s))
            },
            || kernel::cuboid(corner.into(), size.into()),
        )
    }

    /// A cylinder standing on `base`, the center of its bottom, with its axis along z.
    pub fn cylinder(base: [f64; 3], radius: f64, height: f64) -> Result<Self> {
        Self::checked(
            "cylinder",
            || {
                point("base", base)?;
                positive("radius", radius)?;
                positive("height", height)
            },
            || kernel::cylinder(base.into(), radius, height),
        )
    }

    /// A cone standing on `base`, the center of its bottom, with its axis along z. `top_radius` is 0 for a point
    /// and at most `base_radius`.
    pub fn cone(base: [f64; 3], base_radius: f64, top_radius: f64, height: f64) -> Result<Self> {
        Self::checked(
            "cone",
            || {
                point("base", base)?;
                positive("base radius", base_radius)?;
                finite("top radius", top_radius)?;
                if !(0.0..=base_radius).contains(&top_radius) {
                    return Err(Error::input("top radius", "must be from 0 mm to the base radius"));
                }
                positive("height", height)
            },
            || kernel::cone(base.into(), base_radius, top_radius, height),
        )
    }

    pub fn sphere(center: [f64; 3], radius: f64) -> Result<Self> {
        Self::checked(
            "sphere",
            || {
                point("center", center)?;
                positive("radius", radius)
            },
            || kernel::sphere(center.into(), radius),
        )
    }

    /// The enclosed volume in mm3.
    pub fn volume(&self) -> Result<f64> {
        self.solid.volume(VOLUME_ACCURACY)
    }

    /// How far `point` is from the body's surface, in mm, whether it is outside the body or in it. The distance is
    /// to a real point of the surface, which on a thin body can be a point of its far side: then it is larger than
    /// the true nearest distance, never smaller.
    pub fn distance_to(&self, point: [f64; 3]) -> Result<f64> {
        self.solid.distance_to(point.into())
    }

    /// The tight box around the body: its lowest and highest corners.
    pub fn bounds(&self) -> Result<([f64; 3], [f64; 3])> {
        self.solid.bounds().map(|(min, max)| (min.into(), max.into()))
    }

    /// The faces, in the kernel's order. A face's place in this list is its number in a [`crate::Mesh`].
    pub fn faces(&self) -> Result<Vec<Face<'_>>> {
        Ok(self.solid.faces()?.into_iter().map(Face).collect())
    }

    /// The edges, in the kernel's order.
    pub fn edges(&self) -> Result<Vec<Edge<'_>>> {
        Ok(self.solid.edges()?.into_iter().map(Edge).collect())
    }

    /// The key on each face, in the order of [`Body::faces`]; 0 for a face without one. A key says which step of
    /// a history made the face. It is kept on the kernel's face, so the operations that make a body from this one
    /// carry it to the faces that come from that face.
    pub fn keys(&self) -> Result<Vec<u64>> {
        self.solid.keys()
    }

    /// Writes a key on each face, in the order of [`Body::faces`]; 0 leaves a face without one. Refused, with
    /// nothing changed, unless there is one key for each face and each is below 2^52.
    pub fn set_keys(&mut self, keys: &[u64]) -> Result<()> {
        if keys.len() != self.solid.faces()?.len() {
            return Err(Error::input("keys", "must be one for each face of the body"));
        }
        if keys.iter().any(|&key| key >= KEY_LIMIT) {
            return Err(Error::input("keys", "must be below 2^52"));
        }
        self.solid.set_keys(keys)
    }

    pub(crate) fn solid(&self) -> &Solid {
        &self.solid
    }
}

/// A kernel placement: an origin and three unit axes, `z` being `x` cross `y`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub origin: [f64; 3],
    pub x: [f64; 3],
    pub y: [f64; 3],
    pub z: [f64; 3],
}

impl From<Placement> for Frame {
    fn from(p: Placement) -> Self {
        Self {
            origin: p.origin.into(),
            x: p.x.into(),
            y: p.y.into(),
            z: p.z.into(),
        }
    }
}

/// The surface a face lies on, as the kernel holds it: the kernel's own type, and for the five analytic ones its
/// exact parameters. Nothing here says which side of the surface the solid is on; a mesh's winding does.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Surface {
    /// The plane through the frame's origin, spanned by its x and y, with its z as normal.
    Plane { frame: Frame },
    /// Points at `radius` from the frame's z axis.
    Cylinder { frame: Frame, radius: f64 },
    /// A cone about the frame's z axis, `radius` at the frame's origin. The half angle between surface and axis
    /// is positive where the cone widens along z, and 0 for a cylinder the kernel keeps as a cone, which has no
    /// apex.
    Cone {
        frame: Frame,
        radius: f64,
        half_angle_deg: f64,
        apex: Option<[f64; 3]>,
    },
    /// Points at `radius` from the frame's origin.
    Sphere { frame: Frame, radius: f64 },
    /// A circle of radius `minor` turned about the frame's z axis at `major` from it.
    Torus { frame: Frame, major: f64, minor: f64 },
    /// A B-spline surface.
    Spline,
    /// A curve turned about an axis, where the kernel keeps it that way and not as one of the kinds above.
    Revolved,
    /// A curve run along a straight line; an arc run along its own axis reads as a cylinder instead.
    Extruded,
    /// A blend between surfaces.
    Blend,
    /// A surface at a fixed distance from another.
    Offset,
    /// Any other kind, by the kernel's type number.
    Other { kernel_type: i64 },
}

impl From<Shape> for Surface {
    fn from(shape: Shape) -> Self {
        match shape {
            Shape::Plane(at) => Self::Plane { frame: at.into() },
            Shape::Cylinder { at, radius } => Self::Cylinder {
                frame: at.into(),
                radius,
            },
            Shape::Cone {
                at,
                radius,
                half_angle_deg,
                apex,
            } => Self::Cone {
                frame: at.into(),
                radius,
                half_angle_deg,
                apex: apex.map(Into::into),
            },
            Shape::Sphere { at, radius } => Self::Sphere {
                frame: at.into(),
                radius,
            },
            Shape::Torus { at, major, minor } => Self::Torus {
                frame: at.into(),
                major,
                minor,
            },
            Shape::Other(15002) => Self::Spline,
            Shape::Other(15020) => Self::Revolved,
            Shape::Other(15030) => Self::Extruded,
            Shape::Other(15040) => Self::Blend,
            Shape::Other(15400) => Self::Offset,
            Shape::Other(kernel_type) => Self::Other { kernel_type },
        }
    }
}

/// The kind of curve an edge follows, as the kernel holds it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Curve {
    Line,
    Circle,
    Ellipse,
    /// A B-spline curve. The kernel keeps arcs this way too.
    Spline,
    /// Any other kind, by the kernel's type number (0 for an edge with no curve).
    Other {
        kernel_type: i64,
    },
}

impl Curve {
    pub(crate) fn of(kernel_type: i64) -> Self {
        match kernel_type {
            14010 => Self::Line,
            14021 => Self::Circle,
            14022 => Self::Ellipse,
            14033 => Self::Spline,
            kernel_type => Self::Other { kernel_type },
        }
    }
}

/// A face of a body.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Face<'b>(FaceRef<'b>);

impl Face<'_> {
    pub fn surface(&self) -> Surface {
        self.0.shape().into()
    }

    /// How far `point` is from the face, within its outline, in mm. The distance is to a real point of the face,
    /// which on a thin body can be a point of its far side: then it is larger than the true nearest distance, never
    /// smaller.
    pub fn distance_to(&self, point: [f64; 3]) -> Result<f64> {
        self.0.distance_to(point.into())
    }

    /// Whether the face lies within `mm` of one plane, by the kernel's own test, whatever kind its surface is. Never
    /// for a distance that is not more than 0.
    pub fn flat_within(&self, mm: f64) -> bool {
        self.0.flat_within(mm)
    }
}

/// An edge of a body.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Edge<'b>(EdgeRef<'b>);

impl<'b> Edge<'b> {
    /// The faces the edge lies on, each once: two, or one for a seam where a face meets itself.
    pub fn faces(&self) -> Vec<Face<'b>> {
        self.0.faces().into_iter().map(Face).collect()
    }

    pub fn curve(&self) -> Curve {
        Curve::of(self.0.curve_type())
    }

    /// Whether its faces meet smoothly along it. False is a sharp edge.
    pub fn is_tangent(&self) -> bool {
        self.0.is_tangent()
    }

    /// Whether it starts and ends at one point, as a full circle does.
    pub fn is_closed(&self) -> bool {
        self.0.is_closed()
    }

    /// How far `point` is from the edge's curve, in mm. The distance is to a real point of the edge, and can be
    /// larger than the true nearest distance where the curve passes close to itself, never smaller.
    pub fn distance_to(&self, point: [f64; 3]) -> Result<f64> {
        self.0.distance_to(point.into())
    }

    /// Its start and end points, or none when it has no vertex.
    pub fn ends(&self) -> Option<([f64; 3], [f64; 3])> {
        self.0.ends().map(|(a, b)| (a.into(), b.into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inputs_are_refused_in_words_before_the_kernel_is_asked() {
        let asked = std::cell::Cell::new(false);
        let made = Body::checked(
            "sphere",
            || positive("radius", -1.0),
            || {
                asked.set(true);
                Err(Error::NoKernel)
            },
        );
        assert_eq!(made.err(), Some(Error::input("radius", "must be more than 0 mm")));
        assert!(!asked.get());
        assert_eq!(
            positive("height", f64::NAN),
            Err(Error::input("height", "must be a finite number"))
        );
        assert_eq!(
            point("center", [0.0, f64::INFINITY, 0.0]),
            Err(Error::input("center", "must be a finite number"))
        );
    }

    #[test]
    fn what_is_read_back_decides_whether_a_body_is_a_solid() {
        assert_eq!(not_a_solid(true, true, 8000.0), None);
        // a sheet, or a fillet the kernel left half built: open edges
        assert_eq!(not_a_solid(false, true, 8000.0), Some("it is not closed"));
        // closed edge by edge and still no solid
        assert_eq!(
            not_a_solid(true, false, 8000.0),
            Some("it is not one manifold solid")
        );
        assert_eq!(
            not_a_solid(true, true, f64::NAN),
            Some("its volume is not a number")
        );
        assert_eq!(
            not_a_solid(true, true, f64::INFINITY),
            Some("its volume is not a number")
        );
        // a turn about an axis through the profile comes back with no volume, and one inside out with less
        assert_eq!(not_a_solid(true, true, 0.0), Some("it encloses no volume"));
        assert_eq!(not_a_solid(true, true, -8000.0), Some("it encloses no volume"));
    }

    // why the radius is checked before the kernel is asked: it takes -1 without a word and makes the sphere of
    // radius 1, a good solid that nobody asked for, so no read-back can tell
    #[cfg(sx_brep_kernel)]
    #[allow(clippy::float_cmp, reason = "the same sphere twice gives the same numbers")]
    #[test]
    fn the_kernel_takes_a_sphere_of_radius_minus_one_for_radius_one() {
        let center: crate::values::Vec3 = [0.0; 3].into();
        let made =
            Body::checked("sphere", || Ok(()), || kernel::sphere(center, -1.0)).expect("the kernel's sphere");
        let asked = Body::sphere([0.0; 3], 1.0).expect("a sphere");
        assert_eq!(made.volume(), asked.volume());
        let surface = |body: &Body| body.faces().expect("faces")[0].surface();
        assert_eq!(surface(&made), surface(&asked));
        assert!(matches!(surface(&made), Surface::Sphere { radius, .. } if radius == 1.0));
    }
}
