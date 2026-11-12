// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the bridge in src/kernel.rs needs beyond the kernel's own headers: plain names for the types it binds, the
// facts about them that Rust relies on, checked when this compiles, and the few things a binding cannot say (a
// constructor call, a cast between kernel classes, a public data member). No modeling code lives here.
#pragma once
#include <SmApiBrep.h>
#include <SmApiCurves.h>
#include <SmApiGeneral.h>
#include <SmApiImportExport.h>
#include <SmApiPrimitives.h>
#include <SmApiQueries.h>
#include <SmApiSurfaces.h>
#include <SmAttribute.h>
#include <SmAxis2Placement.h>
#include <SmBSplineCurve.h>
#include <SmBrep.h>
#include <SmCone.h>
#include <SmCurve.h>
#include <SmCurveTypes.h>
#include <SmCylinder.h>
#include <SmEdge.h>
#include <SmExtent2d.h>
#include <SmFace.h>
#include <SmLine.h>
#include <SmMath.h>
#include <SmPlane.h>
#include <SmPoly.h>
#include <SmSphere.h>
#include <SmSurfTypes.h>
#include <SmSurface.h>
#include <SmTorus.h>
#include <SmVector3d.h>
#include <SmVertex.h>

#include <cstddef>
#include <memory>
#include <type_traits>

#include "rust/cxx.h"
#include "sx_keys.h"
#include "sx_surface.h"

// --- names
// the binding needs one plain identifier per type: the kernel's status and type codes are macros for long, and its
// arrays are instances of a template
using SmLong = long;
using SmFaceArray = SmTArray<SmFace*>;
using SmEdgeArray = SmTArray<SmEdge*>;
using SmPolyFaceArray = SmTArray<SmPolyFace*>;
using SmPolyLoopArray = SmTArray<SmPolyLoop*>;
using SmPolyEdgeArray = SmTArray<SmPolyEdge*>;
using SmFailureArray = SmTArray<SmTessellationFailure>;
using SmPointArray = SmTArray<SmVector3d>;
using SmNumberArray = SmTArray<double>;
using SmCountArray = SmTArray<ULONG>;
using SmSplineArray = SmTArray<SmBSplineCurve*>;
using SmCurveArray = SmTArray<SmCurve*>;
using SmAttributeArray = SmTArray<SmAttribute*>;

// --- facts
// The two kernel types Rust holds by value, field for field (Vec3 and Params in src/kernel.rs, which checks the
// same sizes and offsets on its side). Both are plain doubles and nothing else. SmVector3d has a copy constructor of
// its own, which only copies the three, so moving its bytes is sound all the same.
template <> struct rust::IsRelocatable<SmVector3d> : std::true_type {};
template <> struct rust::IsRelocatable<SmTessellationParams> : std::true_type {};
static_assert(std::is_standard_layout<SmVector3d>::value && std::is_trivially_destructible<SmVector3d>::value, "SmVector3d");
static_assert(sizeof(SmVector3d) == 24 && alignof(SmVector3d) == alignof(double), "SmVector3d");
static_assert(offsetof(SmVector3d, x) == 0 && offsetof(SmVector3d, y) == 8 && offsetof(SmVector3d, z) == 16, "SmVector3d");
static_assert(std::is_standard_layout<SmTessellationParams>::value, "SmTessellationParams");
static_assert(std::is_trivially_copyable<SmTessellationParams>::value, "SmTessellationParams");
static_assert(sizeof(SmTessellationParams) == 40 && alignof(SmTessellationParams) == alignof(double), "SmTessellationParams");
static_assert(offsetof(SmTessellationParams, dChordHeightTol) == 0, "SmTessellationParams");
static_assert(offsetof(SmTessellationParams, dCurveAngleTolDeg) == 8, "SmTessellationParams");
static_assert(offsetof(SmTessellationParams, dSurfaceAngleTolDeg) == 16, "SmTessellationParams");
static_assert(offsetof(SmTessellationParams, dMaxEdgeLength) == 24, "SmTessellationParams");
static_assert(offsetof(SmTessellationParams, dMaxAspectRatio) == 32, "SmTessellationParams");
// a surface's extent is four doubles that Rust hands back as it got them and never reads (Extent in src/kernel.rs).
// Its copy constructor only copies the four and its destructor only overwrites them, so moving its bytes, and never
// running the destructor on Rust's copy, is sound.
template <> struct rust::IsRelocatable<SmExtent2d> : std::true_type {};
static_assert(std::is_standard_layout<SmExtent2d>::value && !std::is_polymorphic<SmExtent2d>::value, "SmExtent2d");
static_assert(sizeof(SmExtent2d) == 32 && alignof(SmExtent2d) == alignof(double), "SmExtent2d");
// the curve classes Rust casts between, each to its own base
static_assert(std::is_base_of<SmBSplineCurve, SmLine>::value && std::is_base_of<SmCurve, SmBSplineCurve>::value, "curve classes");
// integers Rust passes by value
static_assert(std::is_same<ULONG, unsigned long>::value && std::is_same<SmStatus, long>::value, "long sized");
static_assert(std::is_same<SmBoolean, int>::value && sizeof(int) == 4, "SmBoolean");
static_assert(std::is_same<TCHAR, char>::value, "file names are plain char");
static_assert(sizeof(SmBSplineCurveForm) == sizeof(int) && SM_CF_UNSPECIFIED == 6, "curve form");
// codes that are macros here and constants in src/kernel.rs
static_assert(SM_SUCCESS == 1000, "status");
static_assert(SmBSplineSurface_TYPE == 15002 && SmPlane_TYPE == 15011 && SmCone_TYPE == 15012, "surface types");
static_assert(SmCylinder_TYPE == 15013 && SmSphere_TYPE == 15014 && SmTorus_TYPE == 15015, "surface types");
static_assert(SmSurfOfRevolution_TYPE == 15020 && SmSurfOfExtrusion_TYPE == 15030, "surface types");
static_assert(SmBlendSurface_TYPE == 15040 && SmOffsetSurface_TYPE == 15400, "surface types");
static_assert(SmLine_TYPE == 14010 && SmCircle_TYPE == 14021 && SmEllipse_TYPE == 14022, "curve types");
static_assert(SmBSplineCurve_TYPE == 14033, "curve types");
static_assert(SM_TS_BOUNDARY_PREPARATION == 0 && SM_TS_FACE_TESSELLATION == 1 && SM_TS_POLYGON_OUTPUT == 2, "stages");
static_assert(SM_ANG_TOL_DEG == 0.5, "the kernel's angle tolerance");
// where a face's key is kept (cpp/sx_keys.h), constants in src/kernel.rs
static_assert(kSxKeyLow == 20101 && kSxKeyHigh == 20102 && kSxKeyHalfBits == 26, "face keys");
static_assert(std::is_base_of<SmAttribute, SmLongAttribute>::value, "a key half is a long attribute");
// how flat a face sorted with the planes is (cpp/sx_keys.h), constant in src/body.rs
static_assert(kSxFlatKindMm == 1e-4, "flat faces");

