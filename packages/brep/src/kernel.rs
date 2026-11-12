// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! the bridge to the kernel's C++: the calls we use, declared with the kernel's own signatures, and safe owners
//! for what they return
//!
//! Every `unsafe` block of the typed API is in this file. What leaves it is safe to use from anywhere in the crate:
//! a [`Solid`] owns its kernel body and frees it on drop, a [`FaceRef`] or an [`EdgeRef`] borrows its solid, and
//! plain data (points, numbers, lists) carries no pointers at all.
//!
//! The kernel has one global context and runs one call at a time. Each function here that other files can call
//! takes the crate's kernel lock first and keeps it until it returns; the private helpers ask for the [`Held`]
//! lock as proof. Nothing in this file decides what a good body or a good mesh is. It reports what the kernel says.

use crate::error::{Error, FailedFace, Result, Stage};
use crate::stitch::{Boundary, Path, Sheet};
use crate::values::{Params, Placement, Polygons, Shape, Vec3};
use cxx::memory::UniquePtrTarget;
use cxx::{ExternType, UniquePtr, type_id};
use std::collections::HashMap;
#[cfg(test)]
use std::ffi::CStr;
use std::ffi::{CString, c_long, c_ulong};
use std::marker::PhantomData;
use std::mem::offset_of;
use std::pin::Pin;
use std::ptr::{self, NonNull};
use std::sync::MutexGuard;
use std::sync::atomic::{AtomicU64, Ordering};

// the same sizes and offsets cpp/sx_kernel.h asserts of the kernel's types
const _: () = assert!(size_of::<Vec3>() == 24 && align_of::<Vec3>() == align_of::<f64>());
const _: () = assert!(offset_of!(Vec3, x) == 0 && offset_of!(Vec3, y) == 8 && offset_of!(Vec3, z) == 16);
const _: () = assert!(size_of::<Params>() == 40 && align_of::<Params>() == align_of::<f64>());
const _: () = assert!(offset_of!(Params, chord) == 0 && offset_of!(Params, curve_angle_deg) == 8);
const _: () = assert!(offset_of!(Params, surface_angle_deg) == 16 && offset_of!(Params, max_edge) == 24);
const _: () = assert!(offset_of!(Params, max_aspect) == 32);

/// The kernel's `long`: a status or a type code. Its width follows the platform, as the kernel's does.
#[repr(transparent)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Long(c_long);

/// The kernel's `ULONG`: a count or an index.
#[repr(transparent)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ULong(c_ulong);

/// The kernel's `SmExtent2d`, the part of a surface a face covers: the least u and v, then the most, handed back to
/// the kernel as it gave them and read for a surface's boundaries.
#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct Extent {
    corners: [f64; 4],
}
const _: () = assert!(size_of::<Extent>() == 32 && align_of::<Extent>() == align_of::<f64>());

