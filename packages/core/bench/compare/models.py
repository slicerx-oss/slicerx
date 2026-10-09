# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Procedural test models for the slicer comparison.

Every model is generated from a formula, so there are no third-party mesh files and no license
to track beyond this repository's. Each one is a closed, manifold triangle mesh with outward
(counterclockwise) winding, rests on z = 0 and is centered on the middle of a 256 mm bed.
Output is binary STL. Generation is deterministic: the same code gives the same bytes.
"""
import math
import struct

BED_CENTER = (128.0, 128.0)


def _finish(tris):
    """Centers a triangle list ((x, y, z) * 3 per triangle) on the bed and drops it to z = 0."""
    xs = [v[0] for t in tris for v in t]
    ys = [v[1] for t in tris for v in t]
    zmin = min(v[2] for t in tris for v in t)
    ox = BED_CENTER[0] - (min(xs) + max(xs)) / 2
    oy = BED_CENTER[1] - (min(ys) + max(ys)) / 2
    moved = {}  # vertices are shared between triangles, so move each one once

    def move(v):
        m = moved.get(id(v))
        if m is None:
            m = moved[id(v)] = (v[0] + ox, v[1] + oy, v[2] - zmin)
        return m

    return [(move(a), move(b), move(c)) for a, b, c in tris]


def cube(size=20.0):
    """Calibration cube, 12 triangles."""
    h = size / 2
    p = [(x, y, z) for z in (-h, h) for y in (-h, h) for x in (-h, h)]
    quads = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
    tris = []
    for a, b, c, d in quads:
        tris.append((p[a], p[b], p[c]))
        tris.append((p[a], p[c], p[d]))
    return _finish(tris)


def gear(teeth=40, module=1.6, thickness=8.0, bore=6.0, samples_per_tooth=16):
    """Spur gear with a center bore, roughly 4k triangles at the defaults."""
    n = teeth * samples_per_tooth
    r_pitch = module * teeth / 2
    r_out, r_root = r_pitch + module, r_pitch - 1.25 * module
    outer, inner = [], []
    for i in range(n):
        a = 2 * math.pi * i / n
        phase = (i % samples_per_tooth) / samples_per_tooth
        k = 1.0 if 0.2 < phase < 0.5 else (0.0 if (phase < 0.1 or phase > 0.6) else
                                            (phase - 0.1) / 0.1 if phase < 0.2 else (0.6 - phase) / 0.1)
        r = r_root + (r_out - r_root) * k
        outer.append((r * math.cos(a), r * math.sin(a)))
        inner.append((bore / 2 * math.cos(a), bore / 2 * math.sin(a)))
    tris = []
    for i in range(n):
        j = (i + 1) % n
        (ox0, oy0), (ox1, oy1), (ix0, iy0), (ix1, iy1) = outer[i], outer[j], inner[i], inner[j]
        # top face, counterclockwise seen from +z
        tris.append(((ix0, iy0, thickness), (ox0, oy0, thickness), (ox1, oy1, thickness)))
        tris.append(((ix0, iy0, thickness), (ox1, oy1, thickness), (ix1, iy1, thickness)))
        # bottom face, reversed
        tris.append(((ix0, iy0, 0.0), (ox1, oy1, 0.0), (ox0, oy0, 0.0)))
        tris.append(((ix0, iy0, 0.0), (ix1, iy1, 0.0), (ox1, oy1, 0.0)))
        # outer wall
        tris.append(((ox0, oy0, 0.0), (ox1, oy1, 0.0), (ox1, oy1, thickness)))
        tris.append(((ox0, oy0, 0.0), (ox1, oy1, thickness), (ox0, oy0, thickness)))
        # bore wall, facing the axis
        tris.append(((ix0, iy0, 0.0), (ix1, iy1, thickness), (ix1, iy1, 0.0)))
        tris.append(((ix0, iy0, 0.0), (ix0, iy0, thickness), (ix1, iy1, thickness)))
    return _finish(tris)


def _closed_grid(point, nu, nv):
    """Triangulates a torus-topology parametric surface point(u, v), u and v in [0, 1)."""
    grid = [[point(i / nu, j / nv) for j in range(nv)] for i in range(nu)]
    tris = []
    for i in range(nu):
        i1 = (i + 1) % nu
        for j in range(nv):
            j1 = (j + 1) % nv
            a, b, c, d = grid[i][j], grid[i1][j], grid[i1][j1], grid[i][j1]
            tris.append((a, b, c))
            tris.append((a, c, d))
    return tris


def knot(nu=360, nv=48, tube=3.2, scale=9.0):
    """Trefoil torus knot tube. About 35k triangles at the defaults; raise nu and nv for more."""
    def center(t):
        a = 2 * math.pi * t
        return ((2 + math.cos(3 * a)) * math.cos(2 * a) * scale,
                (2 + math.cos(3 * a)) * math.sin(2 * a) * scale,
                math.sin(3 * a) * scale)

    def point(u, v):
        eps = 1e-4
        c = center(u)
        c2 = center(u + eps)
        t = tuple(c2[k] - c[k] for k in range(3))
        tl = math.sqrt(sum(x * x for x in t))
        t = tuple(x / tl for x in t)
        # Frame from the direction to the curve's center of curvature, so the tube never twists.
        c0 = center(u - eps)
        acc = tuple(c2[k] - 2 * c[k] + c0[k] for k in range(3))
        d = sum(acc[k] * t[k] for k in range(3))
        nrm = tuple(acc[k] - d * t[k] for k in range(3))
        nl = math.sqrt(sum(x * x for x in nrm))
        nrm = tuple(x / nl for x in nrm)
        b = (t[1] * nrm[2] - t[2] * nrm[1], t[2] * nrm[0] - t[0] * nrm[2], t[0] * nrm[1] - t[1] * nrm[0])
        ang = 2 * math.pi * v
        return tuple(c[k] + tube * (math.cos(ang) * nrm[k] + math.sin(ang) * b[k]) for k in range(3))

    tris = _closed_grid(point, nu, nv)
    # The frame can flip handedness, so fix the winding from the signed volume.
    return _finish(_outward(tris))


def vase(rows=96, cols=160, height=70.0):
    """Twisted bulb with a lobed waist and pole caps. About 30k triangles at the defaults."""
    def ring(i):
        u = i / rows
        prof = math.sin(math.pi * u) ** 0.7 * (22 + 5 * math.sin(5 * math.pi * u))
        return u, prof

    top, bottom = (0.0, 0.0, height), (0.0, 0.0, 0.0)
    rings = []
    for i in range(1, rows):
        u, prof = ring(i)
        r = []
        for j in range(cols):
            a = 2 * math.pi * j / cols + 2.4 * u
            rr = prof * (1 + 0.12 * math.cos(6 * a - 4 * u))
            r.append((rr * math.cos(a), rr * math.sin(a), height * u))
        rings.append(r)
    tris = []
    for j in range(cols):
        j1 = (j + 1) % cols
        tris.append((bottom, rings[0][j1], rings[0][j]))
        tris.append((top, rings[-1][j], rings[-1][j1]))
    for i in range(len(rings) - 1):
        for j in range(cols):
            j1 = (j + 1) % cols
            a, b, c, d = rings[i][j], rings[i][j1], rings[i + 1][j1], rings[i + 1][j]
            tris.append((a, b, c))
            tris.append((a, c, d))
    return _finish(_outward(tris))


def dense(nu=1000, nv=600):
    """A large mesh (1.2 million triangles at the defaults): a bumpy torus."""
    def point(u, v):
        a, b = 2 * math.pi * u, 2 * math.pi * v
        r = 9.0 + 2.0 * math.sin(7 * a) * math.cos(5 * b)
        return ((32 + r * math.cos(b)) * math.cos(a), (32 + r * math.cos(b)) * math.sin(a), r * math.sin(b) * 1.4)

    return _finish(_outward(_closed_grid(point, nu, nv)))


def _outward(tris):
    """Flips every triangle when the signed volume is negative."""
    vol = 0.0
    for a, b, c in tris:
        vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
    return tris if vol >= 0 else [(a, c, b) for a, b, c in tris]


MODELS = {
    "cube": cube,
    "gear": gear,
    "vase": vase,
    "knot": knot,
    "dense": dense,
}

def _read_stl(path):
    with open(path, "rb") as f:
        data = f.read()
    n = struct.unpack_from("<I", data, 80)[0]
    return [(r[3:6], r[6:9], r[9:12]) for r in struct.iter_unpack("<12fH", memoryview(data)[84:84 + 50 * n])]


def x_reference():
    """Core's procedural X plate (packages/core/bench/models/x-mark.stl, Apache-2.0), centered on the bed."""
    import os
    here = os.path.dirname(os.path.abspath(__file__))
    return _finish(_read_stl(os.path.join(here, "..", "models", "x-mark.stl")))


