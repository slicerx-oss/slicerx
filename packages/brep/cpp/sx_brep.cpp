// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// sx-brep: exact solids on the SMLib kernel behind one JSON call, for the native build (src/lib.rs) and the
// WebAssembly module (scripts/build-wasm.sh). Bodies live in a table here and are named by number; every op that
// changes a body makes a new one, so a caller can keep earlier steps.
#include "json.h"

#include <SmApiBrep.h>
#include <SmApiCurves.h>
#include <SmApiGeneral.h>
#include <SmApiPrimitives.h>
#include <SmApiQueries.h>
#include <SmBrep.h>
#include <SmFace.h>
#include <SmLine.h>
#include <SmPoly.h>
#include <SmSurface.h>
#include <SmSurfTypes.h>
#include <SmVector3d.h>

#include <cmath>
#include <cstring>
#include <map>
#include <tuple>

using sxj::Error;
using sxj::Value;

namespace {

std::map<long, SmBrep*> bodies;
long next_id = 1;

const double kPi = 3.14159265358979323846;

// --- reading requests

double num(const Value& r, const char* k)
{
    const Value& v = r[k];
    if (v.kind != Value::Number || !std::isfinite(v.n)) throw Error(k, "must be a number");
    return v.n;
}

double num_or(const Value& r, const char* k, double d) { return r.has(k) ? num(r, k) : d; }

SmVector3d v3(const Value& r, const char* k)
{
    const Value& v = r[k];
    if (v.kind != Value::Array || v.a.size() != 3) throw Error(k, "must be [x, y, z]");
    for (const auto& e : v.a)
        if (e.kind != Value::Number || !std::isfinite(e.n)) throw Error(k, "must be [x, y, z]");
    return SmVector3d(v.a[0].n, v.a[1].n, v.a[2].n);
}

void v2(const Value& v, const char* k, double& x, double& y)
{
    if (v.kind != Value::Array || v.a.size() != 2 || v.a[0].kind != Value::Number || v.a[1].kind != Value::Number)
        throw Error(k, "must be [x, y]");
    x = v.a[0].n;
    y = v.a[1].n;
}

SmVector3d unit(SmVector3d a, const char* k)
{
    double l = std::sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    if (!(l > 1e-12)) throw Error(k, "must be a non-zero vector");
    return SmVector3d(a.x / l, a.y / l, a.z / l);
}

SmVector3d cross(const SmVector3d& a, const SmVector3d& b)
{
    return SmVector3d(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}

double dot(const SmVector3d& a, const SmVector3d& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

SmBrep* body(const Value& r, const char* k)
{
    const Value& v = r[k];
    if (v.kind != Value::Number) throw Error(k, "must be a body number");
    auto it = bodies.find(long(v.n));
    if (it == bodies.end()) throw Error(k, "no such body (freed, or from an earlier session)");
    return it->second;
}

long keep(SmBrep* b)
{
    long id = next_id++;
    bodies[id] = b;
    return id;
}

void check(long st, const char* what)
{
    if (st != SM_SUCCESS) throw Error("kernel", std::string(what) + " failed (SMLib status " + std::to_string(st) + ")");
}

SmBrep* copy_of(SmBrep* b)
{
    SmBrep* c = nullptr;
    check(SmApiBrepCopy(b, c), "copy");
    return c;
}

// --- placing bodies

// a frame: origin and three axes, the third the normal (right-handed)
struct Frame {
    SmVector3d o, u, v, n;
};

Frame frame_of(const Value& f)
{
    Frame fr;
    fr.o = v3(f, "origin");
    fr.n = unit(v3(f, "normal"), "normal");
    fr.u = unit(v3(f, "u"), "u");
    // v from the normal and u, so the frame stays orthonormal and right-handed
    fr.u = unit(SmVector3d(fr.u.x - dot(fr.u, fr.n) * fr.n.x, fr.u.y - dot(fr.u, fr.n) * fr.n.y, fr.u.z - dot(fr.u, fr.n) * fr.n.z), "u");
    fr.v = cross(fr.n, fr.u);
    return fr;
}

// moves an object built in the frame's own coordinates (x along u, y along v, z along the normal) into place
void place(SmObject* obj, const Frame& f)
{
    // rotation with columns u, v, n, as an axis and an angle
    double m[3][3] = {{f.u.x, f.v.x, f.n.x}, {f.u.y, f.v.y, f.n.y}, {f.u.z, f.v.z, f.n.z}};
    double tr = m[0][0] + m[1][1] + m[2][2];
    double c = std::max(-1.0, std::min(1.0, (tr - 1) / 2));
    double ang = std::acos(c);
    if (ang > 1e-12) {
        SmVector3d ax;
        if (kPi - ang > 1e-6) {
            ax = SmVector3d(m[2][1] - m[1][2], m[0][2] - m[2][0], m[1][0] - m[0][1]);
        } else {
            // half turn: the axis from the diagonal
            double xx = std::sqrt(std::max(0.0, (m[0][0] + 1) / 2));
            double yy = std::sqrt(std::max(0.0, (m[1][1] + 1) / 2));
            double zz = std::sqrt(std::max(0.0, (m[2][2] + 1) / 2));
            if (xx >= yy && xx >= zz) ax = SmVector3d(xx, m[0][1] / (2 * xx), m[0][2] / (2 * xx));
            else if (yy >= zz) ax = SmVector3d(m[0][1] / (2 * yy), yy, m[1][2] / (2 * yy));
            else ax = SmVector3d(m[0][2] / (2 * zz), m[1][2] / (2 * zz), zz);
        }
        check(SmApiRotate(obj, SmVector3d(0, 0, 0), unit(ax, "frame"), ang * 180 / kPi), "rotate");
    }
    check(SmApiTranslate(obj, f.o), "move");
}

Frame frame_for(const SmVector3d& origin, const SmVector3d& normal)
{
    Frame f;
    f.o = origin;
    f.n = unit(normal, "normal");
    SmVector3d seed = std::fabs(f.n.z) > 0.9 ? SmVector3d(1, 0, 0) : SmVector3d(0, 0, 1);
    f.u = unit(cross(seed, f.n), "normal");
    f.v = cross(f.n, f.u);
    return f;
}

// --- making solids

SmBrep* make_box(const SmVector3d& lo, const SmVector3d& hi)
{
    double dx = hi.x - lo.x, dy = hi.y - lo.y, dz = hi.z - lo.z;
    if (!(dx > 0 && dy > 0 && dz > 0)) throw Error("max", "must be above min on every axis");
    SmBrep* b = nullptr;
    check(SmApiCreateBox(lo, dx, dy, dz, b), "box");
    return b;
}

SmBrep* make_cylinder(const SmVector3d& origin, const SmVector3d& axis, double d, double h)
{
    if (!(d > 0)) throw Error("diameterMm", "must be more than 0 mm");
    if (!(h > 0)) throw Error("heightMm", "must be more than 0 mm");
    SmBrep* b = nullptr;
    check(SmApiCreateCylinder(SmVector3d(0, 0, 0), d / 2, h, b), "cylinder");
    place(b, frame_for(origin, axis));
    return b;
}

// a closed loop in the frame's plane: a polygon ({"points": [[x, y], ...]}) or a circle ({"center", "diameterMm"})
void loop_curves(const Value& l, double z, SmTArray<SmCurve*>& out)
{
    if (l.has("center")) {
        double cx, cy;
        v2(l["center"], "center", cx, cy);
        double d = num(l, "diameterMm");
        if (!(d > 0)) throw Error("diameterMm", "must be more than 0 mm");
        SmBSplineCurve* c = nullptr;
        check(SmApiCreateCircle(SmPoint3d(cx, cy, z), d / 2, c), "circle");
        out.Add(c);
        return;
    }
    const Value& pts = l["points"];
    if (pts.kind != Value::Array || pts.a.size() < 3) throw Error("points", "a loop needs at least 3 points");
    size_t n = pts.a.size();
    for (size_t i = 0; i < n; ++i) {
        double x0, y0, x1, y1;
        v2(pts.a[i], "points", x0, y0);
        v2(pts.a[(i + 1) % n], "points", x1, y1);
        if (std::hypot(x1 - x0, y1 - y0) < 1e-9) continue;
        SmLine* s = nullptr;
        check(SmApiCreateLineSegment(SmPoint3d(x0, y0, z), SmPoint3d(x1, y1, z), s), "line");
        out.Add(s);
    }
}

void free_curves(SmTArray<SmCurve*>& cs)
{
    for (ULONG i = 0; i < cs.GetSize(); ++i) delete cs[i];
}

// one loop swept from z0 to z1 in frame coordinates, capped
SmBrep* sweep_loop(const Value& l, double z0, double z1)
{
    SmTArray<SmCurve*> cs;
    SmBrep* b = nullptr;
    try {
        loop_curves(l, z0, cs);
        check(SmApiCreateLinearSweep(cs, SmVector3d(0, 0, 1), z1 - z0, TRUE, b), "extrude");
    } catch (...) {
        free_curves(cs);
        throw;
    }
    free_curves(cs);
    if (!b) throw Error("kernel", "extrude made nothing");
    return b;
}

// a op b; a and b are consumed whatever happens
SmBrep* combine(SmBrep* a, SmBrep* b, const std::string& op)
{
    SmBrep* r = nullptr;
    long st;
    if (op == "union") st = SmApiBooleanUnion(a, b, r);
    else if (op == "difference") st = SmApiBooleanDifference(a, b, r);
    else if (op == "intersection") st = SmApiBooleanIntersection(a, b, r);
    else {
        delete a;
        delete b;
        throw Error("op", "must be union, difference or intersection");
    }
    if (st != SM_SUCCESS || !r) {
        delete a;
        delete b;
        check(st == SM_SUCCESS ? SM_ERR : st, ("boolean " + op).c_str());
    }
    // the result is a, and b went into it
    return r;
}

ULONG face_count(SmBrep* b)
{
    SmTArray<SmFace*> fs;
    SmApiGetFaces(b, fs);
    return fs.GetSize();
}

SmBrep* extrude(const Value& r)
{
    Frame f = frame_of(r["frame"]);
    double z0 = num(r, "fromMm"), z1 = num(r, "toMm");
    if (!(z1 - z0 > 1e-6)) throw Error("toMm", "must be above fromMm");
    const Value& polys = r["polygons"];
    if (polys.kind != Value::Array || polys.a.empty()) throw Error("polygons", "needs at least one polygon");
    SmBrep* out = nullptr;
    for (const auto& p : polys.a) {
        SmBrep* s = sweep_loop(p["outer"], z0, z1);
        for (const auto& h : p["holes"].a) s = combine(s, sweep_loop(h, z0, z1), "difference");
        out = out ? combine(out, s, "union") : s;
    }
    place(out, f);
    return out;
}

SmBrep* solid_of(const Value& s)
{
    const std::string& t = s["type"].s;
    if (t == "box") return make_box(v3(s, "min"), v3(s, "max"));
    if (t == "cylinder") return make_cylinder(v3(s, "origin"), v3(s, "axis"), num(s, "diameterMm"), num(s, "heightMm"));
    throw Error("type", "a solid is a box or a cylinder");
}

// the half space on the normal's side of a plane, big enough to hold the body
SmBrep* half_space(SmBrep* b, const SmVector3d& point, const SmVector3d& normal)
{
    SmPoint3d lo, hi;
    check(SmApiBrepBoundingBox(b, FALSE, lo, hi), "bounds");
    double reach = std::sqrt(std::pow(hi.x - lo.x, 2) + std::pow(hi.y - lo.y, 2) + std::pow(hi.z - lo.z, 2));
    SmVector3d mid((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, (lo.z + hi.z) / 2);
    double size = 2 * (reach + std::sqrt(std::pow(mid.x - point.x, 2) + std::pow(mid.y - point.y, 2) + std::pow(mid.z - point.z, 2))) + 10;
    Frame f = frame_for(point, normal);
    // centered under the body's middle, so the square covers it
    SmVector3d off(mid.x - point.x, mid.y - point.y, mid.z - point.z);
    double cu = dot(off, f.u), cv = dot(off, f.v);
    Value loop = Value::object();
    Value pts = Value::array();
    double h = size / 2;
    for (auto c : {std::make_pair(-h, -h), std::make_pair(h, -h), std::make_pair(h, h), std::make_pair(-h, h)}) {
        Value p = Value::array();
        p.push(cu + c.first);
        p.push(cv + c.second);
        pts.push(p);
    }
    loop.set("points", pts);
    SmBrep* s = sweep_loop(loop, 0, size);
    place(s, f);
    return s;
}

// --- reading bodies

const char* surface_name(SmSurface* s)
{
    if (!s) return "other";
    switch (s->GetType()) {
    case SmPlane_TYPE: return "plane";
    case SmCylinder_TYPE: return "cylinder";
    case SmSphere_TYPE: return "sphere";
    case SmTorus_TYPE: return "torus";
    case SmSurfOfRevolution_TYPE: return "revolution";
    case SmSurfOfExtrusion_TYPE: return "extrusion";
    case SmBSplineSurface_TYPE: return "nurbs";
    case SmBlendSurface_TYPE: return "blend";
    case SmOffsetSurface_TYPE: return "offset";
    default: break;
    }
    // the kernel makes cylinders as cones with equal radii
    if (s->IsKindOf(SmCone_TYPE)) return "cone";
    return "other";
}

Value info(SmBrep* b)
{
    Value v = Value::object();
    SmBoolean man = FALSE;
    check(SmApiBrepIsManifoldSolid(b, man), "manifold check");
    v.set("manifold", bool(man));
    double vol = 0;
    if (man && SmApiBrepComputeVolume(b, 1e-6, vol) == SM_SUCCESS) v.set("volumeMm3", vol);
    SmPoint3d lo, hi;
    if (SmApiBrepBoundingBox(b, TRUE, lo, hi) == SM_SUCCESS) {
        Value bb = Value::object(), mn = Value::array(), mx = Value::array();
        for (double d : {lo.x, lo.y, lo.z}) mn.push(d);
        for (double d : {hi.x, hi.y, hi.z}) mx.push(d);
        bb.set("min", mn);
        bb.set("max", mx);
        v.set("bounds", bb);
    }
    SmTArray<SmFace*> fs;
    SmApiGetFaces(b, fs);
    Value types = Value::object();
    for (ULONG i = 0; i < fs.GetSize(); ++i) {
        std::string t = surface_name(fs[i]->GetSurface());
        types.set(t, Value(types[t].n + 1));
    }
    v.set("faces", Value((unsigned long)fs.GetSize()));
    v.set("faceTypes", types);
    return v;
}

// triangles for the slicer, welded, each with the number of the face it came from (its place in the face list)
Value tessellate(SmBrep* b, double chord, double angle)
{
    SmTArray<SmFace*> fs;
    SmApiGetFaces(b, fs);
    std::map<SmFace*, long> face_no;
    Value faces = Value::array();
    for (ULONG i = 0; i < fs.GetSize(); ++i) {
        face_no[fs[i]] = long(i);
        Value f = Value::object();
        f.set("id", Value((unsigned long)i));
        f.set("type", surface_name(fs[i]->GetSurface()));
        faces.push(f);
    }
    SmPolyBrep* pb = nullptr;
    SmTessellationParams p;
    p.dChordHeightTol = chord;
    p.dCurveAngleTolDeg = angle;
    p.dSurfaceAngleTolDeg = angle;
    check(SmApiTessellate(b, pb, p), "tessellate");
    if (!pb) throw Error("kernel", "tessellate made nothing");
    // weld on a 1e-6 mm grid: neighboring faces share their edge points
    std::map<std::tuple<long long, long long, long long>, long> weld;
    Value pos = Value::array(), idx = Value::array(), ids = Value::array();
    pos.a.reserve(3 * 1024);
    auto vid = [&](const SmPoint3d& q) {
        auto k = std::make_tuple(std::llround(q.x * 1e6), std::llround(q.y * 1e6), std::llround(q.z * 1e6));
        auto it = weld.find(k);
        if (it != weld.end()) return it->second;
        long n = long(weld.size());
        weld[k] = n;
        pos.a.emplace_back(q.x);
        pos.a.emplace_back(q.y);
        pos.a.emplace_back(q.z);
        return n;
    };
    SmTArray<SmPolyFace*> pfs;
    pb->GetPolyFaces(pfs);
    for (ULONG i = 0; i < pfs.GetSize(); ++i) {
        SmPolyLoop* l = pfs[i]->GetOuterPolyLoop();
        if (!l) continue;
        SmTArray<SmPolyEdge*> es;
        l->GetPolyEdges(es);
        std::vector<long> v;
        for (ULONG j = 0; j < es.GetSize(); ++j) v.push_back(vid(es[j]->GetStartPolyVertex()->GetPoint()));
        auto fit = face_no.find(pfs[i]->GetOriginalFace());
        long fid = fit == face_no.end() ? -1 : fit->second;
        for (size_t j = 1; j + 1 < v.size(); ++j) {
            if (v[0] == v[j] || v[j] == v[j + 1] || v[0] == v[j + 1]) continue;
            idx.a.emplace_back(v[0]);
            idx.a.emplace_back(v[j]);
            idx.a.emplace_back(v[j + 1]);
            ids.a.emplace_back(fid);
        }
    }
    delete pb;
    pos.kind = idx.kind = ids.kind = Value::Array;
    Value out = Value::object();
    out.set("positions", pos);
    out.set("indices", idx);
    out.set("faceIds", ids);
    out.set("faces", faces);
    return out;
}

// --- the ops

Value run(const std::string& op, const Value& r)
{
    Value out = Value::object();
    if (op == "box") {
        out.set("body", Value(keep(make_box(v3(r, "min"), v3(r, "max")))));
    } else if (op == "cylinder") {
        out.set("body", Value(keep(make_cylinder(v3(r, "origin"), v3(r, "axis"), num(r, "diameterMm"), num(r, "heightMm")))));
    } else if (op == "extrude") {
        out.set("body", Value(keep(extrude(r))));
    } else if (op == "boolean") {
        SmBrep* a = copy_of(body(r, "a"));
        SmBrep* b = nullptr;
        try {
            b = copy_of(body(r, "b"));
        } catch (...) {
            delete a;
            throw;
        }
        out.set("body", Value(keep(combine(a, b, r["op"].s))));
    } else if (op == "subtract") {
        const Value& ss = r["solids"];
        if (ss.kind != Value::Array || ss.a.empty()) throw Error("solids", "needs at least one solid");
        SmBrep* a = copy_of(body(r, "body"));
        for (const auto& s : ss.a) {
            SmBrep* t = nullptr;
            try {
                t = solid_of(s);
            } catch (...) {
                delete a;
                throw;
            }
            a = combine(a, t, "difference");
        }
        out.set("body", Value(keep(a)));
    } else if (op == "cut") {
        SmBrep* b = body(r, "body");
        const Value& pl = r["plane"];
        SmVector3d pt = v3(pl, "point"), n = unit(v3(pl, "normal"), "normal");
        // below keeps what the normal points away from, above the rest
        SmBrep* below = combine(copy_of(b), half_space(b, pt, n), "difference");
        SmBrep* above = nullptr;
        try {
            above = combine(copy_of(b), half_space(b, pt, SmVector3d(-n.x, -n.y, -n.z)), "difference");
        } catch (...) {
            delete below;
            throw;
        }
        // a side the plane misses comes back empty
        for (auto side : {std::make_pair("below", below), std::make_pair("above", above)}) {
            if (face_count(side.second)) {
                out.set(side.first, Value(keep(side.second)));
            } else {
                delete side.second;
                out.set(side.first, Value());
            }
        }
    } else if (op == "info") {
        out = info(body(r, "body"));
    } else if (op == "tessellate") {
        double chord = num_or(r, "chordMm", 0.01), angle = num_or(r, "angleDeg", 15);
        if (!(chord >= 0)) throw Error("chordMm", "must be 0 or more");
        if (!(angle > 0 && angle <= 90)) throw Error("angleDeg", "must be more than 0 and at most 90");
        out = tessellate(body(r, "body"), chord, angle);
    } else if (op == "free") {
        const Value& v = r["body"];
        auto it = v.kind == Value::Number ? bodies.find(long(v.n)) : bodies.end();
        if (it != bodies.end()) {
            delete it->second;
            bodies.erase(it);
        }
        out.set("freed", it != bodies.end());
    } else if (op == "count") {
        out.set("bodies", Value((unsigned long)bodies.size()));
    } else {
        throw Error("op", "unknown operation " + op);
    }
    return out;
}

char* reply(const Value& v)
{
    std::string s = sxj::dump(v);
    char* out = static_cast<char*>(std::malloc(s.size() + 1));
    if (out) std::memcpy(out, s.c_str(), s.size() + 1);
    return out;
}

} // namespace

extern "C" {

// runs one operation; the reply is JSON, {"error", "field"} when it failed, and the caller frees it with
// sx_brep_free. Not thread safe: one caller at a time.
char* sx_brep_call(const char* op, const char* request)
{
    static bool ready = false;
    if (!ready) {
        SmApiGetOrCreateContext();
        ready = true;
    }
    try {
        Value r = sxj::Parser(request ? std::string(request) : std::string("{}")).parse();
        return reply(run(op ? op : "", r));
    } catch (const Error& e) {
        Value v = Value::object();
        v.set("error", std::string(e.field) + ": " + e.what());
        v.set("field", e.field);
        return reply(v);
    } catch (const std::exception& e) {
        Value v = Value::object();
        v.set("error", std::string("kernel: ") + e.what());
        v.set("field", "kernel");
        return reply(v);
    } catch (...) {
        Value v = Value::object();
        v.set("error", "kernel: the operation failed");
        v.set("field", "kernel");
        return reply(v);
    }
}

void sx_brep_free(char* reply_text) { std::free(reply_text); }

}