/// The kernel's `SmBSplineCurveForm`: what a curve is known to be, beyond its control points.
#[repr(transparent)]
#[derive(Clone, Copy)]
pub(crate) struct CurveForm(#[allow(dead_code, reason = "the kernel reads it; nothing here does")] i32);

// SAFETY: Vec3 has the size, alignment and field offsets of SmVector3d, asserted above and in cpp/sx_kernel.h,
// which also tells cxx the type may be moved by copying its bytes.
unsafe impl ExternType for Vec3 {
    type Id = type_id!("SmVector3d");
    type Kind = cxx::kind::Trivial;
}
// SAFETY: as for Vec3, against SmTessellationParams.
unsafe impl ExternType for Params {
    type Id = type_id!("SmTessellationParams");
    type Kind = cxx::kind::Trivial;
}
// SAFETY: a transparent wrapper of C's long, which is what cpp/sx_kernel.h names SmLong.
unsafe impl ExternType for Long {
    type Id = type_id!("SmLong");
    type Kind = cxx::kind::Trivial;
}
// SAFETY: a transparent wrapper of C's unsigned long, which cpp/sx_kernel.h asserts ULONG is.
unsafe impl ExternType for ULong {
    type Id = type_id!("ULONG");
    type Kind = cxx::kind::Trivial;
}

// SAFETY: Extent has the size and alignment of SmExtent2d, asserted above and in cpp/sx_kernel.h, which also
// tells cxx the type may be moved by copying its bytes.
unsafe impl ExternType for Extent {
    type Id = type_id!("SmExtent2d");
    type Kind = cxx::kind::Trivial;
}
// SAFETY: a transparent wrapper of an int, which cpp/sx_kernel.h asserts the enum is as wide as.
unsafe impl ExternType for CurveForm {
    type Id = type_id!("SmBSplineCurveForm");
    type Kind = cxx::kind::Trivial;
}

// the kernel's codes; cpp/sx_kernel.h asserts each against the kernel's own macro
const SUCCESS: c_long = 1000;
const PLANE: c_long = 15011;
const CONE: c_long = 15012;
const CYLINDER: c_long = 15013;
const SPHERE: c_long = 15014;
const TORUS: c_long = 15015;
const EXTRUSION: c_long = 15030;
/// The angle under which the kernel itself calls two directions parallel (`SM_ANG_TOL_DEG`).
const ANGLE_TOL_DEG: f64 = 0.5;
/// A curve that claims to be nothing more than its control points (`SM_CF_UNSPECIFIED`).
const PLAIN_CURVE: CurveForm = CurveForm(6);
/// How far from one plane the kernel lets a flat face's loop be, mm. `stitch.rs` has already held the loop to far
/// less.
const FLAT_TOL_MM: f64 = 0.01;
/// The attributes a face's key is kept under, its low half and its high half, and the bits in a half
/// (`cpp/sx_keys.h`, which `cpp/sx_kernel.h` checks these against).
const KEY_LOW: c_ulong = 20101;
const KEY_HIGH: c_ulong = 20102;
const KEY_HALF_BITS: u32 = 26;
const KEY_HALF: u64 = (1 << KEY_HALF_BITS) - 1;

#[cxx::bridge]
mod ffi {
    unsafe extern "C++" {
        include!("sx_kernel.h");

        type SmLong = super::Long;
        type ULONG = super::ULong;
        type SmVector3d = super::Vec3;
        type SmTessellationParams = super::Params;
        type SmExtent2d = super::Extent;
        type SmBSplineCurveForm = super::CurveForm;

        type SmContext;
        type SmAxis2Placement;
        type SmBrep;
        type SmFace;
        type SmEdge;
        type SmVertex;
        type SmCurve;
        type SmBSplineCurve;
        type SmLine;
        type SmRegion;
        type SmSurface;
        type SmPlane;
        type SmCone;
        type SmCylinder;
        type SmSphere;
        type SmTorus;
        type SmPolyBrep;
        type SmPolyFace;
        type SmPolyLoop;
        type SmPolyEdge;
        type SmPolyVertex;
        type SmPolyVertAuxData;
        type SmTessellationFailure;
        type SmTessellationReport;
        type SmFaceArray;
        type SmEdgeArray;
        type SmPolyFaceArray;
        type SmPolyLoopArray;
        type SmPolyEdgeArray;
        type SmFailureArray;
        type SmPointArray;
        type SmNumberArray;
        type SmCountArray;
        type SmSplineArray;
        type SmCurveArray;
        type SmAttribute;
        type SmAttributeArray;

        // making bodies. Each can allocate, so each is declared with Result: a C++ exception under it comes back
        // as an error where a plain declaration would end the process.
        fn SmApiGetOrCreateContext() -> *mut SmContext;
        fn SmApiCreateBox(
            corner: &SmVector3d,
            dx: f64,
            dy: f64,
            dz: f64,
            out: &mut *mut SmBrep,
        ) -> Result<SmLong>;
        fn SmApiCreateCylinder(
            base: &SmVector3d,
            radius: f64,
            height: f64,
            out: &mut *mut SmBrep,
        ) -> Result<SmLong>;
        fn SmApiCreateCone(
            base: &SmVector3d,
            base_radius: f64,
            top_radius: f64,
            height: f64,
            out: &mut *mut SmBrep,
        ) -> Result<SmLong>;
        fn SmApiCreateSphere(center: &SmVector3d, radius: f64, out: &mut *mut SmBrep) -> Result<SmLong>;
        #[allow(dead_code)]
        unsafe fn SmApiReadBrepFromFile(
            name: *const c_char,
            ascii: i32,
            rebuild_trims: i32,
            out: &mut *mut SmBrep,
        ) -> Result<SmLong>;

        // curves, the faces between them, and a solid from faces
        unsafe fn SmApiCreateCanonicalCurve(
            points: &SmPointArray,
            knots: &SmNumberArray,
            multiplicities: &SmCountArray,
            weights: *const SmNumberArray,
            degree: ULONG,
            form: SmBSplineCurveForm,
            out: &mut *mut SmBSplineCurve,
        ) -> Result<SmLong>;
        fn SmApiCreateLineSegment(
            start: &SmVector3d,
            end: &SmVector3d,
            out: &mut *mut SmLine,
        ) -> Result<SmLong>;
        unsafe fn SmApiCreateRuledSurface(
            a: *mut SmBSplineCurve,
            b: *mut SmBSplineCurve,
            out: &mut *mut SmSurface,
        ) -> Result<SmLong>;
        fn SmApiCreateSkin(across: &SmSplineArray, out: &mut *mut SmSurface) -> Result<SmLong>;
        fn GetNaturalUVDomain(self: &SmSurface) -> SmExtent2d;
        unsafe fn CreateFaceFromSurface(
            self: Pin<&mut SmBrep>,
            surface: *mut SmSurface,
            domain: &SmExtent2d,
            out: &mut *mut SmFace,
        ) -> Result<SmLong>;
        unsafe fn CreatePlanarFaceWith3DCurves(
            self: Pin<&mut SmBrep>,
            region: *mut SmRegion,
            sides: &SmCurveArray,
            flat_tolerance: f64,
            out: &mut *mut SmFace,
        ) -> Result<SmLong>;
        unsafe fn SmApiStitchIntoSolid(
            body: *mut SmBrep,
            solid: &mut i32,
            joined_edges: &mut ULONG,
            widest_vertex_gap: &mut f64,
            widest_edge_gap: &mut f64,
        ) -> Result<SmLong>;

        unsafe fn SmApiWriteBrepToFile(
            body: *const SmBrep,
            name: *const c_char,
            ascii: i32,
        ) -> Result<SmLong>;

        // reading a body
        unsafe fn SmApiBrepIsManifoldSolid(body: *const SmBrep, out: &mut i32) -> Result<SmLong>;
        unsafe fn SmApiBrepComputeVolume(body: *const SmBrep, accuracy: f64, out: &mut f64)
        -> Result<SmLong>;
        unsafe fn SmApiBrepBoundingBox(
            body: *const SmBrep,
            tight: i32,
            min: &mut SmVector3d,
            max: &mut SmVector3d,
        ) -> Result<SmLong>;
        unsafe fn SmApiGetFaces(body: *mut SmBrep, out: Pin<&mut SmFaceArray>) -> Result<SmLong>;
        unsafe fn SmApiGetEdges(body: *mut SmBrep, out: Pin<&mut SmEdgeArray>) -> Result<SmLong>;

        // faces and their surfaces
        fn GetSurface(self: &SmFace) -> *mut SmSurface;
        fn GetType(self: &SmSurface) -> SmLong;
        #[cxx_name = "sx_flat"]
        fn flat(surface: &SmSurface, within_mm: f64) -> Result<bool>;
        #[cxx_name = "sx_extruded_cylinder"]
        fn extruded_cylinder(
            surface: &SmSurface,
            frame: Pin<&mut SmAxis2Placement>,
            radius: &mut f64,
        ) -> bool;
        fn GetPosition(self: &SmPlane) -> &SmAxis2Placement;
        fn GetCanonical(self: &SmCylinder, frame: Pin<&mut SmAxis2Placement>, radius: &mut f64) -> SmLong;
        unsafe fn GetCanonical(
            self: &SmCone,
            frame: Pin<&mut SmAxis2Placement>,
            radius: &mut f64,
            half_angle_deg: &mut f64,
            swap_uv: *mut i32,
            inside_out: *mut i32,
        ) -> SmLong;
        fn GetApex(self: &SmCone, no_apex: &mut i32, apex: &mut SmVector3d, at: &mut f64) -> SmLong;
        unsafe fn GetCanonical(
            self: &SmSphere,
            frame: Pin<&mut SmAxis2Placement>,
            radius: &mut f64,
            swap_uv: *mut i32,
            inside_out: *mut i32,
        ) -> SmLong;
        unsafe fn GetCanonical(
            self: &SmTorus,
            frame: Pin<&mut SmAxis2Placement>,
            major: &mut f64,
            minor: &mut f64,
            swap_uv: *mut i32,
            inside_out: *mut i32,
        ) -> SmLong;
        fn GetOrigin(self: &SmAxis2Placement) -> SmVector3d;
        fn GetXAxis(self: &SmAxis2Placement) -> SmVector3d;
        fn GetYAxis(self: &SmAxis2Placement) -> SmVector3d;
        fn GetZAxis(self: &SmAxis2Placement) -> SmVector3d;

        // edges
        unsafe fn GetFaces(self: &SmEdge, out: Pin<&mut SmFaceArray>, attribute: *mut ULONG);
        fn GetCurve(self: &SmEdge) -> *mut SmCurve;
        fn GetType(self: &SmCurve) -> SmLong;
        fn GetStartVertex(self: &SmEdge) -> *mut SmVertex;
        fn GetEndVertex(self: &SmEdge) -> *mut SmVertex;
        fn GetPoint(self: &SmVertex) -> SmVector3d;
        fn IsClosed(self: &SmEdge) -> i32;
        fn IsManifold(self: &SmEdge) -> i32;
        fn IsTangentEdge(self: &SmEdge, tolerance_deg: f64, coincidence: i32) -> i32;
        unsafe fn SmApiEdgeClosestPoint(
            edge: *mut SmEdge,
            point: &SmVector3d,
            closest: &mut SmVector3d,
            parameter: &mut f64,
            distance: &mut f64,
        ) -> Result<SmLong>;

        // tessellating
        unsafe fn SmApiTessellate(
            body: *mut SmBrep,
            out: &mut *mut SmPolyBrep,
            params: &SmTessellationParams,
            allow_partial: i32,
            failures: *mut SmFailureArray,
            report: *mut SmTessellationReport,
        ) -> Result<SmLong>;
        unsafe fn GetPolyFaces(self: &SmPolyBrep, out: Pin<&mut SmPolyFaceArray>, of_face: *mut SmFace);
        fn GetOriginalFace(self: &SmPolyFace) -> *mut SmFace;
        fn GetPolyLoops(self: &SmPolyFace, out: Pin<&mut SmPolyLoopArray>);
        fn GetPolyEdges(self: &SmPolyLoop, out: Pin<&mut SmPolyEdgeArray>);
        fn GetStartPolyVertex(self: &SmPolyEdge) -> *mut SmPolyVertex;
        fn GetAuxData(self: &SmPolyEdge) -> *mut SmPolyVertAuxData;
        fn GetPoint(self: &SmPolyVertex) -> SmVector3d;

        // the kernel's arrays, one set per element type
        fn GetSize(self: &SmFaceArray) -> ULONG;
        fn GetAt(self: &SmFaceArray, index: ULONG) -> &*mut SmFace;
        fn GetSize(self: &SmEdgeArray) -> ULONG;
        fn GetAt(self: &SmEdgeArray, index: ULONG) -> &*mut SmEdge;
        fn GetSize(self: &SmPolyFaceArray) -> ULONG;
        fn GetAt(self: &SmPolyFaceArray, index: ULONG) -> &*mut SmPolyFace;
        fn GetSize(self: &SmPolyLoopArray) -> ULONG;
        fn GetAt(self: &SmPolyLoopArray, index: ULONG) -> &*mut SmPolyLoop;
        fn GetSize(self: &SmPolyEdgeArray) -> ULONG;
        fn GetAt(self: &SmPolyEdgeArray, index: ULONG) -> &*mut SmPolyEdge;
        fn GetSize(self: &SmFailureArray) -> ULONG;
        fn GetAt(self: &SmFailureArray, index: ULONG) -> &SmTessellationFailure;
        fn Add(self: Pin<&mut SmPointArray>, point: SmVector3d) -> ULONG;
        fn Add(self: Pin<&mut SmNumberArray>, number: f64) -> ULONG;
        fn Add(self: Pin<&mut SmCountArray>, count: ULONG) -> ULONG;
        unsafe fn Add(self: Pin<&mut SmSplineArray>, curve: *mut SmBSplineCurve) -> ULONG;
        unsafe fn Add(self: Pin<&mut SmCurveArray>, curve: *mut SmCurve) -> ULONG;

        // a face's attributes, where its key is kept. Each call can allocate, so each is declared with Result.
        fn GetAttributes(self: &SmFace, out: Pin<&mut SmAttributeArray>) -> Result<()>;
        unsafe fn AddAttribute(self: Pin<&mut SmFace>, attribute: *mut SmAttribute) -> Result<()>;
        unsafe fn RemoveAttribute(
            self: Pin<&mut SmFace>,
            attribute: *mut SmAttribute,
            keep: i32,
        ) -> Result<()>;
        fn GetAttributeID(self: &SmAttribute) -> ULONG;
        fn GetNumLongElements(self: &SmAttribute) -> ULONG;
        fn GetLongElementsAddress(self: &SmAttribute) -> *const SmLong;
        fn GetSize(self: &SmAttributeArray) -> ULONG;
        fn GetAt(self: &SmAttributeArray, index: ULONG) -> &*mut SmAttribute;

        // the hand-over (the end of cpp/sx_brep.cpp, which explains the three). Temporary: they go with
        // src/handover.rs.
        unsafe fn sx_brep_lend(body: *mut SmBrep) -> Result<SmLong>;
        fn sx_brep_take_back(number: SmLong);
        fn sx_brep_adopt(number: SmLong) -> *mut SmBrep;

        // what a binding cannot say (cpp/sx_kernel.h): constructors, casts, public data members
        #[cxx_name = "sx_new"]
        fn new_face_array() -> UniquePtr<SmFaceArray>;
        #[cxx_name = "sx_new"]
        fn new_edge_array() -> UniquePtr<SmEdgeArray>;
        #[cxx_name = "sx_new"]
        fn new_poly_face_array() -> UniquePtr<SmPolyFaceArray>;
        #[cxx_name = "sx_new"]
        fn new_poly_loop_array() -> UniquePtr<SmPolyLoopArray>;
        #[cxx_name = "sx_new"]
        fn new_poly_edge_array() -> UniquePtr<SmPolyEdgeArray>;
        #[cxx_name = "sx_new"]
        fn new_failure_array() -> UniquePtr<SmFailureArray>;
        #[cxx_name = "sx_new"]
        fn new_point_array() -> UniquePtr<SmPointArray>;
        #[cxx_name = "sx_new"]
        fn new_number_array() -> UniquePtr<SmNumberArray>;
        #[cxx_name = "sx_new"]
        fn new_count_array() -> UniquePtr<SmCountArray>;
        #[cxx_name = "sx_new"]
        fn new_spline_array() -> UniquePtr<SmSplineArray>;
        #[cxx_name = "sx_new"]
        fn new_curve_array() -> UniquePtr<SmCurveArray>;
        #[cxx_name = "sx_new"]
        fn new_attribute_array() -> UniquePtr<SmAttributeArray>;
        fn sx_long_attribute(id: ULONG, value: SmLong, out: &mut *mut SmAttribute) -> Result<SmLong>;
        #[cxx_name = "sx_new"]
        fn new_body() -> UniquePtr<SmBrep>;
        #[cxx_name = "sx_make"]
        fn new_frame() -> UniquePtr<SmAxis2Placement>;
        #[cxx_name = "sx_cast"]
        unsafe fn as_plane(surface: *const SmSurface) -> *const SmPlane;
        #[cxx_name = "sx_cast"]
        unsafe fn as_cone(surface: *const SmSurface) -> *const SmCone;
        #[cxx_name = "sx_cast"]
        unsafe fn as_cylinder(surface: *const SmSurface) -> *const SmCylinder;
        #[cxx_name = "sx_cast"]
        unsafe fn as_sphere(surface: *const SmSurface) -> *const SmSphere;
        #[cxx_name = "sx_cast"]
        unsafe fn as_torus(surface: *const SmSurface) -> *const SmTorus;
        #[cxx_name = "sx_cast"]
        unsafe fn line_as_spline(line: *const SmLine) -> *const SmBSplineCurve;
        #[cxx_name = "sx_cast"]
        unsafe fn spline_as_curve(curve: *const SmBSplineCurve) -> *const SmCurve;
        fn sx_normal(aux: &SmPolyVertAuxData) -> &SmVector3d;
        fn sx_failed_face(failure: &SmTessellationFailure) -> ULONG;
        fn sx_failed_stage(failure: &SmTessellationFailure) -> i32;
        fn sx_failed_status(failure: &SmTessellationFailure) -> SmLong;
        // how the kernel reads a value Rust wrote, for the layout tests below
        #[allow(dead_code)]
        fn sx_coordinate(v: &SmVector3d, axis: i32) -> f64;
        fn sx_surface_curve(
            surface: &SmSurface,
            direction: i32,
            at: f64,
            knots: &mut Vec<f64>,
            points: &mut Vec<f64>,
            about: &mut Vec<f64>,
        ) -> Result<SmLong>;
        #[allow(dead_code)]
        fn sx_control(p: &SmTessellationParams, which: i32) -> f64;
    }

    impl UniquePtr<SmBrep> {}
    impl UniquePtr<SmPolyBrep> {}
    impl UniquePtr<SmBSplineCurve> {}
    impl UniquePtr<SmSurface> {}
}

/// The kernel, held: nothing else enters it until this drops.
struct Held {
    _lock: MutexGuard<'static, ()>,
}

fn held() -> Held {
    let lock = crate::hold();
    // the kernel makes its context the first time anything asks; ask under the lock, before any other call
    ffi::SmApiGetOrCreateContext();
    Held { _lock: lock }
}

/// A kernel `long` as the i64 the rest of the crate keeps codes in.
#[allow(
    clippy::useless_conversion,
    reason = "long is 32 bits wide on Windows and 64 elsewhere"
)]
fn wide(v: c_long) -> i64 {
    i64::from(v)
}