# Models that other agents or contributors add register here.
def _box(x0, x1, y0, y1, z0, z1):
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    t = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    return [(v[a], v[b], v[c]) for a, b, c in t]


def block(x=40.0, y=40.0, z=20.0):
    """A plain block, for infill patterns."""
    return _finish(_box(0, x, 0, y, 0, z))


def _leaning_box(x0, x1, y0, y1, z0, z1, deg):
    """A box whose top is moved toward +y so its sides lean `deg` degrees from vertical."""
    d = (z1 - z0) * math.tan(math.radians(deg))
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0 + d, z1), (x1, y0 + d, z1), (x1, y1 + d, z1), (x0, y1 + d, z1)]
    t = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    return [(v[a], v[b], v[c]) for a, b, c in t]


def leaning_slabs():
    """A 90 x 14 x 2 mm base with 8 x 4 mm slabs, 12 mm tall, leaning 20 to 70 degrees from vertical in 10 degree
    steps: which slopes print as overhang walls."""
    t = _box(-45, 45, -5, 9, 0, 2)
    for k, deg in enumerate(range(20, 80, 10)):
        x0 = -39 + 14 * k
        t += _leaning_box(x0, x0 + 8, -5, -1, 2, 14, deg)
    return _finish(t)


def stacked():
    """A 20 mm box up to z 5.5 under a 30 mm box: at 0.2 mm layers the two meet on a cutting plane, as the parts
    of a multi-color model often do. The layer there is the top of the lower box, and the upper box's walls hang
    over it from the next layer."""
    return _finish(_box(-10, 10, -10, 10, 0, 5.5) + _box(-15, 15, -15, 15, 5.5, 10))


