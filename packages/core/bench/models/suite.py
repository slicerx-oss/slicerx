# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Procedural models for the speed benchmark against other slicers.

Each model stands for a kind of print people make, and each is generated here from a formula, so
the files are ours to use and share under Apache-2.0 (see LICENSES.md):

    tug         a small boat (60 x 30 x 50 mm): a flared hull that overhangs, a hollow cabin with
                windows that bridge, a roof that overhangs on every side, a chimney with a bore
                and a hawse hole through the bow; the kind of part a Benchy tests
    holes       a 200 x 140 x 4 mm plate with 70 round holes, a large flat part
    spire       a 180 mm tall fluted spire, 14 mm across at the foot, twisted once
    knot        the comparison harness's trefoil knot at twice its size, an organic shape
                that needs supports
    dense       the comparison harness's 1.2 million triangle bumpy torus
    plate20     a full plate of 20 small parts: 10 gears and 10 small tugs

    python3 suite.py <out dir>             # every model: <name>.stl and <name>.3mf, plus plates.json
    python3 suite.py <out dir> tug holes   # only these

The STL files rest on z = 0, centered on x = y = 0. The 3MF files place the same meshes on a
256 mm bed (centered, or at the plate's positions for plate20); plates.json gives the same
placements as engine request objects. Standard library only; the same arguments give the same bytes.
"""

import json
import math
import os
import struct
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', 'compare'))
import generate  # noqa: E402
import models as compare_models  # noqa: E402

BED = 256.0


def indexed(tris):
    """Triangle soup ((x, y, z) * 3 per triangle) to (vertices, index triangles)."""
    index, verts, out = {}, [], []
    for t in tris:
        ids = []
        for p in t:
            key = (round(p[0], 6), round(p[1], 6), round(p[2], 6))
            i = index.get(key)
            if i is None:
                i = index[key] = len(verts)
                verts.append(key)
            ids.append(i)
        if len(set(ids)) == 3:
            out.append(tuple(ids))
    return verts, out


def centered(verts):
    """Moves the mesh so it rests on z = 0, centered on x = y = 0."""
    return generate.settle(verts)[0]


# ---------------------------------------------------------------- tug


def _box(x, y, z, x0, x1, y0, y1, z0, z1):
    cx, cy, cz = (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2
    qx, qy, qz = abs(x - cx) - (x1 - x0) / 2, abs(y - cy) - (y1 - y0) / 2, abs(z - cz) - (z1 - z0) / 2
    return math.sqrt(max(qx, 0) ** 2 + max(qy, 0) ** 2 + max(qz, 0) ** 2) + min(max(qx, qy, qz), 0.0)


def _cyl(r_dist, axial, r, a0, a1):
    """Capped cylinder from the distance to its axis and the position along it."""
    w0, w1 = r_dist - r, max(a0 - axial, axial - a1)
    return min(max(w0, w1), 0.0) + math.hypot(max(w0, 0.0), max(w1, 0.0))


def _hull(x, y, z, shrink):
    """The hull's horizontal section: pointed at the bow (x > 0), round at the stern, flared upward."""
    s = 0.55 + 0.45 * math.sqrt(min(max(z, 0.0), 20.0) / 20.0)
    a, b = 30.0 * s - shrink, 13.0 * s - shrink
    u, v = x / a, y / b
    n = 1.7 if u > 0 else 3.5
    norm = (abs(u) ** n + abs(v) ** n) ** (1.0 / n)
    return (norm - 1.0) * min(a, b) * 0.8


def tug_sd(x, y, z):
    hull = max(_hull(x, y, z, 0.0), -z, z - 18.0)
    well = max(_hull(x, y, z, 2.5), 14.0 - z)
    hull = max(hull, -well)
    cabin = _box(x, y, z, -14, 4, -9, 9, 13.5, 36)
    roof = _box(x, y, z, -16, 6, -11, 11, 36, 38.5)
    chimney = _cyl(math.hypot(x + 5, y), z, 3.5, 38, 48)
    bollard = _cyl(math.hypot(x + 24, y), z, 2.0, 13.5, 20)
    solid = min(hull, cabin, roof, chimney, bollard)
    cuts = min(
        _box(x, y, z, -12, 2, -7, 7, 16, 34),           # cabin room
        _box(x, y, z, -10, 0, -10, 10, 24, 31),         # side windows
        _box(x, y, z, 1, 5, -5, 5, 25, 31),             # front window
        _box(x, y, z, -15, -11, -3.5, 3.5, 16, 30),     # door
        _cyl(math.hypot(x + 5, y), z, 2.0, 30, 49),     # chimney bore
        _cyl(math.hypot(x - 20, z - 12), y, 1.8, -20, 20),  # hawse hole
    )
    return max(solid, -cuts)


def tug(scale=1.0, cell=0.35):
    def f(x, y, z):
        return tug_sd(x / scale, y / scale, z / scale) * scale
    lo = (-33 * scale + 0.137 * cell, -16 * scale + 0.071 * cell, -1.0 + 0.293 * cell)
    hi = (33 * scale, 16 * scale, 50 * scale)
    verts, tris = generate.surface_nets(f, lo, hi, cell)
    return centered(verts), tris


# ---------------------------------------------------------------- plate with holes


def holes(nx=10, ny=7, pitch=20.0, thick=4.0, n=64):
    """Exact mesh: square cells, each with a round hole; checkerboard of 3 and 5 mm hole radii."""
    h = pitch / 2
    tan = [h * math.tan(2 * math.pi * m / n) for m in range(n // 8 + 1)]

    def square(k):
        """Offset of the cell boundary point for angle index k, exact and shared between cells."""
        k %= n
        e, m = divmod((k + n // 8) % n, n // 4)
        m -= n // 8
        t = tan[m] if m >= 0 else -tan[-m]
        return [(h, t), (-t, h), (-h, -t), (t, -h)][e]

    tris = []
    for i in range(nx):
        for j in range(ny):
            cx, cy = (i - (nx - 1) / 2) * pitch, (j - (ny - 1) / 2) * pitch
            r = 3.0 if (i + j) % 2 == 0 else 5.0
            for k in range(n):
                a0, a1 = 2 * math.pi * k / n, 2 * math.pi * (k + 1) / n
                c0 = (cx + r * math.cos(a0), cy + r * math.sin(a0))
                c1 = (cx + r * math.cos(a1), cy + r * math.sin(a1))
                s0, s1 = square(k), square(k + 1)
                s0 = (cx + s0[0], cy + s0[1])
                s1 = (cx + s1[0], cy + s1[1])
                for z, up in ((thick, True), (0.0, False)):
                    t1 = ((c0[0], c0[1], z), (s0[0], s0[1], z), (s1[0], s1[1], z))
                    t2 = ((c0[0], c0[1], z), (s1[0], s1[1], z), (c1[0], c1[1], z))
                    tris += [t1, t2] if up else [(t1[0], t1[2], t1[1]), (t2[0], t2[2], t2[1])]
                # hole wall, facing the axis
                tris.append(((c0[0], c0[1], 0.0), (c1[0], c1[1], thick), (c1[0], c1[1], 0.0)))
                tris.append(((c0[0], c0[1], 0.0), (c0[0], c0[1], thick), (c1[0], c1[1], thick)))
                # outer wall where this cell edge is the plate's edge
                mx, my = (s0[0] + s1[0]) / 2 - cx, (s0[1] + s1[1]) / 2 - cy
                edge = (abs(mx - h) < 1e-9 and i == nx - 1) or (abs(mx + h) < 1e-9 and i == 0) or \
                       (abs(my - h) < 1e-9 and j == ny - 1) or (abs(my + h) < 1e-9 and j == 0)
                if edge:
                    tris.append(((s0[0], s0[1], 0.0), (s1[0], s1[1], 0.0), (s1[0], s1[1], thick)))
                    tris.append(((s0[0], s0[1], 0.0), (s1[0], s1[1], thick), (s0[0], s0[1], thick)))
    return indexed(tris)


# ---------------------------------------------------------------- spire


def spire(height=180.0, rows=720, cols=96):
    """Six flutes, tapering from 7 to 4.5 mm radius, one full twist."""
    rings = []
    for i in range(rows + 1):
        u = i / rows
        z = height * u
        base = 7.0 - 2.5 * u
        ring = []
        for j in range(cols):
            a = 2 * math.pi * j / cols
            r = base * (1 + 0.16 * math.cos(6 * a - 2 * math.pi * u))
            ring.append((r * math.cos(a), r * math.sin(a), z))
        rings.append(ring)
    bottom, top = (0.0, 0.0, 0.0), (0.0, 0.0, height)
    tris = []
    for j in range(cols):
        j1 = (j + 1) % cols
        tris.append((bottom, rings[0][j1], rings[0][j]))
        tris.append((top, rings[-1][j], rings[-1][j1]))
    for i in range(rows):
        for j in range(cols):
            j1 = (j + 1) % cols
            a, b, c, d = rings[i][j], rings[i][j1], rings[i + 1][j1], rings[i + 1][j]
            tris.append((a, b, c))
            tris.append((a, c, d))
    return indexed(tris)


# ---------------------------------------------------------------- from the comparison harness


def from_soup(tris):
    verts, idx = indexed(tris)
    return centered(verts), idx


def knot():
    return from_soup(compare_models.knot(nu=720, nv=96, tube=6.4, scale=18.0))


def dense():
    return from_soup(compare_models.dense())


def gear():
    return from_soup(compare_models.gear(teeth=18, module=1.5, thickness=6.0, bore=5.0))


# ---------------------------------------------------------------- files


def write_stl(path, verts, tris):
    with open(path, 'wb') as fh:
        fh.write(b'SlicerX benchmark model, MPL-2.0'.ljust(80, b' '))
        fh.write(struct.pack('<I', len(tris)))
        for t in tris:
            a, b, c = (verts[i] for i in t)
            fh.write(struct.pack('<12fH', *generate.normal(a, b, c), *a, *b, *c, 0))


def write_3mf(path, meshes, items):
    """meshes: list of (name, verts, tris); items: list of (mesh index, x, y) placements on the bed."""
    objs = []
    for oid, (name, verts, tris) in enumerate(meshes, start=1):
        vs = ''.join('<vertex x="%.5f" y="%.5f" z="%.5f"/>' % p for p in verts)
        ts = ''.join('<triangle v1="%d" v2="%d" v3="%d"/>' % t for t in tris)
        objs.append('<object id="%d" name="%s" type="model"><mesh><vertices>%s</vertices>'
                    '<triangles>%s</triangles></mesh></object>' % (oid, name, vs, ts))
    build = ''.join('<item objectid="%d" transform="1 0 0 0 1 0 0 0 1 %.4f %.4f 0"/>' % (m + 1, x, y)
                    for m, x, y in items)
    model = ('<?xml version="1.0" encoding="UTF-8"?>\n'
             '<model unit="millimeter" xml:lang="en-US" '
             'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
             '<resources>%s</resources><build>%s</build></model>\n' % (''.join(objs), build))
    content_types = ('<?xml version="1.0" encoding="UTF-8"?>\n'
                     '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                     '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                     '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
                     '</Types>\n')
    rels = ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Target="/3D/3dmodel.model" Id="rel0" '
            'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>\n')
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, text in (('[Content_Types].xml', content_types), ('_rels/.rels', rels), ('3D/3dmodel.model', model)):
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, text)


SINGLE = {'tug': tug, 'holes': holes, 'spire': spire, 'knot': knot, 'dense': dense}


def plate20(out):
    """10 gears and 10 small tugs on a 5 x 4 grid, each with its own build item."""
    g = gear()
    t = tug(scale=0.45, cell=0.35)
    write_stl(os.path.join(out, 'plate20-gear.stl'), *g)
    write_stl(os.path.join(out, 'plate20-tug.stl'), *t)
    items = []
    for row in range(4):
        for col in range(5):
            items.append(((row + col) % 2, BED / 2 + (col - 2) * 46.0, BED / 2 + (row - 1.5) * 46.0))
    write_3mf(os.path.join(out, 'plate20.3mf'), [('gear', *g), ('tug', *t)], items)
    return {'meshes': ['plate20-gear.stl', 'plate20-tug.stl'], 'objects': [
        {'mesh': m, 'x': round(x, 4), 'y': round(y, 4)} for m, x, y in items],
        'triangles': sum(len((g, t)[m][1]) for m, _, _ in items)}


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    out = sys.argv[1]
    want = sys.argv[2:] or list(SINGLE) + ['plate20']
    os.makedirs(out, exist_ok=True)
    manifest_path = os.path.join(out, 'plates.json')
    manifest = json.load(open(manifest_path)) if os.path.exists(manifest_path) else {}
    for name in want:
        if name == 'plate20':
            manifest[name] = plate20(out)
        else:
            verts, tris = SINGLE[name]()
            write_stl(os.path.join(out, name + '.stl'), verts, tris)
            write_3mf(os.path.join(out, name + '.3mf'), [(name, verts, tris)], [(0, BED / 2, BED / 2)])
            manifest[name] = {'meshes': [name + '.stl'], 'objects': [{'mesh': 0, 'x': BED / 2, 'y': BED / 2}],
                              'triangles': len(tris)}
        print(name, manifest[name]['triangles'], 'triangles', flush=True)
        if name != 'plate20':
            print(' ', generate.check(*generate.read_stl(os.path.join(out, name + '.stl'))), flush=True)
    json.dump(manifest, open(manifest_path, 'w'), indent=1, sort_keys=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
