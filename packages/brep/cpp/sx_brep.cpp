// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// sx-brep: exact solids on the SMLib kernel behind one JSON call, for the native build (src/lib.rs) and the
// WebAssembly module (scripts/build-wasm.sh). Bodies live in a table here and are named by number; every op that
// changes a body makes a new one, so a caller can keep earlier steps.
#include "json.h"

#include <SmApiBrep.h>
#include <SmApiCurves.h>
#include <SmApiGeneral.h>
#include <SmApiImportExport.h>
#include <SmApiPrimitives.h>
#include <SmApiQueries.h>
#include <SmEdge.h>
#include <SmVertex.h>
#include <SmAttribute.h>
#include <SmAxis2Placement.h>
#include <SmBSplineCurve.h>
#include <SmBrep.h>
#include <SmCone.h>
#include <SmCylinder.h>
#include <SmFace.h>
#include <SmLine.h>
#include <SmLoop.h>
#include <SmPlane.h>
#include <SmPointClass.h>
#include <SmPoly.h>
#include <SmRegion.h>
#include <SmSphere.h>
#include <SmSurfOfExtrusion.h>
#include <SmSurface.h>
#include <SmSurfTypes.h>
#include <SmVector3d.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <map>
#include <random>
#include <sstream>
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

void check(long st, const char* what);

// --- face keys

// a face's key says which step made it, the same in every replay (sx-geom's faces.rs makes mesh keys the same
// way). Keys are 52 bits, kept in two attributes since long is 32 bits on the web; booleans carry them to the
// faces that come from a face
const ULONG kKeyLow = 20101, kKeyHigh = 20102;
const unsigned long long kKeyHalf = (1ULL << 26) - 1;

unsigned long long face_key(SmFace* f)
{
    SmTArray<SmAttribute*> as;
    f->GetAttributes(as);
    unsigned long long lo = 0, hi = 0;
    for (ULONG i = 0; i < as.GetSize(); ++i) {
        ULONG id = as[i]->GetAttributeID();
        if (id == kKeyLow) lo = (unsigned long long)static_cast<SmLongAttribute*>(as[i])->GetValue() & kKeyHalf;
        if (id == kKeyHigh) hi = (unsigned long long)static_cast<SmLongAttribute*>(as[i])->GetValue() & kKeyHalf;
    }
    return (hi << 26) | lo;
}

void set_key(SmFace* f, unsigned long long key)
{
    SmTArray<SmAttribute*> as;
    f->GetAttributes(as);
    for (ULONG i = 0; i < as.GetSize(); ++i)
        if (as[i]->GetAttributeID() == kKeyLow || as[i]->GetAttributeID() == kKeyHigh) f->RemoveAttribute(as[i]);
    if (!key) return;
    SmContext& cx = *SmApiGetOrCreateContext();
    f->AddAttribute(new (cx) SmLongAttribute(kKeyLow, long(key & kKeyHalf), SM_AB_COPY));
    f->AddAttribute(new (cx) SmLongAttribute(kKeyHigh, long((key >> 26) & kKeyHalf), SM_AB_COPY));
}

// the request's keySalt; each body a call makes gets the next number, as each mesh a step makes does in sx-geom
struct {
    bool on = false;
    unsigned long long salt = 0, next = 0;
} keys;

unsigned long long key_of(unsigned long long salt, unsigned long long ordinal, unsigned long long face)
{
    // splitmix64 of the three, cut to 52 bits and never 0
    unsigned long long z = salt ^ (ordinal * 0x9e3779b97f4a7c15ULL) ^ (face * 0xbf58476d1ce4e5b9ULL);
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
    z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
    z ^= z >> 31;
    z &= (1ULL << 52) - 1;
    return z ? z : 1;
}

// keys for the faces of a body the call made, in face order; none without a keySalt
SmBrep* fresh_keys(SmBrep* b)
{
    if (!keys.on) return b;
    ++keys.next;
    SmTArray<SmFace*> fs;
    SmApiGetFaces(b, fs);
    for (ULONG i = 0; i < fs.GetSize(); ++i) set_key(fs[i], key_of(keys.salt, keys.next, i));
    return b;
}

// bodies read from a request's {"smb"} for one call, freed when it ends
std::vector<SmBrep*> loaded;

// SMLib's text format goes through a file; its binary one depends on the build's integer sizes, so the web and
// native builds would not read each other's
std::filesystem::path scratch_file()
{
    // unique between processes sharing the temp folder, too
    static const unsigned long long tag = std::random_device{}() * 4294967296ULL + std::random_device{}();
    static long n = 0;
    return std::filesystem::temp_directory_path() / ("sx_brep_" + std::to_string(tag) + "_" + std::to_string(++n) + ".smb");
}

// the kernel's reader trusts its input, so saved text carries a hash of itself and nothing else gets read
const char* kSeal = "//sx-brep fnv1a64 ";

std::string seal_of(const std::string& text)
{
    unsigned long long h = 1469598103934665603ULL;
    for (unsigned char c : text) h = (h ^ c) * 1099511628211ULL;
    char hex[17];
    std::snprintf(hex, sizeof hex, "%016llx", h);
    return std::string(kSeal) + hex + "\n";
}

// the kernel's text drops attributes, so the face keys follow it on a line of their own, in face order
const char* kKeys = "//sx-brep keys";

SmBrep* read_smb(const std::string& sealed, const char* k)
{
    size_t at = sealed.rfind(kSeal);
    std::string text = at == std::string::npos ? std::string() : sealed.substr(0, at);
    if (at == std::string::npos || sealed.compare(at, std::string::npos, seal_of(text)) != 0)
        throw Error(k, "not a body sx-brep saved, or changed since");
    std::vector<unsigned long long> face_keys;
    size_t kat = text.rfind(kKeys);
    if (kat != std::string::npos && (kat == 0 || text[kat - 1] == '\n')) {
        std::istringstream line(text.substr(kat + std::strlen(kKeys)));
        unsigned long long key;
        while (line >> key) face_keys.push_back(key);
        text.erase(kat);
    }
    std::filesystem::path p = scratch_file();
    {
        std::ofstream f(p, std::ios::binary);
        f << text;
        if (!f) throw Error(k, "could not write a scratch file");
    }
    SmBrep* b = nullptr;
    long st = SmApiReadBrepFromFile(p.string().c_str(), TRUE, TRUE, b);
    std::error_code ignored;
    std::filesystem::remove(p, ignored);
    if (st != SM_SUCCESS || !b) throw Error(k, "not a body SMLib can read (status " + std::to_string(st) + ")");
    if (!face_keys.empty()) {
        SmTArray<SmFace*> fs;
        SmApiGetFaces(b, fs);
        if (fs.GetSize() != face_keys.size()) {
            delete b;
            throw Error(k, "its face keys do not match its faces");
        }
        for (ULONG i = 0; i < fs.GetSize(); ++i) set_key(fs[i], face_keys[i]);
    }
    return b;
}

std::string write_smb(SmBrep* b)
{
    std::filesystem::path p = scratch_file();
    check(SmApiWriteBrepToFile(b, p.string().c_str(), TRUE), "save");
    std::ifstream f(p, std::ios::binary);
    std::stringstream ss;
    ss << f.rdbuf();
    f.close();
    std::error_code ignored;
    std::filesystem::remove(p, ignored);
    std::string text = ss.str();
    SmTArray<SmFace*> fs;
    SmApiGetFaces(b, fs);
    std::string line = kKeys;
    bool any = false;
    for (ULONG i = 0; i < fs.GetSize(); ++i) {
        unsigned long long key = face_key(fs[i]);
        any = any || key;
        line += " " + std::to_string(key);
    }
    if (any) text += (text.empty() || text.back() == '\n' ? "" : "\n") + line + "\n";
    return text + seal_of(text);
}