def table():
    """A slab on two pillars 24 mm apart: bridges, and support under the slab."""
    return _finish(_box(0, 8, 0, 20, 0, 10) + _box(32, 40, 0, 20, 0, 10) + _box(0, 40, 0, 20, 10, 12))


def mushroom():
    """A slab, a pillar on it and a cap over the pillar: support that can rest on the part or must reach the bed."""
    return _finish(_box(0, 40, 0, 20, 0, 3) + _box(15, 25, 0, 20, 3, 13) + _box(0, 40, 0, 20, 13, 15))


def thin_plate(thickness=1.0):
    """A 30 x 1 mm plate, 6 mm tall: two walls leave a gap in the middle."""
    return _finish(_box(0, 30, 0, thickness, 0, 6))


def flare(bottom=10.0, top=43.0, height=10.0):
    """A square frustum wider at the top: walls that hang over the layer below."""
    def ring(w, z):
        h = w / 2
        return [(-h, -h, z), (h, -h, z), (h, h, z), (-h, h, z)]
    lo, hi = ring(bottom, 0.0), ring(top, height)
    t = [(lo[0], lo[2], lo[1]), (lo[0], lo[3], lo[2]), (hi[0], hi[1], hi[2]), (hi[0], hi[2], hi[3])]
    for k in range(4):
        n = (k + 1) % 4
        t.append((lo[k], lo[n], hi[n]))
        t.append((lo[k], hi[n], hi[k]))
    return _finish(t)


def _prism(ring, height):
    """A prism over a convex polygon (counterclockwise), fanned from its center."""
    n = len(ring)
    cx = sum(p[0] for p in ring) / n
    cy = sum(p[1] for p in ring) / n
    lo = [(x, y, 0.0) for x, y in ring]
    hi = [(x, y, height) for x, y in ring]
    c0, c1 = (cx, cy, 0.0), (cx, cy, height)
    t = []
    for i in range(n):
        j = (i + 1) % n
        t.append((c0, lo[j], lo[i]))
        t.append((c1, hi[i], hi[j]))
        t.append((lo[i], lo[j], hi[j]))
        t.append((lo[i], hi[j], hi[i]))
    return t


def toadstool(stem=3.0, cap=12.0, height=10.0, thick=2.0, n=96):
    """A round cap on a round stem: support areas with curved outlines."""
    def ring(r):
        return [(r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n)) for i in range(n)]
    stem_t = _prism(ring(stem), height)
    cap_t = [tuple((x, y, z + height) for x, y, z in tri) for tri in _prism(ring(cap), thick)]
    return _finish(stem_t + cap_t)


def wedge(length=40.0, thin=0.3, thick=3.0, height=6.0):
    """A plate that widens from `thin` to `thick` along its length: the wall count changes along it."""
    return _finish(_prism([(0, 0), (length, 0), (length, thick), (0, thin)], height))