// --- what a binding cannot say
// a kernel array, made in the kernel's context (plain new is private to kernel objects)
template <class T> std::unique_ptr<T> sx_new() { return std::unique_ptr<T>(new (*SmApiGetOrCreateContext()) T()); }
// a plain C++ value with a constructor
template <class T> std::unique_ptr<T> sx_make() { return std::make_unique<T>(); }
// a cast between kernel classes; the caller has checked the object's type
template <class To, class From> const To* sx_cast(const From* p) { return static_cast<const To*>(p); }
// public data members
inline const SmVector3d& sx_normal(const SmPolyVertAuxData& a) { return a.m_vNormal; }
inline ULONG sx_failed_face(const SmTessellationFailure& f) { return f.lFaceIndex; }
inline int sx_failed_stage(const SmTessellationFailure& f) { return static_cast<int>(f.eStage); }
inline SmLong sx_failed_status(const SmTessellationFailure& f) { return f.eStatus; }
// a surface's own test for lying within a distance of one plane; it changes nothing
inline bool sx_flat(const SmSurface& s, double within) { return const_cast<SmSurface&>(s).IsPlanar(within) != 0; }
// a long attribute, made in the kernel's context as its objects are; the object it is added to owns it
inline SmLong sx_long_attribute(ULONG id, SmLong value, SmAttribute*& out)
{
    out = new (*SmApiGetOrCreateContext()) SmLongAttribute(id, value, SM_AB_COPY);
    return SM_SUCCESS;
}

// --- the hand-over
// the three exports at the end of cpp/sx_brep.cpp, which that file explains. Temporary, as they are
extern "C" {
long sx_brep_lend(SmBrep* body);
void sx_brep_take_back(long number);
SmBrep* sx_brep_adopt(long number);
}

// --- a surface's curve where one parameter holds a value: its whole knot list, its control points (x, y, z each), and in `about`
// its degree, 1 when it is rational and the gap the kernel says the curve has from the surface. The curve is the
// kernel's; it is freed here.
inline SmLong sx_surface_curve(const SmSurface& surface, int direction, double at, rust::Vec<double>& knots,
                                  rust::Vec<double>& points, rust::Vec<double>& about)
{
    SmBSplineCurve* iso = nullptr;
    double achieved = 0.0;
    SmStatus status = surface.CreateIsoParametricCurve(*SmApiGetOrCreateContext(), direction == 0 ? SM_SP_U : SM_SP_V,
                                                       at, SM_CAST_APPROXTOL3D(0.0), iso, nullptr, &achieved);
    std::unique_ptr<SmBSplineCurve> owned(iso);
    if (status != SM_SUCCESS) return status;
    if (iso == nullptr) return SM_ERR;
    SmTArray<double> all;
    status = iso->GetKnotsAll(all);
    if (status != SM_SUCCESS) return status;
    for (ULONG i = 0; i < all.GetSize(); ++i) knots.push_back(all.GetAt(i));
    for (ULONG i = 0; i < iso->GetNumberControlPoints(); ++i) {
        SmPoint3d point;
        double weight = 1.0;
        status = iso->GetControlPoint(SM_CP_EUCLIDIAN_RATIONAL, i, point, weight);
        if (status != SM_SUCCESS) return status;
        points.push_back(point.x);
        points.push_back(point.y);
        points.push_back(point.z);
    }
    about.push_back(static_cast<double>(iso->GetDegree()));
    about.push_back(iso->IsRational() ? 1.0 : 0.0);
    about.push_back(achieved);
    return SM_SUCCESS;
}

// --- checks
// how the kernel reads a value Rust wrote, by the kernel's own field names (the layout tests in src/kernel.rs)
inline double sx_coordinate(const SmVector3d& v, int axis) { return axis == 0 ? v.x : axis == 1 ? v.y : v.z; }
inline double sx_control(const SmTessellationParams& p, int which)
{
    const double all[5] = {p.dChordHeightTol, p.dCurveAngleTolDeg, p.dSurfaceAngleTolDeg, p.dMaxEdgeLength, p.dMaxAspectRatio};
    return which >= 0 && which < 5 ? all[which] : 0;
}