/// An exception caught at the bridge, as an error.
fn caught<T>(op: &'static str, result: std::result::Result<T, cxx::Exception>) -> Result<T> {
    result.map_err(|e| Error::Threw {
        op,
        what: e.what().to_owned(),
    })
}

/// A call's status, with an exception caught at the bridge turned into an error.
fn status_of(op: &'static str, status: std::result::Result<Long, cxx::Exception>) -> Result<c_long> {
    caught(op, status).map(|Long(status)| status)
}

/// A number as a kernel `long`, or none where it does not fit one.
#[allow(
    clippy::unnecessary_fallible_conversions,
    reason = "long is 32 bits wide on Windows and 64 elsewhere"
)]
fn narrow(v: i64) -> Option<c_long> {
    c_long::try_from(v).ok()
}

/// Success, or a refusal with the kernel's code.
fn check(op: &'static str, status: std::result::Result<Long, cxx::Exception>) -> Result<()> {
    match status_of(op, status)? {
        SUCCESS => Ok(()),
        status => Err(Error::Kernel {
            op,
            status: wide(status),
        }),
    }
}

/// One of the kernel's arrays.
trait Array {
    type Item;
    fn len(&self) -> usize;
    fn at(&self, index: usize) -> Option<Self::Item>;
}

macro_rules! pointer_arrays {
    ($($array:ty: $item:ty),* $(,)?) => {$(
        impl Array for $array {
            type Item = NonNull<$item>;
            fn len(&self) -> usize {
                usize::try_from(self.GetSize().0).unwrap_or(usize::MAX)
            }
            fn at(&self, index: usize) -> Option<NonNull<$item>> {
                c_ulong::try_from(index).ok().and_then(|i| NonNull::new(*self.GetAt(ULong(i))))
            }
        }
    )*};
}
pointer_arrays!(
    ffi::SmFaceArray: ffi::SmFace,
    ffi::SmEdgeArray: ffi::SmEdge,
    ffi::SmPolyFaceArray: ffi::SmPolyFace,
    ffi::SmPolyLoopArray: ffi::SmPolyLoop,
    ffi::SmPolyEdgeArray: ffi::SmPolyEdge,
    ffi::SmAttributeArray: ffi::SmAttribute,
);