def eccentric_ring(outer=10.0, inner=8.0, shift=1.2, height=6.0, n=128):
    """A pipe wall whose thickness runs from `outer - inner - shift` to `outer - inner + shift`."""
    def circle(r, dx):
        return [(dx + r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n), ) for i in range(n)]
    o, i = circle(outer, 0.0), circle(inner, shift)
    t = []
    for k in range(n):
        j = (k + 1) % n
        ol, oh = [(x, y, 0.0) for x, y in (o[k], o[j])], [(x, y, height) for x, y in (o[k], o[j])]
        il, ih = [(x, y, 0.0) for x, y in (i[k], i[j])], [(x, y, height) for x, y in (i[k], i[j])]
        t.append((ol[0], ol[1], oh[1]))
        t.append((ol[0], oh[1], oh[0]))
        t.append((il[1], il[0], ih[0]))
        t.append((il[1], ih[0], ih[1]))
        t.append((ol[0], il[0], il[1]))
        t.append((ol[0], il[1], ol[1]))
        t.append((oh[0], oh[1], ih[1]))
        t.append((oh[0], ih[1], ih[0]))
    return _finish(t)


def crossed_bars(length=40.0, width=1.2, height=6.0):
    """Two bars crossing at 60 degrees: thin walls that meet in a junction."""
    def bar(angle):
        c, s = math.cos(angle), math.sin(angle)
        pts = [(-length / 2, -width / 2), (length / 2, -width / 2), (length / 2, width / 2), (-length / 2, width / 2)]
        return _prism([(x * c - y * s, x * s + y * c) for x, y in pts], height)
    return _finish(bar(0.0) + bar(math.radians(60)))


def single_bar(width, length=40.0, height=6.0):
    pts = [(-length / 2, -width / 2), (length / 2, -width / 2), (length / 2, width / 2), (-length / 2, width / 2)]
    return _finish(_prism(pts, height))


def counterbore(outer=12.0, bore=6.0, hole=3.0, depth=4.0, height=10.0, n=96):
    """A round boss with a counterbored hole: a wide bore `depth` deep from the bottom, a narrow hole above,
    so the floor of the counterbore hangs over the bore."""
    def ring(r, z):
        return [(r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n), z) for i in range(n)]
    t = []

    def strip(a, b, flip):
        for i in range(n):
            j = (i + 1) % n
            for tri in ((a[i], a[j], b[j]), (a[i], b[j], b[i])):
                t.append(tri[::-1] if flip else tri)
    strip(ring(outer, 0), ring(outer, height), False)
    strip(ring(bore, 0), ring(outer, 0), False)
    strip(ring(bore, 0), ring(bore, depth), True)
    strip(ring(hole, depth), ring(bore, depth), False)
    strip(ring(hole, depth), ring(hole, height), True)
    strip(ring(hole, height), ring(outer, height), True)
    return _finish(t)


def register(name, builder):
    MODELS[name] = builder


register("x-reference", x_reference)
for _t in (30, 50, 60, 80):
    register(f"flare{_t}", lambda t=_t: flare(10.0, float(t), 10.0))
register("flare43", flare)
for _name, _fn in (("wedge", wedge), ("eccentric-ring", eccentric_ring), ("crossed-bars", crossed_bars), ("block", block), ("table", table), ("mushroom", mushroom), ("thin-plate", thin_plate), ("flare", flare), ("toadstool", toadstool), ("counterbore", counterbore),
                     ("leaning-slabs", leaning_slabs), ("stacked", stacked)):
    register(_name, _fn)


for _w in (1.0, 1.2, 1.4, 1.6):
    register(f"bar{int(_w * 10)}", lambda w=_w: single_bar(w))


def write_stl(path, tris):
    out = bytearray(b"slicerx compare".ljust(80, b"\0") + struct.pack("<I", len(tris)))
    pack = struct.Struct("<12fH").pack
    for a, b, c in tris:
        out += pack(0, 0, 0, *a, *b, *c, 0)
    with open(path, "wb") as f:
        f.write(out)


def check(tris):
    """Returns (problems, signed volume in mm^3). Every edge must be used by exactly two triangles, once each way."""
    edges = {}
    vol = 0.0
    for a, b, c in tris:
        vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
        for p, q in ((a, b), (b, c), (c, a)):
            k = (tuple(round(x, 4) for x in p), tuple(round(x, 4) for x in q))
            edges[k] = edges.get(k, 0) + 1
    problems = 0
    for (p, q), n in edges.items():
        if n != 1 or edges.get((q, p), 0) != 1:
            problems += 1
    return problems, vol