// a body by its number, or one carried in the request as {"smb": text} from an earlier save
SmBrep* body(const Value& r, const char* k)
{
    const Value& v = r[k];
    if (v.kind == Value::Object && v["smb"].kind == Value::String) {
        loaded.push_back(read_smb(v["smb"].s, k));
        return loaded.back();
    }
    if (v.kind != Value::Number) throw Error(k, "must be a body number or {\"smb\"}");
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

// a shape as Add shape makes it, standing on the frame's origin and centered on its normal: a box of sizeMm (along
// u, v, normal), a cylinder, a cone (topDiameterMm below diameterMm, 0 for a point) or a sphere
SmBrep* make_primitive(const Value& r)
{
    const std::string& t = r["type"].s;
    SmBrep* b = nullptr;
    if (t == "box") {
        SmVector3d s = v3(r, "sizeMm");
        b = make_box(SmVector3d(-s.x / 2, -s.y / 2, 0), SmVector3d(s.x / 2, s.y / 2, s.z));
    } else if (t == "cylinder" || t == "cone") {
        double d = num(r, "diameterMm"), h = num(r, "heightMm"), top = t == "cone" ? num(r, "topDiameterMm") : d;
        if (!(d > 0)) throw Error("diameterMm", "must be more than 0 mm");
        if (!(h > 0)) throw Error("heightMm", "must be more than 0 mm");
        if (!(top >= 0 && top <= d)) throw Error("topDiameterMm", "must be 0 to diameterMm");
        if (t == "cylinder") check(SmApiCreateCylinder(SmVector3d(0, 0, 0), d / 2, h, b), "cylinder");
        else check(SmApiCreateCone(SmVector3d(0, 0, 0), d / 2, top / 2, h, b), "cone");
    } else if (t == "sphere") {
        double d = num(r, "diameterMm");
        if (!(d > 0)) throw Error("diameterMm", "must be more than 0 mm");
        check(SmApiCreateSphere(SmVector3d(0, 0, d / 2), d / 2, b), "sphere");
    } else {
        throw Error("type", "must be box, cylinder, cone or sphere");
    }
    if (!b) throw Error("kernel", "the shape made nothing");
    if (r.has("frame")) place(b, frame_of(r["frame"]));
    return b;
}

// a closed loop in the frame's plane: a polygon ({"points": [[x, y], ...]}), a circle ({"center", "diameterMm"}),
// or lines and arcs from a start ({"start", "segments": [{"to"}, or {"to", "center", "sweepDeg"} for an arc]})
void loop_curves(const Value& l, double z, SmTArray<SmCurve*>& out)
{
    if (l.has("start")) {
        double x, y;
        v2(l["start"], "start", x, y);
        const Value& ss = l["segments"];
        if (ss.kind != Value::Array || ss.a.empty()) throw Error("segments", "a loop needs at least one segment");
        for (const auto& sg : ss.a) {
            double tx, ty;
            v2(sg["to"], "to", tx, ty);
            if (sg.has("center")) {
                double cx, cy;
                v2(sg["center"], "center", cx, cy);
                double sw = num(sg, "sweepDeg"), r = std::hypot(x - cx, y - cy);
                if (!(r > 1e-9) || !(std::fabs(sw) > 1e-9 && std::fabs(sw) <= 360))
                    throw Error("segments", "an arc needs a center away from its start and a sweep up to 360 degrees");
                // the kernel's arcs run counterclockwise between angles in -360..360; a clockwise one is turned round
                double a0 = std::atan2(y - cy, x - cx) * 180 / kPi;
                double lo = sw > 0 ? a0 : a0 + sw, hi = sw > 0 ? a0 + sw : a0;
                if (hi > 360) lo -= 360, hi -= 360;
                if (lo < -360) lo += 360, hi += 360;
                SmBSplineCurve* c = nullptr;
                check(SmApiCreateArc(SmPoint3d(cx, cy, z), r, lo, hi, c), "arc");
                out.Add(c);
                if (sw < 0) {
                    SmExtent1d back;
                    check(c->ReverseParameterization(c->GetNaturalInterval(), back), "arc direction");
                }
            } else if (std::hypot(tx - x, ty - y) >= 1e-9) {
                SmLine* s = nullptr;
                check(SmApiCreateLineSegment(SmPoint3d(x, y, z), SmPoint3d(tx, ty, z), s), "line");
                out.Add(s);
            }
            x = tx;
            y = ty;
        }
        return;
    }
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

// the flat ruled faces of a taper (its sides, and the pieces an outward one fills each corner's gap with) on exact
// planes, shared with any face on the same plane, so the edges between faces on one plane can go
void join_flat_faces(SmBrep* b, const char* what = "taperDeg")
{
    SmTArray<SmFace*> fs;
    SmApiGetFaces(b, fs);
    SmContext& cx = *SmApiGetOrCreateContext();
    std::vector<std::pair<SmVector3d, double>> planes;
    for (int pass = 0; pass < 2; ++pass) {
        for (ULONG i = 0; i < fs.GetSize(); ++i) {
            SmSurface* s = fs[i]->GetSurface();
            bool flat = s && s->GetType() == SmPlane_TYPE;
            if (!s || flat != (pass == 0)) continue;
            SmPoint3d o;
            SmVector3d n;
            if (!s->IsPlanar(1e-4, &o, &n)) continue;
            double d = dot(n, SmVector3d(o.x, o.y, o.z));
            auto same = std::find_if(planes.begin(), planes.end(), [&](const auto& q) {
                double c = dot(n, q.first);
                return std::fabs(std::fabs(c) - 1) < 1e-6 && std::fabs((c > 0 ? 1 : -1) * q.second - d) < 1e-4;
            });
            if (same == planes.end()) {
                planes.emplace_back(n, d);
                same = planes.end() - 1;
            }
            if (flat) continue;
            // the new plane faces the way the old surface did
            double c = dot(n, same->first) > 0 ? 1 : -1;
            SmVector3d m(c * same->first.x, c * same->first.y, c * same->first.z);
            SmPlane* pl = nullptr;
            check(SmPlane::CreateCanonical(cx, SmAxis2Placement(m, -c * same->second), pl), what);
            check(b->ReplaceSurface(fs[i], pl, FALSE), what);
        }
    }
    check(b->RemoveTopologicalEdgesAndVertices(), what);
}

// one loop from z = 0 to h (below for a negative h), capped, its sides leaning in by deg as they leave z = 0 (out for
// a negative deg)
SmBrep* taper_half(const Value& l, double h, double deg)
{
    SmTArray<SmCurve*> cs;
    SmBrep* b = nullptr;
    try {
        loop_curves(l, 0, cs);
        check(SmApiCreateTaperExtrude(cs, h, deg, 3, FALSE, b), "taperDeg");
    } catch (...) {
        free_curves(cs);
        throw;
    }
    free_curves(cs);
    // a taper that closes the shape early comes back as a point or a ridge short of h
    SmPoint3d lo, hi;
    if (b && SmApiBrepBoundingBox(b, FALSE, lo, hi) == SM_SUCCESS && hi.z - lo.z > std::fabs(h) - 1e-6) {
        try {
            join_flat_faces(b);
        } catch (...) {
            delete b;
            throw;
        }
        return b;
    }
    delete b;
    throw Error("taperDeg", "the taper closes the shape before the full distance; use a smaller angle or distance");
}

// a union can merge coplanar faces without preserving all of their keys
void clear_merge_keys(SmBrep* a, SmBrep* b)
{
    SmTArray<SmFace*> af, bf;
    SmApiGetFaces(a, af);
    SmApiGetFaces(b, bf);
    for (ULONG i = 0; i < af.GetSize(); ++i) {
        SmPoint3d ao;
        SmVector3d an;
        if (!af[i]->GetSurface() || !af[i]->GetSurface()->IsPlanar(1e-6, &ao, &an)) continue;
        for (ULONG j = 0; j < bf.GetSize(); ++j) {
            SmPoint3d bo;
            SmVector3d bn;
            if (!bf[j]->GetSurface() || !bf[j]->GetSurface()->IsPlanar(1e-6, &bo, &bn)) continue;
            if (std::fabs(std::fabs(dot(an, bn)) - 1) < 1e-6 && std::fabs(dot(an, SmVector3d(bo.x - ao.x, bo.y - ao.y, bo.z - ao.z))) < 1e-6) {
                set_key(af[i], 0);
                set_key(bf[j], 0);
            }
        }
    }
}

// a op b; a and b are consumed whatever happens
SmBrep* combine(SmBrep* a, SmBrep* b, const std::string& op)
{
    SmBrep* r = nullptr;
    long st;
    if (op == "union") {
        clear_merge_keys(a, b);
        st = SmApiBooleanUnion(a, b, r);
    }
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

// solid pieces: regions that are neither the outside nor a void
ULONG lumps(SmBrep* b)
{
    SmTArray<SmRegion*> rs;
    b->GetRegions(rs);
    ULONG n = 0;
    for (ULONG i = 0; i < rs.GetSize(); ++i)
        if (!rs[i]->IsInfiniteRegion() && !rs[i]->IsVoid()) ++n;
    return n;
}

// marks every face of a body, so a boolean's result tells which of its faces came only from the other one
const ULONG kOwnMark = 20103;

SmBrep* mark_faces(SmBrep* b)
{
    SmTArray<SmFace*> fs;
    SmApiGetFaces(b, fs);
    SmContext& cx = *SmApiGetOrCreateContext();
    for (ULONG i = 0; i < fs.GetSize(); ++i) fs[i]->AddAttribute(new (cx) SmLongAttribute(kOwnMark, 1, SM_AB_COPY));
    return b;
}

// whether some face has no mark: a face on a marked one counts as marked, so a tool that only meets the body flush
// leaves none. The marks come off.
bool unmark_faces(SmBrep* b)
{
    bool fresh = false;
    SmTArray<SmFace*> fs;
    SmApiGetFaces(b, fs);
    for (ULONG i = 0; i < fs.GetSize(); ++i) {
        SmTArray<SmAttribute*> as;
        fs[i]->GetAttributes(as);
        bool marked = false;
        for (ULONG k = 0; k < as.GetSize(); ++k)
            if (as[k]->GetAttributeID() == kOwnMark) {
                fs[i]->RemoveAttribute(as[k]);
                marked = true;
            }
        fresh = fresh || !marked;
    }
    return fresh;
}

SmBrep* extrude(const Value& r)
{
    Frame f = frame_of(r["frame"]);
    double z0 = num(r, "fromMm"), z1 = num(r, "toMm");
    if (!(z1 - z0 > 1e-6)) throw Error("toMm", "must be above fromMm");
    const Value& polys = r["polygons"];
    if (polys.kind != Value::Array || polys.a.empty()) throw Error("polygons", "needs at least one polygon");
    double taper = r.has("taperDeg") ? num(r, "taperDeg") : 0;
    if (!(std::fabs(taper) <= 45)) throw Error("taperDeg", "between -45 and 45");
    if (taper != 0 && (z0 > 0 || z1 < 0)) throw Error("fromMm", "a tapered extrude starts or ends at the face");
    // tapered, each side of the face narrows away from it, as on the mesh path; a hole widens
    auto piece = [&](const Value& l, double deg) {
        if (taper == 0) return sweep_loop(l, z0, z1);
        if (z0 == 0) return taper_half(l, z1, deg);
        if (z1 == 0) return taper_half(l, z0, deg);
        return combine(taper_half(l, z0, deg), taper_half(l, z1, deg), "union");
    };
    SmBrep* out = nullptr;
    for (const auto& p : polys.a) {
        SmBrep* s = piece(p["outer"], taper);
        for (const auto& h : p["holes"].a) s = combine(s, piece(h, -taper), "difference");
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
    // a tapered extrude makes its flat sides as ruled surfaces, flat to 1e-5 mm
    case SmBSplineSurface_TYPE: return s->IsPlanar(1e-4) ? "plane" : "nurbs";
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

Value xyz(const SmVector3d& p)
{
    Value v = Value::array();
    for (double d : {p.x, p.y, p.z}) v.push(d);
    return v;
}

// a face's surface as sx-geom's faces.rs has it (a plane's comes from the triangles, so it faces out); null when it
// has none of those kinds
Value surface_of(SmSurface* s)
{
    Value v = Value::object();
    if (!s) return Value();
    SmAxis2Placement ax;
    double rad = 0, semi = 0;
    if (s->GetType() == SmSphere_TYPE) {
        if (static_cast<SmSphere*>(s)->GetCanonical(ax, rad) != SM_SUCCESS) return Value();
        v.set("kind", "sphere");
        v.set("center", xyz(ax.GetOrigin()));
        v.set("radius", rad);
        return v;
    }
    if (s->GetType() == SmSurfOfExtrusion_TYPE) {
        // an arc of a sketch run straight along its axis is a piece of a cylinder; the kernel keeps it as an
        // extrusion, as it makes cylinders only from whole circles
        auto* e = static_cast<SmSurfOfExtrusion*>(s);
        SmBSplineCurve* gen = e->GetGenCurve();
        SmVector3d d = e->GetExtrusionVector();
        double a0 = 0, a1 = 0, len = std::sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
        if (!gen || len <= 0 || !gen->IsArc(16, 1e-6, ax, rad, a0, a1)) return Value();
        SmVector3d z = ax.GetZAxis();
        double along = (d.x * z.x + d.y * z.y + d.z * z.z) / len;
        if (std::fabs(std::fabs(along) - 1) > 1e-9) return Value();
        v.set("kind", "cylinder");
        v.set("origin", xyz(ax.GetOrigin()));
        v.set("axis", xyz(z));
        v.set("radius", rad);
        return v;
    }
    if (s->GetType() == SmCylinder_TYPE) {
        if (static_cast<SmCylinder*>(s)->GetCanonical(ax, rad) != SM_SUCCESS) return Value();
    } else if (s->IsKindOf(SmCone_TYPE)) {
        if (static_cast<SmCone*>(s)->GetCanonical(ax, rad, semi) != SM_SUCCESS) return Value();
    } else {
        return Value();
    }
    if (std::fabs(semi) < 1e-9) {
        v.set("kind", "cylinder");
        v.set("origin", xyz(ax.GetOrigin()));
        v.set("axis", xyz(ax.GetZAxis()));
        v.set("radius", rad);
        return v;
    }
    SmBoolean flat = FALSE;
    SmPoint3d apex;
    double at = 0;
    if (static_cast<SmCone*>(s)->GetApex(flat, apex, at) != SM_SUCCESS || flat) return Value();
    // a positive angle widens along the axis
    SmVector3d z = ax.GetZAxis();
    double sign = semi > 0 ? 1 : -1;
    v.set("kind", "cone");
    v.set("apex", xyz(apex));
    v.set("axis", xyz(SmVector3d(sign * z.x, sign * z.y, sign * z.z)));
    v.set("halfAngle", std::fabs(semi) * kPi / 180);
    return v;
}

// triangles for the slicer, welded, each with the number of the face it came from (its place in the face list);
// each face has its type, its surface ({"kind": "other"} when none fits) and its key (0 for none)
Value tessellate(SmBrep* b, double chord, double angle)
{
    SmTArray<SmFace*> fs;
    SmApiGetFaces(b, fs);
    std::map<SmFace*, long> face_no;
    for (ULONG i = 0; i < fs.GetSize(); ++i) face_no[fs[i]] = long(i);
    // per face: the sum of its triangles' area vectors, and of their centers by area
    std::vector<SmVector3d> normal(fs.GetSize(), SmVector3d(0, 0, 0)), middle(fs.GetSize(), SmVector3d(0, 0, 0));
    std::vector<double> area(fs.GetSize(), 0);
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
        std::vector<SmPoint3d> q;
        for (ULONG j = 0; j < es.GetSize(); ++j) {
            q.push_back(es[j]->GetStartPolyVertex()->GetPoint());
            v.push_back(vid(q.back()));
        }
        auto fit = face_no.find(pfs[i]->GetOriginalFace());
        long fid = fit == face_no.end() ? -1 : fit->second;
        for (size_t j = 1; j + 1 < v.size(); ++j) {
            if (v[0] == v[j] || v[j] == v[j + 1] || v[0] == v[j + 1]) continue;
            idx.a.emplace_back(v[0]);
            idx.a.emplace_back(v[j]);
            idx.a.emplace_back(v[j + 1]);
            ids.a.emplace_back(fid);
            if (fid < 0) continue;
            const SmPoint3d &a = q[0], &c = q[j], &d = q[j + 1];
            SmVector3d n = cross(SmVector3d(c.x - a.x, c.y - a.y, c.z - a.z), SmVector3d(d.x - a.x, d.y - a.y, d.z - a.z));
            double w = std::sqrt(dot(n, n));
            normal[fid] = SmVector3d(normal[fid].x + n.x, normal[fid].y + n.y, normal[fid].z + n.z);
            middle[fid] = SmVector3d(middle[fid].x + w * (a.x + c.x + d.x) / 3, middle[fid].y + w * (a.y + c.y + d.y) / 3,
                                     middle[fid].z + w * (a.z + c.z + d.z) / 3);
            area[fid] += w;
        }
    }
    delete pb;
    Value faces = Value::array();
    for (ULONG i = 0; i < fs.GetSize(); ++i) {
        Value f = Value::object();
        f.set("id", Value((unsigned long)i));
        std::string type = surface_name(fs[i]->GetSurface());
        f.set("type", type);
        Value sf = Value::object();
        double l = std::sqrt(dot(normal[i], normal[i]));
        if (type == "plane" && area[i] > 0 && l > 0) {
            SmVector3d n(normal[i].x / l, normal[i].y / l, normal[i].z / l);
            SmVector3d m(middle[i].x / area[i], middle[i].y / area[i], middle[i].z / area[i]);
            sf.set("kind", "plane");
            sf.set("normal", xyz(n));
            sf.set("offset", dot(n, m));
        } else if (type != "plane") {
            sf = surface_of(fs[i]->GetSurface());
        }
        if (sf.kind != Value::Object) {
            sf = Value::object();
            sf.set("kind", "other");
        }
        f.set("surface", sf);
        f.set("key", Value(face_key(fs[i])));
        faces.push(f);
    }
    pos.kind = idx.kind = ids.kind = Value::Array;
    Value out = Value::object();
    out.set("positions", pos);
    out.set("indices", idx);
    out.set("faceIds", ids);
    out.set("faces", faces);
    return out;
}

// --- picking edges

double dist(const SmVector3d& a, const SmVector3d& b)
{
    SmVector3d d(a.x - b.x, a.y - b.y, a.z - b.z);
    return std::sqrt(dot(d, d));
}

SmVector3d at(SmVertex* v)
{
    SmPoint3d p = v->GetPoint();
    return SmVector3d(p.x, p.y, p.z);
}

double off_edge(SmEdge* e, const SmVector3d& q)
{
    SmPoint3d c;
    double t = 0, d = 0;
    if (SmApiEdgeClosestPoint(e, SmPoint3d(q.x, q.y, q.z), c, t, d) != SM_SUCCESS) return 1e30;
    return d;
}

// how far edge e is from a reference: its ends against a and b, or for a closed one (a round rim) a and the
// point across the circle from it
double miss(SmEdge* e, const Value& ref)
{
    SmVector3d a = v3(ref, "a"), b = v3(ref, "b");
    if (e->IsClosed()) {
        if (!ref.has("center")) return off_edge(e, a) + off_edge(e, b);
        SmVector3d c = v3(ref, "center");
        return off_edge(e, a) + off_edge(e, SmVector3d(2 * c.x - a.x, 2 * c.y - a.y, 2 * c.z - a.z));
    }
    SmVector3d s = at(e->GetStartVertex()), t = at(e->GetEndVertex());
    return std::min(dist(s, a) + dist(t, b), dist(s, b) + dist(t, a));
}

bool between(SmEdge* e, unsigned long long k0, unsigned long long k1)
{
    SmTArray<SmFace*> fs;
    e->GetFaces(fs);
    if (fs.GetSize() != 2) return false;
    unsigned long long f0 = face_key(fs[0]), f1 = face_key(fs[1]);
    return (f0 == k0 && f1 == k1) || (f0 == k1 && f1 == k0);
}

// the body's edge each reference names: by its two faces' keys when it has them, then by place. A reference that
// matches nothing, or two edges equally, is an error, so the step runs on the mesh instead
SmTArray<SmEdge*> edges_of(SmBrep* b, const Value& refs)
{
    if (refs.kind != Value::Array || refs.a.empty()) throw Error("edges", "needs at least one edge");
    SmTArray<SmEdge*> all, out;
    check(SmApiGetEdges(b, all), "edges");
    const double tol = 0.01;
    for (size_t i = 0; i < refs.a.size(); ++i) {
        const Value& ref = refs.a[i];
        const Value& ks = ref["keys"];
        bool keyed = ks.kind == Value::Array && ks.a.size() == 2 && ks.a[0].kind == Value::Number && ks.a[1].kind == Value::Number;
        SmEdge* best = nullptr;
        double first = 1e30, second = 1e30;
        for (ULONG j = 0; j < all.GetSize(); ++j) {
            if (keyed && !between(all[j], (unsigned long long)ks.a[0].n, (unsigned long long)ks.a[1].n)) continue;
            double m = miss(all[j], ref);
            if (m < first) {
                second = first;
                first = m;
                best = all[j];
            } else if (m < second) {
                second = m;
            }
        }
        // a keyed edge may have moved along its faces (a push since), so only a near tie counts against it
        if (!best || (!keyed && first > tol) || second < first + tol)
            throw Error("edges", "edge " + std::to_string(i) + " is not on the body");
        for (ULONG j = 0; j < out.GetSize(); ++j)
            if (out[j] == best) throw Error("edges", "edge " + std::to_string(i) + " is named twice");
        out.Add(best);
    }
    return out;
}

// whether an edge runs between two flat faces square to each other
bool square(SmEdge* e)
{
    SmTArray<SmFace*> fs;
    e->GetFaces(fs);
    if (fs.GetSize() != 2) return false;
    SmVector3d n[2];
    for (int k = 0; k < 2; ++k) {
        SmSurface* s = fs[k]->GetSurface();
        if (!s || s->GetType() != SmPlane_TYPE) return false;
        n[k] = static_cast<SmPlane*>(s)->GetPosition().GetZAxis();
    }
    return std::fabs(dot(n[0], n[1])) < 1e-6;
}

// whether a point is inside the solid
bool inside(SmEdge* e, const SmVector3d& p)
{
    SmBrep* b = e->GetBrep();
    SmPointClassification pc(SmTol::GetZoneTol3d(e), SmApiGetOrCreateContext());
    if (!b || b->Point3DClassify(SmPoint3d(p.x, p.y, p.z), SM_EFF_ZERO, FALSE, pc) != SM_SUCCESS) return false;
    SmRegion* r = SM_CAST_PTR(SmRegion, pc.GetObject());
    return r && !r->IsInfiniteRegion() && !r->IsVoid();
}

double off_face(SmFace* f, const SmVector3d& q)
{
    SmPoint3d c;
    double d = 0;
    if (SmApiFaceClosestPoint(f, SmPoint3d(q.x, q.y, q.z), c, d) != SM_SUCCESS) return 1e30;
    return d;
}

// a chamfer of a straight edge between flat faces square to each other, where the solid is the corner between
// them: the triangle the distance cuts off, run along the edge. Null when the edge is not like that
SmBrep* wedge(SmEdge* e, double dist)
{
    if (e->IsClosed() || !square(e)) return nullptr;
    SmTArray<SmFace*> fs;
    e->GetFaces(fs);
    SmVector3d s = at(e->GetStartVertex()), t = at(e->GetEndVertex());
    SmVector3d along(t.x - s.x, t.y - s.y, t.z - s.z);
    double len = std::sqrt(dot(along, along));
    if (!(len > 1e-6)) return nullptr;
    SmVector3d u(along.x / len, along.y / len, along.z / len);
    // straight: the edge's middle is on the line between its ends
    SmVector3d mid((s.x + t.x) / 2, (s.y + t.y) / 2, (s.z + t.z) / 2);
    if (off_edge(e, mid) > 1e-6 * std::max(1.0, len)) return nullptr;
    SmVector3d z[2];
    for (int k = 0; k < 2; ++k) z[k] = static_cast<SmPlane*>(fs[k]->GetSurface())->GetPosition().GetZAxis();
    // the way each face runs from the edge: across its plane, the other face's normal one way or the other,
    // and it has to reach the distance along the whole edge
    SmVector3d side[2];
    const double tol = 1e-6 * std::max(1.0, dist);
    for (int k = 0; k < 2; ++k) {
        SmVector3d n = z[1 - k];
        bool found = false;
        for (double sign : {1.0, -1.0}) {
            SmVector3d dir(sign * n.x, sign * n.y, sign * n.z);
            bool on = true;
            for (double f : {0.02, 0.5, 0.98}) {
                SmVector3d q(s.x + f * along.x + dist * dir.x, s.y + f * along.y + dist * dir.y, s.z + f * along.z + dist * dir.z);
                if (off_face(fs[k], q) > tol) {
                    on = false;
                    break;
                }
            }
            if (on) {
                side[k] = dir;
                found = true;
                break;
            }
        }
        if (!found) return nullptr;
    }
    SmVector3d a = side[0], c = side[1];
    // the solid fills the corner between the faces (an outside edge), not the rest
    double q = std::min(dist, len) * 0.25;
    if (!inside(e, SmVector3d(mid.x + q * (a.x + c.x), mid.y + q * (a.y + c.y), mid.z + q * (a.z + c.z)))) return nullptr;
    // the triangle in the frame at the edge's start (x along a, y along normal x a), its long side on the
    // chamfer's line and its corner pushed out past the faces
    SmVector3d v = cross(u, a);
    double cy = dot(c, v), m = dist * 0.25;
    auto pt = [&](double alpha, double beta) {
        Value p = Value::array();
        p.push(Value(alpha));
        p.push(Value(beta * cy));
        return p;
    };
    Value pts = Value::array();
    pts.push(pt(-m, -m));
    pts.push(pt(dist + m, -m));
    pts.push(pt(-m, dist + m));
    // counterclockwise in the frame
    if (cy < 0) std::swap(pts.a[1], pts.a[2]);
    Value outer = Value::object();
    outer.set("points", pts);
    Value poly = Value::object();
    poly.set("outer", outer);
    poly.set("holes", Value::array());
    Value polys = Value::array();
    polys.push(poly);
    Value frame = Value::object();
    frame.set("origin", xyz(s));
    frame.set("u", xyz(a));
    frame.set("normal", xyz(u));
    Value r = Value::object();
    r.set("frame", frame);
    r.set("polygons", polys);
    r.set("fromMm", Value(0.0));
    r.set("toMm", Value(len));
    return extrude(r);
}

// keys for the faces an op made (a fillet's rounds), leaving the ones carried over
SmBrep* key_new_faces(SmBrep* b)
{
    if (!keys.on) return b;
    ++keys.next;
    SmTArray<SmFace*> fs;
    SmApiGetFaces(b, fs);
    for (ULONG i = 0; i < fs.GetSize(); ++i)
        if (!face_key(fs[i])) set_key(fs[i], key_of(keys.salt, keys.next, i));
    return b;
}

// joins t to a copy of a or cuts it out (t is consumed). touches says the result has a face that came only from the
// tool (else it missed, sat inside a join, or met the body flush) and a join left no piece standing apart
SmBrep* join_or_cut(SmBrep* a, SmBrep* t, bool join, bool& touches, const char* what)
{
    ULONG l0 = lumps(a);
    SmBrep* c = nullptr;
    try {
        c = mark_faces(copy_of(a));
    } catch (...) {
        delete t;
        throw;
    }
    SmBrep* m = combine(c, t, join ? "union" : "difference");
    if (!face_count(m)) {
        delete m;
        throw Error(what, "the cut removes the whole body");
    }
    touches = unmark_faces(m) && (!join || lumps(m) <= l0);
    return m;
}

// --- pushing a flat face

Value xy(double x, double y)
{
    Value v = Value::array();
    v.push(x);
    v.push(y);
    return v;
}

// a flat face's plane, its normal pointing out of the solid; false for a face that is not flat
bool outward_plane(SmFace* f, SmVector3d& n, double& offset)
{
    SmSurface* s = f->GetSurface();
    SmPoint3d o;
    if (!s || !s->IsPlanar(1e-6, &o, &n)) return false;
    n = unit(n, "face");
    SmTArray<SmEdge*> es;
    f->GetEdges(es);
    SmPoint3d p;
    if (!es.GetSize() || SmApiFaceInternalPoint(f, p) != SM_SUCCESS) return false;
    const double eps = 1e-3;
    if (inside(es[0], SmVector3d(p.x + eps * n.x, p.y + eps * n.y, p.z + eps * n.z))) n = SmVector3d(-n.x, -n.y, -n.z);
    offset = dot(n, SmVector3d(o.x, o.y, o.z));
    return true;
}

// a key must name exactly one face; geometry is only for a new, unkeyed pick
SmFace* pushed_face(SmBrep* b, const Value& r, SmVector3d& n)
{
    SmVector3d want = unit(v3(r, "normal"), "normal"), where = v3(r, "at");
    const Value& k = r["faceKey"];
    if (r.has("faceKey") && (k.kind != Value::Number || !std::isfinite(k.n) || k.n <= 0 || k.n >= 4503599627370496.0 || k.n != std::floor(k.n)))
        throw Error("faceReference", "invalid face key; pick the face again to repair this step");
    unsigned long long key = r.has("faceKey") ? (unsigned long long)k.n : 0;
    SmTArray<SmFace*> fs;
    SmApiGetFaces(b, fs);
    std::vector<SmFace*> candidates;
    for (ULONG i = 0; i < fs.GetSize(); ++i) {
        if (key) {
            if (face_key(fs[i]) == key) candidates.push_back(fs[i]);
        } else {
            SmVector3d m;
            double d = 0;
            if (off_face(fs[i], where) <= 1e-3 && outward_plane(fs[i], m, d) && dot(m, want) >= 1 - 1e-6)
                candidates.push_back(fs[i]);
        }
    }
    if (candidates.empty()) throw Error("faceReference", key ? "missing face; pick the face again to repair this step" : "no flat face there; pick the face again to repair this step");
    if (candidates.size() != 1) throw Error("faceReference", "ambiguous face; pick the face again to repair this step");
    double offset = 0;
    if (!outward_plane(candidates[0], n, offset) || dot(n, want) < 1 - 1e-6)
        throw Error("faceReference", "changed face; pick the face again to repair this step");
    return candidates[0];
}

// a loop of a flat face as lines and arcs in the frame, counterclockwise ({"start", "segments"}, or a circle)
Value face_loop(SmLoop* l, const Frame& f)
{
    auto in2 = [&](const SmVector3d& p) {
        SmVector3d d(p.x - f.o.x, p.y - f.o.y, p.z - f.o.z);
        return std::make_pair(dot(d, f.u), dot(d, f.v));
    };
    auto mid_of = [](SmEdge* e) {
        double t0 = 0, t1 = 0;
        SmPoint3d q;
        check(SmApiEdgeParameterRange(e, t0, t1), "edge");
        check(e->GetCurve()->EvaluatePoint((t0 + t1) / 2, q), "edge");
        return SmVector3d(q.x, q.y, q.z);
    };
    SmTArray<SmEdge*> es;
    l->GetEdges(es);
    if (!es.GetSize()) throw Error("face", "a loop of the face has no edges");
    SmAxis2Placement ax;
    double rad = 0, a0 = 0, a1 = 0;
    if (es.GetSize() == 1 && es[0]->IsClosed()) {
        if (!es[0]->GetCurve() || !es[0]->GetCurve()->IsArc(16, 1e-6, ax, rad, a0, a1)) throw Error("face", "a loop of the face is not a circle");
        SmPoint3d c = ax.GetOrigin();
        auto cc = in2(SmVector3d(c.x, c.y, c.z));
        Value v = Value::object();
        v.set("center", xy(cc.first, cc.second));
        v.set("diameterMm", 2 * rad);
        return v;
    }
    // the edges chained end to end, whatever order and direction they come in
    std::vector<SmEdge*> left;
    for (ULONG i = 0; i < es.GetSize(); ++i) left.push_back(es[i]);
    SmVector3d start = at(left[0]->GetStartVertex()), cur = start;
    double scale = 0;
    for (SmEdge* e : left) scale = std::max(scale, dist(at(e->GetStartVertex()), at(e->GetEndVertex())));
    const double tol = 1e-6 * std::max(1.0, scale);
    struct Seg {
        std::pair<double, double> to;
        bool arc;
        std::pair<double, double> c;
        double sweep;
    };
    std::vector<Seg> segs;
    std::vector<std::pair<double, double>> ring;
    while (!left.empty()) {
        auto it = std::find_if(left.begin(), left.end(), [&](SmEdge* e) { return dist(at(e->GetStartVertex()), cur) < tol || dist(at(e->GetEndVertex()), cur) < tol; });
        if (it == left.end()) throw Error("face", "the face's edges do not close up");
        SmEdge* e = *it;
        left.erase(it);
        SmVector3d to = dist(at(e->GetStartVertex()), cur) < tol ? at(e->GetEndVertex()) : at(e->GetStartVertex());
        SmVector3d m = mid_of(e);
        auto p0 = in2(cur), p1 = in2(to), pm = in2(m);
        ring.push_back(p0);
        // straight: the middle is on the line between the ends
        double lx = p1.first - p0.first, ly = p1.second - p0.second, len = std::hypot(lx, ly);
        double off = len > 0 ? std::fabs((pm.first - p0.first) * ly - (pm.second - p0.second) * lx) / len : 1e30;
        if (off < tol) {
            segs.push_back({p1, false, {0, 0}, 0});
        } else {
            SmCurve* c = e->GetCurve();
            if (!c || !c->IsArc(16, 1e-6, ax, rad, a0, a1) || std::fabs(std::fabs(dot(ax.GetZAxis(), f.n)) - 1) > 1e-9)
                throw Error("face", "an edge of the face is not a line or an arc");
            SmPoint3d o = ax.GetOrigin();
            auto cc = in2(SmVector3d(o.x, o.y, o.z));
            auto ang = [&](const std::pair<double, double>& p) { return std::atan2(p.second - cc.second, p.first - cc.first); };
            auto ccw = [](double a) { return std::fmod(std::fmod(a, 2 * kPi) + 2 * kPi, 2 * kPi); };
            double full = ccw(ang(p1) - ang(p0)), part = ccw(ang(pm) - ang(p0));
            if (full < 1e-12) full = 2 * kPi;
            // counterclockwise when the middle comes first that way round
            double sweep = part < full ? full : full - 2 * kPi;
            segs.push_back({p1, true, cc, sweep * 180 / kPi});
            ring.push_back(pm);
        }
        cur = to;
    }
    if (dist(cur, start) > tol) throw Error("face", "the face's edges do not close up");
    double area = 0;
    for (size_t i = 0; i < ring.size(); ++i) {
        const auto &a = ring[i], &b = ring[(i + 1) % ring.size()];
        area += a.first * b.second - b.first * a.second;
    }
    auto s0 = in2(start);
    std::vector<std::pair<double, double>> ends{s0};
    for (const auto& g : segs) ends.push_back(g.to);
    Value v = Value::object(), out = Value::array();
    v.set("start", xy(s0.first, s0.second));
    for (size_t k = 0; k < segs.size(); ++k) {
        // a clockwise loop runs the other way round, each arc swept back
        size_t i = area < 0 ? segs.size() - 1 - k : k;
        const Seg& g = segs[i];
        auto to = area < 0 ? ends[i] : g.to;
        Value sg = Value::object();
        sg.set("to", xy(to.first, to.second));
        if (g.arc) {
            sg.set("center", xy(g.c.first, g.c.second));
            sg.set("sweepDeg", area < 0 ? -g.sweep : g.sweep);
        }
        out.push(sg);
    }
    v.set("segments", out);
    return v;
}

// a flat face as an extrude takes it: its frame (at its area's center, u as sx-geom's FaceFrame::for_normal picks
// it) and one polygon of its loops
void face_profile(SmFace* fc, const SmVector3d& n, Value& frame, Value& polygons)
{
    double area = 0;
    SmPoint3d c;
    check(SmApiFaceComputeCentroid(fc, 1e-4, area, c), "face");
    Frame f;
    f.o = SmVector3d(c.x, c.y, c.z);
    f.n = n;
    f.u = std::fabs(n.z) > 0.9 ? unit(SmVector3d(1 - n.x * n.x, -n.x * n.y, -n.x * n.z), "face") : unit(cross(SmVector3d(0, 0, 1), n), "face");
    f.v = cross(f.n, f.u);
    frame = Value::object();
    frame.set("origin", xyz(f.o));
    frame.set("normal", xyz(f.n));
    frame.set("u", xyz(f.u));
    frame.set("v", xyz(f.v));
    SmTArray<SmLoop*> all, outer;
    fc->GetLoops(all);
    fc->GetOuterLoops(outer);
    if (outer.GetSize() != 1) throw Error("face", "the face has no single outer loop");
    Value poly = Value::object(), holes = Value::array();
    poly.set("outer", face_loop(outer[0], f));
    for (ULONG i = 0; i < all.GetSize(); ++i)
        if (all[i] != outer[0]) holes.push(face_loop(all[i], f));
    poly.set("holes", holes);
    polygons = Value::array();
    polygons.push(poly);
}

// whether some flat face of b faces n with its plane through p, within 0.01 mm and 0.01 degrees, as the mesh
// path's hasFaceOn reads a push's moved face
bool face_on(SmBrep* b, const SmVector3d& p, const SmVector3d& n)
{
    SmTArray<SmFace*> fs;
    SmApiGetFaces(b, fs);
    for (ULONG i = 0; i < fs.GetSize(); ++i) {
        SmVector3d m;
        double d = 0;
        if (outward_plane(fs[i], m, d) && dot(m, n) >= std::cos(0.01 * kPi / 180) && std::fabs(dot(m, p) - d) <= 0.01) return true;
    }
    return false;
}

// --- the hole tool

// past the faces a new hole opens through, so the cut never meets them flush, mm (as the mesh path's)
const double kHoleOverlap = 0.01;

// a round hole on the body: entry is its center on the entry face, axis the way out through it
struct Bore {
    SmVector3d entry, axis;
    double radius = 0, depth = 0;
    bool through = false;
};

SmVector3d along(const SmVector3d& p, const SmVector3d& d, double t) { return SmVector3d(p.x + t * d.x, p.y + t * d.y, p.z + t * d.z); }

double positive(const Value& r, const char* k)
{
    double v = num(r, k);
    if (!(std::isfinite(v) && v > 0 && v <= 10000)) throw Error(k, "must be above 0 (at most 10000 mm)");
    return v;
}

// the hole a step names, found again as it is now: a cylinder wall with the material outside it, on the line
// through entry along axis and of its diameter, opening at a flat face square to it at the entry, and at another
// (through) or at a flat floor. Anything else is an error, so the mesh path runs the step
Bore bore_of(SmBrep* b, const Value& h)
{
    const char* plain = "the hole does not end at a flat face or a flat floor; pick a plain round hole";
    const char* gone = "the hole is not there any more; pick it again";
    SmVector3d entry = v3(h, "entry"), axis = unit(v3(h, "axis"), "hole.axis");
    double d = num(h, "diameterMm");
    SmPoint3d lo, hi;
    check(SmApiBrepBoundingBox(b, FALSE, lo, hi), "bounds");
    double tol = std::max(1e-5 * dist(SmVector3d(lo.x, lo.y, lo.z), SmVector3d(hi.x, hi.y, hi.z)), 1e-3);
    auto height = [&](const SmVector3d& p) { return dot(SmVector3d(p.x - entry.x, p.y - entry.y, p.z - entry.z), axis); };
    SmTArray<SmFace*> fs;
    SmApiGetFaces(b, fs);
    std::vector<SmFace*> walls;
    double radius = 0;
    for (ULONG i = 0; i < fs.GetSize(); ++i) {
        Value s = surface_of(fs[i]->GetSurface());
        if (s["kind"].kind != Value::String || s["kind"].s != "cylinder") continue;
        SmVector3d o = v3(s, "origin"), a = unit(v3(s, "axis"), "axis");
        SmVector3d q(entry.x - o.x, entry.y - o.y, entry.z - o.z);
        double t = dot(q, a);
        if (std::fabs(dot(a, axis)) > 0.9999 && dist(q, SmVector3d(t * a.x, t * a.y, t * a.z)) < tol && std::fabs(2 * num(s, "radius") - d) < tol) {
            walls.push_back(fs[i]);
            radius = num(s, "radius");
        }
    }
    if (walls.empty()) throw Error("hole", gone);
    // the wall's ends along the axis, from its corners. A wall in pieces (stacked, as after a push, or side by side)
    // has rims between them only where it meets itself, so a rim anywhere else is not at an end
    double t0 = 1e30, t1 = -1e30;
    for (SmFace* f : walls) {
        SmTArray<SmEdge*> es;
        f->GetEdges(es);
        for (ULONG k = 0; k < es.GetSize(); ++k)
            for (SmVertex* v : {es[k]->GetStartVertex(), es[k]->GetEndVertex()}) {
                t0 = std::min(t0, height(at(v)));
                t1 = std::max(t1, height(at(v)));
            }
    }
    if (!(t1 - t0 > 1e-6)) throw Error("hole", plain);
    // the material is outside the wall
    SmPoint3d p;
    SmTArray<SmEdge*> es;
    walls[0]->GetEdges(es);
    if (!es.GetSize() || SmApiFaceInternalPoint(walls[0], p) != SM_SUCCESS) throw Error("hole", plain);
    SmVector3d q(p.x - entry.x, p.y - entry.y, p.z - entry.z);
    double t = dot(q, axis);
    SmVector3d out = unit(SmVector3d(q.x - t * axis.x, q.y - t * axis.y, q.z - t * axis.z), "hole");
    if (!inside(es[0], along(SmVector3d(p.x, p.y, p.z), out, 1e-3))) throw Error("hole", "pick the wall of a round hole that starts at a flat face");
    // each end: the faces across the wall's rims, flat and square to the axis. Facing out along the axis at the top
    // is an opening; at the bottom, facing against it is one (through) and along it a floor
    int ends[2] = {0, 0};
    for (SmFace* f : walls) {
        SmTArray<SmEdge*> rims;
        f->GetEdges(rims);
        for (ULONG k = 0; k < rims.GetSize(); ++k) {
            SmTArray<SmFace*> across;
            rims[k]->GetFaces(across);
            for (ULONG j = 0; j < across.GetSize(); ++j) {
                SmFace* g = across[j];
                if (std::find(walls.begin(), walls.end(), g) != walls.end()) continue;
                SmVector3d m;
                double off = 0;
                double ts = height(at(rims[k]->GetStartVertex())), te = height(at(rims[k]->GetEndVertex()));
                if (!outward_plane(g, m, off) || std::fabs(std::fabs(dot(m, axis)) - 1) > 1e-6 || std::fabs(ts - te) > tol) throw Error("hole", plain);
                int top = std::fabs(ts - t1) <= tol ? 1 : std::fabs(ts - t0) <= tol ? 0 : -1;
                if (top < 0) throw Error("hole", plain);
                int kind = (top ? dot(m, axis) > 0 : dot(m, axis) < 0) ? 1 : 2;
                if (ends[top] && ends[top] != kind) throw Error("hole", plain);
                ends[top] = kind;
            }
        }
    }
    // entered from the opening nearest the old entry, which must face the same way, else it is another hole
    bool through = ends[0] == 1 && ends[1] == 1;
    if (ends[1] != 1 || !ends[0] || (through && std::fabs(t0) < std::fabs(t1))) throw Error("hole", gone);
    Bore r;
    r.entry = along(entry, axis, t1);
    r.axis = axis;
    r.radius = radius;
    r.depth = t1 - t0;
    r.through = through;
    return r;
}

// a cylinder standing on base along axis, its faces keyed
SmBrep* rod(const SmVector3d& base, const SmVector3d& axis, double r, double h)
{
    SmBrep* b = nullptr;
    check(SmApiCreateCylinder(SmVector3d(0, 0, 0), r, h, b), "hole");
    try {
        place(b, frame_for(base, axis));
    } catch (...) {
        delete b;
        throw;
    }
    return fresh_keys(b);
}

// the hole made to spec in place, as the mesh path's hole tool does: a smaller or shallower one (or one the same
// size, so the new wall never lies on the old one) fills the old hole first, flush with its ends; then the shaft and
// the head at the entry, a counterbore or a countersink, are cut in one
SmBrep* rebore(SmBrep* a, const Bore& h, const Value& spec)
{
    double r = positive(spec, "diameterMm") / 2;
    double depth = spec.has("depthMm") && !h.through ? positive(spec, "depthMm") : h.depth;
    double top = h.depth, up = top + kHoleOverlap, bottom = h.through ? -kHoleOverlap : h.depth - depth;
    SmVector3d far = along(h.entry, h.axis, -h.depth), down(-h.axis.x, -h.axis.y, -h.axis.z);
    bool bore = spec.has("counterbore"), sink = spec.has("countersink");
    if (bore && sink) throw Error("hole", "a hole takes a counterbore or a countersink, not both");
    // the head along the axis above far, from h0 up: a counterbore of radius hr, or a cone from hr0 to hr
    double hr = 0, hr0 = 0, h0 = 0;
    if (bore) {
        const Value& c = spec["counterbore"];
        hr = positive(c, "diameterMm") / 2;
        double cd = positive(c, "depthMm");
        if (hr <= r) throw Error("counterbore.diameterMm", "must be above the hole's diameter");
        if (top - cd <= bottom) throw Error("counterbore.depthMm", "must be less than the hole's depth");
        h0 = top - cd;
    } else if (sink) {
        const Value& c = spec["countersink"];
        double rh = positive(c, "diameterMm") / 2, deg = num_or(c, "angleDeg", 90);
        if (rh <= r) throw Error("countersink.diameterMm", "must be above the hole's diameter");
        if (!(deg >= 30 && deg <= 150)) throw Error("countersink.angleDeg", "must be between 30 and 150");
        double tan = std::tan(deg * kPi / 360), cone = (rh - r) / tan;
        if (top - cone <= bottom) throw Error("countersink.diameterMm", "the countersink is deeper than the hole");
        // the cone goes on into the shaft, so it crosses the shaft's wall instead of meeting it on a circle
        double e = std::min(r / 2 / tan, (top - cone - bottom) / 2);
        hr = rh + kHoleOverlap * tan;
        hr0 = r - e * tan;
        h0 = top - cone - e;
    }
    SmBrep* m = copy_of(a);
    SmBrep* tool = nullptr;
    // combine takes both bodies, so each is let go of before it runs
    auto take = [](SmBrep*& b) {
        SmBrep* x = b;
        b = nullptr;
        return x;
    };
    try {
        if (r < h.radius + 2 * kHoleOverlap || depth < h.depth) {
            SmBrep* fill = rod(far, h.axis, h.radius + kHoleOverlap, h.depth);
            m = combine(take(m), fill, "union");
            join_flat_faces(m, "hole");
        }
        tool = rod(along(far, h.axis, bottom), h.axis, r, up - bottom);
        SmBrep* head = nullptr;
        if (bore) head = rod(along(far, h.axis, h0), h.axis, hr, up - h0);
        if (sink) {
            // standing on its wide end, at the top
            check(SmApiCreateCone(SmVector3d(0, 0, 0), hr, hr0, up - h0, head), "hole");
            try {
                place(head, frame_for(along(far, h.axis, up), down));
            } catch (...) {
                delete head;
                throw;
            }
            fresh_keys(head);
        }
        if (head) tool = combine(take(tool), head, "union");
        m = combine(take(m), take(tool), "difference");
    } catch (...) {
        delete m;
        delete tool;
        throw;
    }
    if (!face_count(m)) {
        delete m;
        throw Error("hole", "the change removes the whole body");
    }
    return m;
}

// --- the ops

Value run(const std::string& op, const Value& r)
{
    Value out = Value::object();
    if (op == "box") {
        out.set("body", Value(keep(fresh_keys(make_box(v3(r, "min"), v3(r, "max"))))));
    } else if (op == "primitive") {
        out.set("body", Value(keep(fresh_keys(make_primitive(r)))));
    } else if (op == "cylinder") {
        out.set("body", Value(keep(fresh_keys(make_cylinder(v3(r, "origin"), v3(r, "axis"), num(r, "diameterMm"), num(r, "heightMm"))))));
    } else if (op == "extrude") {
        if (!r.has("target")) {
            out.set("body", Value(keep(fresh_keys(extrude(r)))));
        } else {
            // join or cut into the target; a step that misses changes nothing, so it gets no body
            const std::string& o = r["operation"].s;
            if (o != "join" && o != "cut") throw Error("operation", "must be join or cut with a target");
            SmBrep* a = body(r, "target");
            bool touches = false;
            SmBrep* m = join_or_cut(a, fresh_keys(extrude(r)), o == "join", touches, "extrude");
            out.set("touches", Value(touches));
            if (touches) out.set("body", Value(keep(m)));
            else {
                delete m;
                out.set("body", Value());
            }
        }
    } else if (op == "push") {
        // a flat face moved along its normal, out (a join) or in (a cut): its outline swept from it and joined or cut,
        // as the mesh path's face.push does. Faces left on one plane become one
        double d = num(r, "distanceMm");
        if (!(std::fabs(d) > 1e-6 && std::fabs(d) <= 10000)) throw Error("distanceMm", "must not be zero (at most 10000 mm)");
        SmBrep* a = body(r, "body");
        SmVector3d n;
        SmFace* f = pushed_face(a, r, n);
        Value frame, polygons;
        face_profile(f, n, frame, polygons);
        out.set("faceKey", Value(face_key(f)));
        out.set("frame", frame);
        out.set("polygons", polygons);
        Value e = Value::object();
        e.set("frame", frame);
        e.set("polygons", polygons);
        e.set("fromMm", Value(d > 0 ? 0.0 : d));
        e.set("toMm", Value(d > 0 ? d : 0.0));
        // the tool always meets the body on the face; a floor pushed through leaves no face of its own, so touches
        // says nothing here
        bool touches = false;
        SmBrep* m = join_or_cut(a, fresh_keys(extrude(e)), d > 0, touches, "distanceMm");
        try {
            join_flat_faces(m, "face");
        } catch (...) {
            delete m;
            throw;
        }
        // no face left where it moved to: it went through the part
        SmVector3d from = v3(r, "at"), cap(from.x + d * n.x, from.y + d * n.y, from.z + d * n.z);
        out.set("reached", Value(face_on(m, cap, n)));
        out.set("body", Value(keep(m)));
    } else if (op == "hole") {
        // a round hole made another size in place, found again on the body as it is now (an earlier step may have
        // made the part thicker), as the mesh path's hole.apply does
        SmBrep* a = body(r, "body");
        Bore h = bore_of(a, r["hole"]);
        Value found = Value::object();
        found.set("entry", xyz(h.entry));
        found.set("axis", xyz(h.axis));
        found.set("diameterMm", Value(2 * h.radius));
        found.set("depthMm", Value(h.depth));
        found.set("through", Value(h.through));
        out.set("hole", found);
        out.set("body", Value(keep(rebore(a, h, r["spec"]))));
    } else if (op == "boolean") {
        SmBrep* a = copy_of(body(r, "a"));
        SmBrep* b = nullptr;
        try {
            b = copy_of(body(r, "b"));
        } catch (...) {
            delete a;
            throw;
        }
        SmBrep* m = combine(a, b, r["op"].s);
        // nothing left (an intersection of parts apart, or a difference that takes it all) is no body
        if (face_count(m)) out.set("body", Value(keep(m)));
        else {
            delete m;
            out.set("body", Value());
        }
    } else if (op == "subtract") {
        const Value& ss = r["solids"];
        if (ss.kind != Value::Array || ss.a.empty()) throw Error("solids", "needs at least one solid");
        // with a frame the body is in that frame's coordinates and the solids in world, so each solid moves into it
        bool framed = r.has("frame");
        Frame back;
        if (framed) {
            Frame f = frame_of(r["frame"]);
            back.u = SmVector3d(f.u.x, f.v.x, f.n.x);
            back.v = SmVector3d(f.u.y, f.v.y, f.n.y);
            back.n = SmVector3d(f.u.z, f.v.z, f.n.z);
            back.o = SmVector3d(-dot(f.u, f.o), -dot(f.v, f.o), -dot(f.n, f.o));
        }
        SmBrep* a = copy_of(body(r, "body"));
        for (const auto& s : ss.a) {
            SmBrep* t = nullptr;
            try {
                t = solid_of(s);
                if (framed) place(t, back);
            } catch (...) {
                delete t;
                delete a;
                throw;
            }
            a = combine(a, fresh_keys(t), "difference");
        }
        out.set("body", Value(keep(a)));
    } else if (op == "cut") {
        SmBrep* b = body(r, "body");
        const Value& pl = r["plane"];
        SmVector3d pt = v3(pl, "point"), n = unit(v3(pl, "normal"), "normal");
        // below keeps what the normal points away from, above the rest
        SmBrep* below = combine(copy_of(b), fresh_keys(half_space(b, pt, n)), "difference");
        SmBrep* above = nullptr;
        try {
            above = combine(copy_of(b), fresh_keys(half_space(b, pt, SmVector3d(-n.x, -n.y, -n.z))), "difference");
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
    } else if (op == "fillet" || op == "chamfer") {
        bool round = op == "fillet";
        double size = num(r, round ? "radiusMm" : "distanceMm");
        if (!(size > 0)) throw Error(round ? "radiusMm" : "distanceMm", "must be more than 0");
        if (!round && r.has("distance2Mm") && std::fabs(num(r, "distance2Mm") - size) > 1e-9)
            throw Error("distance2Mm", "a chamfer with two distances runs on the mesh");
        SmBrep* b = copy_of(body(r, "body"));
        try {
            SmTArray<SmEdge*> es = edges_of(b, r["edges"]);
            // a square outside edge is a wedge cut; any other edge sends them all through the fillet solver
            std::vector<SmBrep*> ws;
            if (!round) {
                for (ULONG i = 0; i < es.GetSize(); ++i) {
                    SmBrep* w = wedge(es[i], size);
                    if (!w) break;
                    ws.push_back(w);
                }
                if (ws.size() != es.GetSize()) {
                    for (auto w : ws) delete w;
                    ws.clear();
                }
            }
            if (!ws.empty()) {
                SmBrep* cut = b;
                b = nullptr;
                for (size_t i = 0; i < ws.size(); ++i) {
                    try {
                        cut = combine(cut, fresh_keys(ws[i]), "difference");
                    } catch (...) {
                        for (size_t j = i + 1; j < ws.size(); ++j) delete ws[j];
                        throw;
                    }
                }
                b = cut;
            } else {
                // a flat cross section tangent where a circle of the distance would be: that sets each face back
                // by the distance only where the faces are square to each other
                if (!round)
                    for (ULONG i = 0; i < es.GetSize(); ++i)
                        if (!square(es[i])) throw Error("edges", "edge " + std::to_string(i) + ": a chamfer between faces not square to each other runs on the mesh");
                // circular or flat cross section, G1 at the corners
                check(SmApiFilletEdges(b, es, size, round ? 1 : 0, 1, 1.0), op.c_str());
            }
        } catch (...) {
            delete b;
            throw;
        }
        out.set("body", Value(keep(key_new_faces(b))));
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
    } else if (op == "load") {
        // a saved body, kept under a number
        out.set("body", Value(keep(copy_of(body(r, "body")))));
    } else if (op == "save") {
        out.set("smb", write_smb(body(r, "body")));
    } else if (op == "count") {
        out.set("bodies", Value((unsigned long)bodies.size()));
    } else {
        throw Error("op", "unknown operation " + op);
    }
    // save: true also returns each new body as SMLib text, for a caller that keeps bodies between processes
    if (r["save"].kind == Value::Bool && r["save"].b && op != "save") {
        for (const char* k : {"body", "below", "above"})
            if (out[k].kind == Value::Number) out.set(std::string(k) + "Smb", write_smb(bodies.at(long(out[k].n))));
    }
    // withKeys: each new body's face keys, in face order, for a caller that tessellates later
    if (r["withKeys"].kind == Value::Bool && r["withKeys"].b) {
        for (const char* k : {"body", "below", "above"}) {
            if (out[k].kind != Value::Number) continue;
            SmTArray<SmFace*> fs;
            SmApiGetFaces(bodies.at(long(out[k].n)), fs);
            Value ks = Value::array();
            for (ULONG i = 0; i < fs.GetSize(); ++i) ks.push(Value(face_key(fs[i])));
            out.set(std::string(k) + "Keys", ks);
        }
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
    struct Unload {
        ~Unload()
        {
            for (SmBrep* b : loaded) delete b;
            loaded.clear();
        }
    } unload;
    try {
        Value r = sxj::Parser(request ? std::string(request) : std::string("{}")).parse();
        const Value& salt = r["keySalt"];
        keys.on = salt.kind == Value::Number && salt.n >= 0 && salt.n == std::floor(salt.n) && salt.n < 9007199254740992.0;
        keys.salt = keys.on ? (unsigned long long)salt.n : 0;
        keys.next = 0;
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