/// The array's pointers, in order. A null entry is left out; the kernel does not hand those out.
fn items<A: Array + UniquePtrTarget>(array: &UniquePtr<A>) -> Vec<A::Item> {
    array
        .as_ref()
        .map_or_else(Vec::new, |a| (0..a.len()).filter_map(|i| a.at(i)).collect())
}

/// A solid in the kernel. Dropping it frees the kernel's body.
pub(crate) struct Solid {
    brep: UniquePtr<ffi::SmBrep>,
}

impl std::fmt::Debug for Solid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Solid")
    }
}

impl Drop for Solid {
    fn drop(&mut self) {
        // freeing is a kernel call like any other
        let _kernel = held();
        self.brep = UniquePtr::null();
    }
}

/// Owns what a making call returned, or says why there is nothing to own.
fn adopt(
    _kernel: &Held,
    op: &'static str,
    status: std::result::Result<Long, cxx::Exception>,
    raw: *mut ffi::SmBrep,
) -> Result<Solid> {
    // an exception: what the kernel freed on the way out is unknown, so the pointer is left alone. A leak, never
    // a second free.
    let status = status_of(op, status)?;
    // SAFETY: a body returned through a making call's out parameter belongs to the caller, and nothing else
    // holds it; the kernel allocated it with the operator new that its own delete, which UniquePtr calls,
    // matches. Null stays null.
    let brep = unsafe { UniquePtr::from_raw(raw) };
    // a refusal drops `brep` here, under the lock the caller holds
    if status != SUCCESS {
        return Err(Error::Kernel {
            op,
            status: wide(status),
        });
    }
    if brep.is_null() {
        return Err(Error::NotSolid {
            op,
            why: "the kernel made nothing",
        });
    }
    Ok(Solid { brep })
}

/// A box from its lowest corner, `size` along x, y and z.
pub(crate) fn cuboid(corner: Vec3, size: Vec3) -> Result<Solid> {
    let kernel = held();
    let mut raw = ptr::null_mut();
    let status = ffi::SmApiCreateBox(&corner, size.x, size.y, size.z, &mut raw);
    adopt(&kernel, "box", status, raw)
}

/// A cylinder standing on `base`, its axis along z.
pub(crate) fn cylinder(base: Vec3, radius: f64, height: f64) -> Result<Solid> {
    let kernel = held();
    let mut raw = ptr::null_mut();
    let status = ffi::SmApiCreateCylinder(&base, radius, height, &mut raw);
    adopt(&kernel, "cylinder", status, raw)
}

/// A cone standing on `base`, its axis along z, cut off at `top_radius` (0 for a point).
pub(crate) fn cone(base: Vec3, base_radius: f64, top_radius: f64, height: f64) -> Result<Solid> {
    let kernel = held();
    let mut raw = ptr::null_mut();
    let status = ffi::SmApiCreateCone(&base, base_radius, top_radius, height, &mut raw);
    adopt(&kernel, "cone", status, raw)
}

pub(crate) fn sphere(center: Vec3, radius: f64) -> Result<Solid> {
    let kernel = held();
    let mut raw = ptr::null_mut();
    let status = ffi::SmApiCreateSphere(&center, radius, &mut raw);
    adopt(&kernel, "sphere", status, raw)
}

/// A body from a file of the kernel's own text format. Only the tests read one so far.
#[cfg(test)]
pub(crate) fn read_text(file: &CStr) -> Result<Solid> {
    let kernel = held();
    let mut raw = ptr::null_mut();
    // SAFETY: `file` is a NUL-terminated string that outlives the call; the kernel only reads it.
    let status = unsafe { ffi::SmApiReadBrepFromFile(file.as_ptr(), 1, 1, &mut raw) };
    adopt(&kernel, "load", status, raw)
}

/// Owns what a call made, a curve or a surface, or says why there is nothing to own.
fn own<T: UniquePtrTarget>(
    _kernel: &Held,
    op: &'static str,
    status: std::result::Result<Long, cxx::Exception>,
    raw: *mut T,
) -> Result<UniquePtr<T>> {
    // an exception: the pointer is left alone, as in `adopt`
    let status = status_of(op, status)?;
    // SAFETY: what a making call returns through its out parameter belongs to the caller, and nothing else holds
    // it; the kernel allocated it with the operator new that its own delete, which UniquePtr calls, matches. Null
    // stays null.
    let made = unsafe { UniquePtr::from_raw(raw) };
    if status != SUCCESS {
        return Err(Error::Kernel {
            op,
            status: wide(status),
        });
    }
    if made.is_null() {
        return Err(Error::NotSolid {
            op,
            why: "the kernel made nothing",
        });
    }
    Ok(made)
}

/// A count as the kernel's `ULONG`.
#[allow(
    clippy::useless_conversion,
    reason = "unsigned long is 32 bits wide on Windows and 64 elsewhere"
)]
fn count(n: u32) -> ULong {
    ULong(c_ulong::from(n))
}

/// A curve as one B-spline that is exactly its control points: straight pieces at degree 1, cubic Bezier pieces at
/// degree 3. Piece `k` runs over the parameters from `k` to `k + 1`, so two curves with as many pieces are at the
/// same piece and the same share of it at any one parameter.
fn spline(kernel: &Held, path: &Path) -> Result<UniquePtr<ffi::SmBSplineCurve>> {
    let (degree, pieces, controls): (u32, usize, Vec<Vec3>) = match path {
        Path::Lines(points) => (
            1,
            points.len().saturating_sub(1),
            points.iter().map(|&p| p.into()).collect(),
        ),
        Path::Cubics(spans) => (
            3,
            spans.len(),
            spans
                .iter()
                .enumerate()
                // each piece after the first starts on the point the one before ends on, which goes in once
                .flat_map(|(k, span)| &span[usize::from(k > 0)..])
                .map(|&p| p.into())
                .collect(),
        ),
    };
    let pieces = u32::try_from(pieces).map_err(|_| Error::input("curve", "has too many pieces"))?;
    let (mut points, mut knots, mut repeats) = (
        ffi::new_point_array(),
        ffi::new_number_array(),
        ffi::new_count_array(),
    );
    for point in controls {
        points.pin_mut().Add(point);
    }
    for k in 0..=pieces {
        knots.pin_mut().Add(f64::from(k));
        // an end knot once more than the degree pins the curve to its end points; an inner one as often as the
        // degree lets each piece keep its own control points
        let at_end = k == 0 || k == pieces;
        repeats.pin_mut().Add(count(degree + u32::from(at_end)));
    }
    let mut raw = ptr::null_mut();
    // SAFETY: the three arrays are live and the kernel only reads them; null weights says the curve has none.
    let status = unsafe {
        ffi::SmApiCreateCanonicalCurve(
            &points,
            &knots,
            &repeats,
            ptr::null(),
            count(degree),
            PLAIN_CURVE,
            &mut raw,
        )
    };
    own(kernel, "curve", status, raw)
}

/// The straight piece from `a` to `b`, as the kernel's own line: the kind of curve a flat face's straight sides
/// are given as.
fn segment(kernel: &Held, a: Vec3, b: Vec3) -> Result<UniquePtr<ffi::SmBSplineCurve>> {
    let mut raw = ptr::null_mut();
    let status = ffi::SmApiCreateLineSegment(&a, &b, &mut raw);
    // SAFETY: the kernel's line is a B-spline curve by inheritance, so the cast is to its own base class; null
    // stays null.
    let raw = unsafe { ffi::line_as_spline(raw) }.cast_mut();
    own(kernel, "line", status, raw)
}

