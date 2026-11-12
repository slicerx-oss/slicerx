// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A face's surface where the kernel's own type says less than the face is. cpp/sx_brep.cpp and the bridge in
// src/kernel.rs both read surfaces through this, so a body reads the same however it is held.
#pragma once
#include <SmAxis2Placement.h>
#include <SmBSplineCurve.h>
#include <SmSurfOfExtrusion.h>
#include <SmSurfTypes.h>
#include <SmSurface.h>
#include <SmVector3d.h>

#include <cmath>

// an arc of a sketch run straight along its axis is a piece of a cylinder; the kernel keeps it as an extrusion, as it
// makes cylinders only from whole circles. `frame` gets the arc's placement, its z the axis, and `radius` its radius
inline bool sx_extruded_cylinder(const SmSurface& surface, SmAxis2Placement& frame, double& radius)
{
    auto& s = const_cast<SmSurface&>(surface);
    if (s.GetType() != SmSurfOfExtrusion_TYPE) return false;
    auto& e = static_cast<SmSurfOfExtrusion&>(s);
    SmBSplineCurve* gen = e.GetGenCurve();
    SmVector3d d = e.GetExtrusionVector();
    double a0 = 0, a1 = 0, len = std::sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
    if (!gen || len <= 0 || !gen->IsArc(16, 1e-6, frame, radius, a0, a1)) return false;
    SmVector3d z = frame.GetZAxis();
    double along = (d.x * z.x + d.y * z.y + d.z * z.z) / len;
    return !(std::fabs(std::fabs(along) - 1) > 1e-9);
}