/// The surface a call made as a face of `body` over its whole extent. The body takes the surface.
fn face_on(
    kernel: &Held,
    body: &mut UniquePtr<ffi::SmBrep>,
    op: &'static str,
    status: std::result::Result<Long, cxx::Exception>,
    raw: *mut ffi::SmSurface,
) -> Result<NonNull<ffi::SmFace>> {
    let surface = own(kernel, op, status, raw)?;
    let extent = surface.GetNaturalUVDomain();
    let mut face = ptr::null_mut();
    // SAFETY: the body and the surface are live. The kernel keeps the surface's pointer in the new face.
    let status = unsafe {
        body.pin_mut()
            .CreateFaceFromSurface(surface.as_mut_ptr(), &extent, &mut face)
    };
    let code = match status_of("face", status) {
        Ok(code) => code,
        Err(e) => {
            // an exception: whether the body took the surface is unknown, so it is let go and never freed here.
            // A leak, never a second free.
            let _ = surface.into_raw();
            return Err(e);
        }
    };
    if code != SUCCESS {
        // refused: the surface is still ours and is dropped here
        return Err(Error::Kernel {
            op: "face",
            status: wide(code),
        });
    }
    // the body owns the surface from here on
    let _ = surface.into_raw();
    NonNull::new(face).ok_or(Error::NotSolid {
        op: "face",
        why: "the kernel made nothing",
    })
}

/// A flat face of `body` inside a closed loop of curves. The body takes the curves.
fn flat_face(
    kernel: &Held,
    body: &mut UniquePtr<ffi::SmBrep>,
    sides: &[Path],
) -> Result<NonNull<ffi::SmFace>> {
    let mut curves = Vec::new();
    for side in sides {
        match side {
            Path::Lines(points) => {
                for pair in points.windows(2) {
                    curves.push(segment(kernel, pair[0].into(), pair[1].into())?);
                }
            }
            Path::Cubics(_) => curves.push(spline(kernel, side)?),
        }
    }
    let mut around = ffi::new_curve_array();
    for curve in &curves {
        // SAFETY: a B-spline curve is a curve by inheritance, so the cast is to its own base class; the array
        // only holds the pointer.
        unsafe {
            let curve = ffi::spline_as_curve(curve.as_ptr()).cast_mut();
            around.pin_mut().Add(curve);
        }
    }
    let mut face = ptr::null_mut();
    // SAFETY: the body, the array and every curve in it are live; a null region is the kernel's word for the
    // space around the body.
    let status = unsafe {
        body.pin_mut()
            .CreatePlanarFaceWith3DCurves(ptr::null_mut(), &around, FLAT_TOL_MM, &mut face)
    };
    // The kernel builds the face's edges on these very curves. Once it has been asked, which of them it took is
    // known only when it says the face is made, and then it took them all; on any other answer they are let go
    // as well and never freed here. A leak, never a second free.
    for curve in curves {
        let _ = curve.into_raw();
    }
    check("flat face", status)?;
    NonNull::new(face).ok_or(Error::NotSolid {
        op: "flat face",
        why: "the kernel made nothing",
    })
}

/// The kernel's surface skinned across `rails`: what it said, and the surface it made for the caller to own.
fn skin(
    kernel: &Held,
    rails: &[Path],
) -> Result<(std::result::Result<Long, cxx::Exception>, *mut ffi::SmSurface)> {
    let curves = rails
        .iter()
        .map(|rail| spline(kernel, rail))
        .collect::<Result<Vec<_>>>()?;
    let mut across = ffi::new_spline_array();
    for curve in &curves {
        // SAFETY: the array only holds the pointer, and `curves` outlives it.
        unsafe { across.pin_mut().Add(curve.as_mut_ptr()) };
    }
    let mut raw = ptr::null_mut();
    let status = ffi::SmApiCreateSkin(&across, &mut raw);
    Ok((status, raw))
}

/// The faces of `sheets` made in one body and joined along their shared sides into a solid, with each face's
/// place in `sheets` in the order the solid lists its faces, and the widest gap the kernel closed between two
/// faces to join them, in mm. Refused when the kernel does not call the result one closed solid, or when it has
/// other faces than the ones made.
pub(crate) fn stitched(sheets: &[Sheet]) -> Result<(Solid, Vec<usize>, f64)> {
    let kernel = held();
    let mut body = ffi::new_body();
    if body.is_null() {
        return Err(Error::NotSolid {
            op: "stitch",
            why: "the kernel made nothing",
        });
    }
    let mut made = Vec::with_capacity(sheets.len());
    for sheet in sheets {
        made.push(match sheet {
            Sheet::Ruled(a, b) => {
                let (a, b) = (spline(&kernel, a)?, spline(&kernel, b)?);
                let mut raw = ptr::null_mut();
                // SAFETY: both curves are live; the kernel reads them and makes a surface of its own.
                let status =
                    unsafe { ffi::SmApiCreateRuledSurface(a.as_mut_ptr(), b.as_mut_ptr(), &mut raw) };
                face_on(&kernel, &mut body, "ruled face", status, raw)?
            }
            Sheet::Skinned(rails) => {
                let (status, raw) = skin(&kernel, rails)?;
                face_on(&kernel, &mut body, "skinned face", status, raw)?
            }
            Sheet::Flat(sides) => flat_face(&kernel, &mut body, sides)?,
        });
    }
    let (mut solid, mut joined, mut vertex_gap, mut edge_gap) = (0, ULong(0), 0.0, 0.0);
    // SAFETY: the body is live and ours; the kernel joins its faces in place.
    check("stitch", unsafe {
        ffi::SmApiStitchIntoSolid(
            body.as_mut_ptr(),
            &mut solid,
            &mut joined,
            &mut vertex_gap,
            &mut edge_gap,
        )
    })?;
    if solid == 0 {
        return Err(Error::NotSolid {
            op: "stitch",
            why: "its faces do not close",
        });
    }
    // read with the body still a plain pointer: a refusal below frees it here, under the lock this call holds
    let mut array = ffi::new_face_array();
    // SAFETY: the body is live; the kernel only reads it here.
    check("faces", unsafe {
        ffi::SmApiGetFaces(body.as_mut_ptr(), array.pin_mut())
    })?;
    let faces = items(&array);
    let order: Vec<usize> = faces
        .iter()
        .filter_map(|face| made.iter().position(|m| m == face))
        .collect();
    let mut seen = order.clone();
    seen.sort_unstable();
    seen.dedup();
    if faces.len() != made.len() || seen.len() != made.len() {
        return Err(Error::NotSolid {
            op: "stitch",
            why: "the kernel changed its faces while joining them",
        });
    }
    Ok((Solid { brep: body }, order, f64::max(vertex_gap, edge_gap)))
}

/// Curves of the surface a face skinned across `rails` is made on, as the kernel reads them off it: for each of
/// `at`, the curve along which its first parameter (0) or its second (1) holds at the given share of its domain.
pub(crate) fn skin_curves(rails: &[Path], at: &[(i32, f64)]) -> Result<Vec<Boundary>> {
    let kernel = held();
    let (status, raw) = skin(&kernel, rails)?;
    let surface = own(&kernel, "skinned face", status, raw)?;
    let [u0, v0, u1, v1] = surface.GetNaturalUVDomain().corners;
    let mut out = Vec::with_capacity(at.len());
    for &(direction, share) in at {
        let (from, to) = if direction == 0 { (u0, u1) } else { (v0, v1) };
        let at = if share >= 1.0 {
            to
        } else {
            from + (to - from) * share
        };
        let (mut knots, mut points, mut about) = (Vec::new(), Vec::new(), Vec::new());
        check(
            "skinned face curve",
            ffi::sx_surface_curve(&surface, direction, at, &mut knots, &mut points, &mut about),
        )?;
        let [degree, rational, gap] = about[..] else {
            return Err(Error::NotSolid {
                op: "skinned face curve",
                why: "the kernel did not say what curve it read",
            });
        };
        out.push(Boundary {
            degree,
            rational: rational > 0.5,
            knots,
            points: points.as_chunks::<3>().0.to_vec(),
            gap,
        });
    }
    Ok(out)
}

/// A face of a solid. It borrows the solid, so it cannot outlive it or be held while the solid changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct FaceRef<'s> {
    ptr: NonNull<ffi::SmFace>,
    solid: PhantomData<&'s Solid>,
}

/// An edge of a solid, borrowed like a [`FaceRef`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct EdgeRef<'s> {
    ptr: NonNull<ffi::SmEdge>,
    solid: PhantomData<&'s Solid>,
}

fn placement(frame: &ffi::SmAxis2Placement) -> Placement {
    Placement {
        origin: frame.GetOrigin(),
        x: frame.GetXAxis(),
        y: frame.GetYAxis(),
        z: frame.GetZAxis(),
    }
}

impl Solid {
    /// Whether the kernel calls the body one closed manifold solid.
    pub(crate) fn is_manifold(&self) -> Result<bool> {
        let _kernel = held();
        let mut yes = 0;
        // SAFETY: the body is live for as long as `self` is.
        check("manifold", unsafe {
            ffi::SmApiBrepIsManifoldSolid(self.brep.as_ptr(), &mut yes)
        })?;
        Ok(yes != 0)
    }

    /// The enclosed volume in mm3, to a relative accuracy.
    pub(crate) fn volume(&self, accuracy: f64) -> Result<f64> {
        let _kernel = held();
        let mut volume = 0.0;
        // SAFETY: the body is live for as long as `self` is.
        check("volume", unsafe {
            ffi::SmApiBrepComputeVolume(self.brep.as_ptr(), accuracy, &mut volume)
        })?;
        Ok(volume)
    }

    /// The tight box around the body: its lowest and highest corners.
    pub(crate) fn bounds(&self) -> Result<(Vec3, Vec3)> {
        let _kernel = held();
        let zero = Vec3 {
            x: 0.0,
            y: 0.0,
            z: 0.0,
        };
        let (mut min, mut max) = (zero, zero);
        // SAFETY: the body is live for as long as `self` is.
        check("bounds", unsafe {
            ffi::SmApiBrepBoundingBox(self.brep.as_ptr(), 1, &mut min, &mut max)
        })?;
        Ok((min, max))
    }

    pub(crate) fn faces(&self) -> Result<Vec<FaceRef<'_>>> {
        let kernel = held();
        Ok(self
            .face_pointers(&kernel)?
            .into_iter()
            .map(|ptr| FaceRef {
                ptr,
                solid: PhantomData,
            })
            .collect())
    }

    pub(crate) fn edges(&self) -> Result<Vec<EdgeRef<'_>>> {
        let kernel = held();
        Ok(self
            .edge_pointers(&kernel)?
            .into_iter()
            .map(|ptr| EdgeRef {
                ptr,
                solid: PhantomData,
            })
            .collect())
    }

    /// The body in the kernel's own text format. The kernel writes that to a file, so it goes through one in the
    /// temp folder, which is removed again.
    pub(crate) fn text(&self) -> Result<String> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let failed = |what: &str| Error::input("saved body", format!("could not {what} a scratch file"));
        // unique in this process by the counter, and between processes sharing the temp folder by the process id
        let path = std::env::temp_dir().join(format!(
            "sx_brep_save_{}_{}.smb",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let name = path
            .to_str()
            .and_then(|p| CString::new(p).ok())
            .ok_or_else(|| failed("name"))?;
        let status = {
            let _kernel = held();
            // SAFETY: the body is live and the kernel only reads it; `name` is a NUL-terminated string that
            // outlives the call.
            unsafe { ffi::SmApiWriteBrepToFile(self.brep.as_ptr(), name.as_ptr(), 1) }
        };
        let text = std::fs::read_to_string(&path);
        let _ = std::fs::remove_file(&path);
        check("save", status)?;
        text.map_err(|_| failed("read"))
    }

    fn face_pointers(&self, _kernel: &Held) -> Result<Vec<NonNull<ffi::SmFace>>> {
        let mut array = ffi::new_face_array();
        // SAFETY: the body is live; the kernel takes it by plain pointer but only reads it here.
        check("faces", unsafe {
            ffi::SmApiGetFaces(self.brep.as_mut_ptr(), array.pin_mut())
        })?;
        Ok(items(&array))
    }

    fn edge_pointers(&self, _kernel: &Held) -> Result<Vec<NonNull<ffi::SmEdge>>> {
        let mut array = ffi::new_edge_array();
        // SAFETY: the body is live; the kernel takes it by plain pointer but only reads it here.
        check("edges", unsafe {
            ffi::SmApiGetEdges(self.brep.as_mut_ptr(), array.pin_mut())
        })?;
        Ok(items(&array))
    }
}

/// The attributes of `face` that hold a half of its key, each with the id that says which half.
fn key_halves(
    _kernel: &Held,
    face: NonNull<ffi::SmFace>,
) -> Result<Vec<(c_ulong, NonNull<ffi::SmAttribute>)>> {
    let mut all = ffi::new_attribute_array();
    // SAFETY: the face belongs to a solid the caller borrows, so it is live.
    caught("keys", unsafe { face.as_ref() }.GetAttributes(all.pin_mut()))?;
    Ok(items(&all)
        .into_iter()
        .filter_map(|attribute| {
            // SAFETY: the kernel just listed it among the face's attributes, so it is live.
            let id = unsafe { attribute.as_ref() }.GetAttributeID().0;
            (id == KEY_LOW || id == KEY_HIGH).then_some((id, attribute))
        })
        .collect())
}

/// The half of a key an attribute holds: its one long, or 0 for an attribute that holds anything else. Asked of
/// the attribute's own base class, so nothing is assumed about what kind it is.
fn key_half(attribute: NonNull<ffi::SmAttribute>) -> u64 {
    // SAFETY: the attribute is one `key_halves` just listed, so it is live.
    let attribute = unsafe { attribute.as_ref() };
    if attribute.GetNumLongElements().0 != 1 {
        return 0;
    }
    // SAFETY: the attribute says it holds one long, at this address; null is handled.
    let value = unsafe { attribute.GetLongElementsAddress().as_ref() }.map_or(0, |long| long.0);
    u64::try_from(value).unwrap_or(0) & KEY_HALF
}

impl Solid {
    /// The key on each face, in face order; 0 for a face without one.
    pub(crate) fn keys(&self) -> Result<Vec<u64>> {
        let kernel = held();
        self.face_pointers(&kernel)?
            .into_iter()
            .map(|face| {
                let (mut low, mut high) = (0_u64, 0_u64);
                for (id, attribute) in key_halves(&kernel, face)? {
                    if id == KEY_LOW {
                        low = key_half(attribute);
                    } else {
                        high = key_half(attribute);
                    }
                }
                Ok((high << KEY_HALF_BITS) | low)
            })
            .collect()
    }

    /// Writes one key on each face, in face order; 0 leaves the face without one. `body.rs` has checked that there
    /// is a key for each face and that each fits in 52 bits. An error part way leaves the faces before it written.
    pub(crate) fn set_keys(&mut self, keys: &[u64]) -> Result<()> {
        let kernel = held();
        for (face, &key) in self.face_pointers(&kernel)?.into_iter().zip(keys) {
            for (_, attribute) in key_halves(&kernel, face)? {
                // SAFETY: the face is live and, with the solid borrowed for writing, nothing else reads it; the
                // attribute is the face's own, which the kernel takes off and deletes.
                caught("keys", unsafe {
                    Pin::new_unchecked(&mut *face.as_ptr()).RemoveAttribute(attribute.as_ptr(), 0)
                })?;
            }
            if key == 0 {
                continue;
            }
            for (id, half) in [(KEY_LOW, key & KEY_HALF), (KEY_HIGH, key >> KEY_HALF_BITS)] {
                let mut made = ptr::null_mut();
                // a half is 26 bits, which a long holds everywhere
                let value = Long(c_long::try_from(half & KEY_HALF).unwrap_or(0));
                check("keys", ffi::sx_long_attribute(ULong(id), value, &mut made))?;
                if made.is_null() {
                    return Err(Error::NotSolid {
                        op: "keys",
                        why: "the kernel made no attribute",
                    });
                }
                // SAFETY: the face as above; the attribute is the one just made, which the face takes over.
                caught("keys", unsafe {
                    Pin::new_unchecked(&mut *face.as_ptr()).AddAttribute(made)
                })?;
            }
        }
        Ok(())
    }

    /// Puts the body in the older operations' table and gives its number there (`src/handover.rs`). Temporary.
    /// `take_back` with the number must follow before the body is dropped.
    pub(crate) fn lend(&self) -> Result<i64> {
        let _kernel = held();
        // SAFETY: the body is live for as long as `self` is. The table keeps only the pointer, the operations
        // that read it work on copies, and neither its `free` nor `adopt` gives up a lent number.
        let number = status_of("lend", unsafe { ffi::sx_brep_lend(self.brep.as_mut_ptr()) })?;
        Ok(wide(number))
    }
}

/// Takes a lent number out of the older operations' table again. Nothing is deleted. Temporary.
pub(crate) fn take_back(number: i64) {
    let _kernel = held();
    if let Some(number) = narrow(number) {
        ffi::sx_brep_take_back(Long(number));
    }
}

/// The body an older operation made, out of its table and owned here, or none for a number the table does not have
/// and for one that is only lent. Temporary.
pub(crate) fn take_over(number: i64) -> Option<Solid> {
    let _kernel = held();
    let raw = ffi::sx_brep_adopt(Long(narrow(number)?));
    // SAFETY: the table gave the pointer up, so nothing else holds the body; the kernel allocated it with the
    // operator new that its own delete, which UniquePtr calls, matches. Null stays null.
    let brep = unsafe { UniquePtr::from_raw(raw) };
    // a solid is made only around a body: dropping an empty one would ask for the lock held here
    if brep.is_null() {
        None
    } else {
        Some(Solid { brep })
    }
}

impl FaceRef<'_> {
    /// Whether the kernel's own test finds the face's surface within `mm` of one plane.
    pub(crate) fn flat_within(&self, mm: f64) -> bool {
        let _kernel = held();
        // SAFETY: the face belongs to a solid that is borrowed for as long as `self` lives, so it is live.
        let raw = unsafe { self.ptr.as_ref() }.GetSurface().cast_const();
        // SAFETY: a face's surface belongs to the same solid; null (no surface) is handled.
        let Some(surface) = (unsafe { raw.as_ref() }) else {
            return false;
        };
        mm.is_finite() && mm > 0.0 && matches!(ffi::flat(surface, mm), Ok(true))
    }

    pub(crate) fn shape(&self) -> Shape {
        let _kernel = held();
        // SAFETY: the face belongs to a solid that is borrowed for as long as `self` lives, so it is live.
        let raw = unsafe { self.ptr.as_ref() }.GetSurface().cast_const();
        // SAFETY: a face's surface belongs to the same solid; null (no surface) is handled.
        let Some(surface) = (unsafe { raw.as_ref() }) else {
            return Shape::Other(0);
        };
        let kind = surface.GetType().0;
        let other = Shape::Other(wide(kind));
        let mut frame = ffi::new_frame();
        let (mut a, mut b) = (0.0, 0.0);
        let none = ptr::null_mut();
        match kind {
            PLANE => {
                // SAFETY: the surface says it is exactly a plane, so the cast is to its own class.
                let plane = unsafe { &*ffi::as_plane(raw) };
                Shape::Plane(placement(plane.GetPosition()))
            }
            CYLINDER => {
                // SAFETY: the surface says it is exactly a cylinder.
                let cylinder = unsafe { &*ffi::as_cylinder(raw) };
                if cylinder.GetCanonical(frame.pin_mut(), &mut a).0 != SUCCESS {
                    return other;
                }
                Shape::Cylinder {
                    at: placement(&frame),
                    radius: a,
                }
            }
            CONE => {
                // SAFETY: the surface says it is exactly a cone.
                let cone = unsafe { &*ffi::as_cone(raw) };
                // SAFETY: the two optional outputs are not asked for, which null says.
                let status = unsafe { cone.GetCanonical(frame.pin_mut(), &mut a, &mut b, none, none) };
                if status.0 != SUCCESS {
                    return other;
                }
                let (mut no_apex, mut at) = (0, 0.0);
                let mut apex = Vec3 {
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                };
                let found = cone.GetApex(&mut no_apex, &mut apex, &mut at).0 == SUCCESS && no_apex == 0;
                Shape::Cone {
                    at: placement(&frame),
                    radius: a,
                    half_angle_deg: b,
                    apex: found.then_some(apex),
                }
            }
            SPHERE => {
                // SAFETY: the surface says it is exactly a sphere.
                let sphere = unsafe { &*ffi::as_sphere(raw) };
                // SAFETY: the two optional outputs are not asked for.
                let status = unsafe { sphere.GetCanonical(frame.pin_mut(), &mut a, none, none) };
                if status.0 != SUCCESS {
                    return other;
                }
                Shape::Sphere {
                    at: placement(&frame),
                    radius: a,
                }
            }
            TORUS => {
                // SAFETY: the surface says it is exactly a torus.
                let torus = unsafe { &*ffi::as_torus(raw) };
                // SAFETY: the two optional outputs are not asked for.
                let status = unsafe { torus.GetCanonical(frame.pin_mut(), &mut a, &mut b, none, none) };
                if status.0 != SUCCESS {
                    return other;
                }
                Shape::Torus {
                    at: placement(&frame),
                    major: a,
                    minor: b,
                }
            }
            // an arc run along its axis reads as the cylinder it is, as the older `tessellate` reads it
            EXTRUSION if ffi::extruded_cylinder(surface, frame.pin_mut(), &mut a) => Shape::Cylinder {
                at: placement(&frame),
                radius: a,
            },
            _ => other,
        }
    }
}

impl<'s> EdgeRef<'s> {
    fn edge(&self) -> &ffi::SmEdge {
        // SAFETY: the edge belongs to a solid that is borrowed for as long as `self` lives, so it is live.
        unsafe { self.ptr.as_ref() }
    }

    /// The faces the edge lies on, each once: two, or one for a seam where a face meets itself.
    pub(crate) fn faces(&self) -> Vec<FaceRef<'s>> {
        let _kernel = held();
        let mut array = ffi::new_face_array();
        // SAFETY: a null attribute asks for every face.
        unsafe { self.edge().GetFaces(array.pin_mut(), ptr::null_mut()) };
        items(&array)
            .into_iter()
            .map(|ptr| FaceRef {
                ptr,
                solid: PhantomData,
            })
            .collect()
    }

    /// The kernel's type code of the edge's curve, or 0 when it has none.
    pub(crate) fn curve_type(&self) -> i64 {
        let _kernel = held();
        // SAFETY: an edge's curve belongs to the same solid; null (no curve) is handled.
        unsafe { self.edge().GetCurve().as_ref() }.map_or(0, |c| wide(c.GetType().0))
    }

    /// Whether the kernel calls its two faces tangent along it, within the kernel's own angle tolerance.
    pub(crate) fn is_tangent(self) -> bool {
        let _kernel = held();
        self.edge().IsTangentEdge(ANGLE_TOL_DEG, 0) != 0
    }

    /// Whether exactly two face sides meet along it, as on a closed solid.
    pub(crate) fn is_manifold(self) -> bool {
        let _kernel = held();
        self.edge().IsManifold() != 0
    }

    /// Whether it starts and ends at one vertex, as a full circle does.
    pub(crate) fn is_closed(self) -> bool {
        let _kernel = held();
        self.edge().IsClosed() != 0
    }

    /// How far a point is from the edge, in mm.
    pub(crate) fn distance_to(&self, point: Vec3) -> Result<f64> {
        let _kernel = held();
        let mut closest = point;
        let (mut parameter, mut distance) = (0.0, 0.0);
        // SAFETY: the edge is live, as in `edge`; the kernel takes it by plain pointer and changes nothing a
        // borrower of the solid can see.
        check("edge distance", unsafe {
            ffi::SmApiEdgeClosestPoint(
                self.ptr.as_ptr(),
                &point,
                &mut closest,
                &mut parameter,
                &mut distance,
            )
        })?;
        Ok(distance)
    }

    /// Its start and end points, or none when it has no vertex.
    pub(crate) fn ends(&self) -> Option<(Vec3, Vec3)> {
        let _kernel = held();
        // SAFETY: an edge's vertices belong to the same solid; null is handled.
        let (start, end) = unsafe {
            (
                self.edge().GetStartVertex().as_ref()?,
                self.edge().GetEndVertex().as_ref()?,
            )
        };
        Some((start.GetPoint(), end.GetPoint()))
    }
}

fn mesh_error(why: &str) -> Error {
    Error::Mesh { why: why.to_owned() }
}

fn index(n: usize) -> Result<u32> {
    u32::try_from(n).map_err(|_| mesh_error("the mesh has more than 2^32 points"))
}

impl Solid {
    pub(crate) fn tessellate(&self, params: Params) -> Result<Polygons> {
        let kernel = held();
        let face_at: HashMap<*mut ffi::SmFace, usize> = self
            .face_pointers(&kernel)?
            .into_iter()
            .enumerate()
            .map(|(i, f)| (f.as_ptr(), i))
            .collect();
        let failures = ffi::new_failure_array();
        let mut raw = ptr::null_mut();
        // SAFETY: the body is live, and the kernel only reads it; `failures` is a live array the kernel fills;
        // the report is not asked for, which null says.
        let status = unsafe {
            ffi::SmApiTessellate(
                self.brep.as_mut_ptr(),
                &mut raw,
                &params,
                0,
                failures.as_mut_ptr(),
                ptr::null_mut(),
            )
        };
        // an exception: the pointer is left alone, as in `adopt`
        let code = status_of("tessellate", status)?;
        // SAFETY: the kernel's mesh belongs to the caller, and nothing else holds it. Null stays null.
        let owner = unsafe { UniquePtr::from_raw(raw) };
        if code != SUCCESS {
            let faces = failures.as_ref().map_or_else(Vec::new, failed_faces);
            return Err(Error::Faces {
                status: wide(code),
                faces,
            });
        }
        let Some(mesh) = owner.as_ref() else {
            return Err(mesh_error("the kernel made no mesh"));
        };
        let mut poly_faces = ffi::new_poly_face_array();
        // SAFETY: a null face asks for the polygons of every face.
        unsafe { mesh.GetPolyFaces(poly_faces.pin_mut(), ptr::null_mut()) };

        let mut out = Polygons::default();
        let mut vertex_at: HashMap<*mut ffi::SmPolyVertex, u32> = HashMap::new();
        let mut record_at: HashMap<*mut ffi::SmPolyVertAuxData, u32> = HashMap::new();
        // a polygon's corners: its point, the normal stored there, and which of the kernel's records holds it
        let mut corners: Vec<(u32, Option<Vec3>, Option<u32>)> = Vec::new();
        for polygon in items(&poly_faces) {
            // SAFETY: the polygons, and the loops, sides, vertices and normals reached from them below, belong to
            // `owner`, which lives to the end of this function; the kernel is held, so nothing changes them.
            let polygon = unsafe { polygon.as_ref() };
            let mut loops = ffi::new_poly_loop_array();
            polygon.GetPolyLoops(loops.pin_mut());
            let loops = items(&loops);
            let [outer] = loops[..] else {
                if loops.is_empty() {
                    continue;
                }
                return Err(mesh_error("the kernel returned a polygon with a hole in it"));
            };
            let mut sides = ffi::new_poly_edge_array();
            // SAFETY: as for the polygon.
            unsafe { outer.as_ref() }.GetPolyEdges(sides.pin_mut());
            corners.clear();
            for side in items(&sides) {
                // SAFETY: as for the polygon.
                let side = unsafe { side.as_ref() };
                let vertex = side.GetStartPolyVertex();
                // SAFETY: as for the polygon; a side with no start vertex is refused.
                let Some(point) = (unsafe { vertex.as_ref() }).map(ffi::SmPolyVertex::GetPoint) else {
                    return Err(mesh_error(
                        "the kernel returned a polygon side with no start point",
                    ));
                };
                let id = if let Some(&id) = vertex_at.get(&vertex) {
                    id
                } else {
                    let id = index(out.positions.len())?;
                    out.positions.push(point);
                    vertex_at.insert(vertex, id);
                    id
                };
                let stored = side.GetAuxData();
                // SAFETY: as for the polygon; null means the kernel stored no normal here.
                let normal = unsafe { stored.as_ref() }.map(|aux| *ffi::sx_normal(aux));
                let record = if stored.is_null() {
                    None
                } else {
                    let next = index(record_at.len())?;
                    Some(*record_at.entry(stored).or_insert(next))
                };
                corners.push((id, normal, record));
            }
            let Some(&face) = face_at.get(&polygon.GetOriginalFace()) else {
                return Err(mesh_error("the kernel returned a polygon of no face of the body"));
            };
            let face = index(face)?;
            // the kernel's polygons are triangles; one with more corners is fanned from its first
            let last = corners.len().saturating_sub(1);
            for i in 1..last {
                let (a, b, c) = (corners[0], corners[i], corners[i + 1]);
                out.triangles.push([a.0, b.0, c.0]);
                out.faces.push(face);
                out.normals.push([a.1, b.1, c.1]);
                out.records.push([a.2, b.2, c.2]);
            }
        }
        Ok(out)
    }
}

/// The kernel's list of faces it could not tessellate.
fn failed_faces(failures: &ffi::SmFailureArray) -> Vec<FailedFace> {
    let count = failures.GetSize().0;
    (0..count)
        .map(|i| {
            let failure = failures.GetAt(ULong(i));
            FailedFace {
                face: usize::try_from(ffi::sx_failed_face(failure).0).unwrap_or(usize::MAX),
                stage: match ffi::sx_failed_stage(failure) {
                    0 => Stage::Boundary,
                    1 => Stage::Face,
                    2 => Stage::Output,
                    other => Stage::Other(other),
                },
                status: wide(ffi::sx_failed_status(failure).0),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // each field of the two mirrored types, written here and read back by the kernel's own field names
    #[allow(clippy::float_cmp, reason = "the values are copied, never computed")]
    #[test]
    fn the_kernel_reads_each_field_where_rust_wrote_it() {
        let _kernel = held();
        let v = Vec3 {
            x: 1.5,
            y: -2.25,
            z: 3.125,
        };
        assert_eq!(
            [0, 1, 2].map(|axis| ffi::sx_coordinate(&v, axis)),
            [1.5, -2.25, 3.125]
        );
        let p = Params {
            chord: 0.01,
            curve_angle_deg: 15.0,
            surface_angle_deg: 20.0,
            max_edge: 4.0,
            max_aspect: 6.0,
        };
        assert_eq!(
            [0, 1, 2, 3, 4].map(|which| ffi::sx_control(&p, which)),
            [0.01, 15.0, 20.0, 4.0, 6.0]
        );
    }

    // and the other way: values the kernel wrote, read through the Rust fields
    #[test]
    fn rust_reads_each_field_where_the_kernel_wrote_it() {
        let corner = Vec3 {
            x: 1.0,
            y: 2.0,
            z: 3.0,
        };
        let size = Vec3 {
            x: 4.0,
            y: 5.0,
            z: 6.0,
        };
        let solid = cuboid(corner, size).expect("a box");
        let (min, max) = solid.bounds().expect("bounds");
        let near = |a: f64, b: f64| (a - b).abs() < 1e-9;
        assert!(
            near(min.x, 1.0) && near(min.y, 2.0) && near(min.z, 3.0),
            "{min:?}"
        );
        assert!(
            near(max.x, 5.0) && near(max.y, 7.0) && near(max.z, 9.0),
            "{max:?}"
        );
    }
}
