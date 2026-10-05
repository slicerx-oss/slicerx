# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Procedural reference model: the SlicerX X mark as a printable object.

The X from the logo stands upright on a small plinth, with eight horizontal
bands (alternate bands set in slightly, a shallow groove between bands) and
rounded edges. The solid is a signed distance function meshed with surface
nets on a uniform grid, so the result is closed and consistently oriented.

    python3 generate.py                   # writes x-mark.stl and x-mark-2color.3mf
    python3 generate.py --check x-mark.stl
    python3 generate.py --twist-deg 30 --taper 0.2 --out twisted.stl

Standard library only. The same arguments always give the same bytes.
"""

import argparse
import math
import struct
import sys
import zipfile

# The logo mark, a 32 x 32 view box with y down.
MARK = [
    (4.5, 4.0), (10.7, 4.0), (16.0, 12.1), (21.3, 4.0), (27.5, 4.0), (19.2, 16.0),
    (27.5, 28.0), (21.3, 28.0), (16.0, 19.9), (10.7, 28.0), (4.5, 28.0), (12.8, 16.0),
]
BANDS = 8


class Shape:
    def __init__(self, height, thickness, twist_deg, taper, radius, plinth_h, inset, groove):
        self.height = height
        self.half_t = thickness / 2.0
        self.twist = math.radians(twist_deg)
        self.taper = taper
        self.r = radius
        self.plinth_h = plinth_h
        self.inset = inset
        self.groove = groove
        s = height / 24.0  # the mark spans y = 4..28
        self.poly = [((px - 16.0) * s, (28.0 - py) * s) for px, py in MARK]
        self.z0 = plinth_h - 0.5  # the X sinks 0.5 mm into the plinth
        self.band_h = height / BANDS
        xs = [p[0] for p in self.poly]
        self.plinth_hx = max(xs) + 4.0
        self.plinth_hy = self.half_t + 5.0
        self.plinth_r = 2.0

    def band_of(self, z):
        return int(math.floor((z - self.z0) / self.band_h))

    def sd_mark(self, x, zl):
        """Signed distance to the mark polygon in its own plane (negative inside)."""
        best = float('inf')
        inside = False
        n = len(self.poly)
        for i in range(n):
            ax, az = self.poly[i]
            bx, bz = self.poly[(i + 1) % n]
            ex, ez = bx - ax, bz - az
            wx, wz = x - ax, zl - az
            t = (wx * ex + wz * ez) / (ex * ex + ez * ez)
            t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
            dx, dz = wx - ex * t, wz - ez * t
            d = dx * dx + dz * dz
            if d < best:
                best = d
            if (az > zl) != (bz > zl) and x < ax + (zl - az) * ex / ez:
                inside = not inside
        d = math.sqrt(best)
        return -d if inside else d

    def half_thickness(self, z):
        k = self.band_of(z)
        h = self.half_t - (self.inset if k % 2 == 1 else 0.0)
        # Shallow V groove centered on each band boundary.
        zb = self.z0 + round((z - self.z0) / self.band_h) * self.band_h
        if self.z0 < zb < self.z0 + self.height:
            h -= self.groove * max(0.0, 1.0 - abs(z - zb) / 0.6)
        return h

    def sd_x(self, x, y, z):
        zl = z - self.z0
        f = min(max(zl / self.height, 0.0), 1.0)
        if self.twist:
            a = -self.twist * f
            c, s = math.cos(a), math.sin(a)
            x, y = x * c - y * s, x * s + y * c
        if self.taper:
            k = 1.0 - self.taper * f
            x, y = x / k, y / k
        d2 = self.sd_mark(x, zl)
        r = self.r
        w0 = d2 + r
        w1 = abs(y) - self.half_thickness(z) + r
        return min(max(w0, w1), 0.0) + math.hypot(max(w0, 0.0), max(w1, 0.0)) - r

    def sd_plinth(self, x, y, z):
        r = self.plinth_r
        hz = self.plinth_h / 2.0
        qx = abs(x) - self.plinth_hx + r
        qy = abs(y) - self.plinth_hy + r
        qz = abs(z - hz) - hz + r
        return math.sqrt(max(qx, 0) ** 2 + max(qy, 0) ** 2 + max(qz, 0) ** 2) + min(max(qx, qy, qz), 0.0) - r

    def sd(self, x, y, z):
        a = self.sd_x(x, y, z)
        b = self.sd_plinth(x, y, z)
        k = 1.0  # smooth union radius, mm
        h = min(max(0.5 + 0.5 * (b - a) / k, 0.0), 1.0)
        return b * (1 - h) + a * h - k * h * (1 - h)

    def bounds(self):
        m = self.plinth_hx + 2.0
        return (-m, -self.plinth_hy - 2.0, -1.0), (m, self.plinth_hy + 2.0, self.z0 + self.height + 2.0)


def slab_sd(z, intervals):
    """Signed distance to a union of z intervals (negative inside)."""
    best = float('inf')
    for lo, hi in intervals:
        d = max(lo - z, z - hi)
        best = min(best, d)
    return best


def surface_nets(f, lo, hi, cell):
    """Meshes f < 0 on a grid; returns (vertices, triangles), outward and counterclockwise."""
    nx = int(math.ceil((hi[0] - lo[0]) / cell)) + 1
    ny = int(math.ceil((hi[1] - lo[1]) / cell)) + 1
    nz = int(math.ceil((hi[2] - lo[2]) / cell)) + 1
    xs = [lo[0] + i * cell for i in range(nx)]
    ys = [lo[1] + j * cell for j in range(ny)]
    zs = [lo[2] + k * cell for k in range(nz)]
    v = [[[f(xs[i], ys[j], zs[k]) for k in range(nz)] for j in range(ny)] for i in range(nx)]
    for i in range(nx):
        for j in range(ny):
            for k in range(nz):
                if i in (0, nx - 1) or j in (0, ny - 1) or k in (0, nz - 1):
                    v[i][j][k] = max(v[i][j][k], 1e-6)
                elif v[i][j][k] == 0.0:
                    v[i][j][k] = 1e-9  # zero counts as outside
    corners = [(a, b, c) for a in (0, 1) for b in (0, 1) for c in (0, 1)]
    edges = [(p, q) for p in range(8) for q in range(p + 1, 8)
             if sum(abs(corners[p][t] - corners[q][t]) for t in range(3)) == 1]
    index = {}
    verts = []
    for i in range(nx - 1):
        for j in range(ny - 1):
            for k in range(nz - 1):
                vals = [v[i + a][j + b][k + c] for a, b, c in corners]
                neg = [x < 0 for x in vals]
                if all(neg) or not any(neg):
                    continue
                sx = sy = sz = 0.0
                cnt = 0
                for p, q in edges:
                    if neg[p] != neg[q]:
                        t = vals[p] / (vals[p] - vals[q])
                        ap, bp, cp = corners[p]
                        aq, bq, cq = corners[q]
                        sx += ap + (aq - ap) * t
                        sy += bp + (bq - bp) * t
                        sz += cp + (cq - cp) * t
                        cnt += 1
                index[(i, j, k)] = len(verts)
                verts.append((xs[i] + sx / cnt * cell, ys[j] + sy / cnt * cell, zs[k] + sz / cnt * cell))
    tris = []

    def quad(cells, outward_positive):
        ids = [index[c] for c in cells]
        if not outward_positive:
            ids.reverse()
        a, b, c, d = ids
        pa, pb, pc, pd = verts[a], verts[b], verts[c], verts[d]
        # Split along the shorter diagonal.
        if sum((pa[t] - pc[t]) ** 2 for t in range(3)) <= sum((pb[t] - pd[t]) ** 2 for t in range(3)):
            tris.append((a, b, c))
            tris.append((a, c, d))
        else:
            tris.append((a, b, d))
            tris.append((b, c, d))

    for i in range(nx - 1):
        for j in range(1, ny - 1):
            for k in range(1, nz - 1):
                a, b = v[i][j][k] < 0, v[i + 1][j][k] < 0
                if a != b:
                    quad([(i, j - 1, k - 1), (i, j, k - 1), (i, j, k), (i, j - 1, k)], a)
    for i in range(1, nx - 1):
        for j in range(ny - 1):
            for k in range(1, nz - 1):
                a, b = v[i][j][k] < 0, v[i][j + 1][k] < 0
                if a != b:
                    quad([(i - 1, j, k - 1), (i - 1, j, k), (i, j, k), (i, j, k - 1)], a)
    for i in range(1, nx - 1):
        for j in range(1, ny - 1):
            for k in range(nz - 1):
                a, b = v[i][j][k] < 0, v[i][j][k + 1] < 0
                if a != b:
                    quad([(i - 1, j - 1, k), (i, j - 1, k), (i, j, k), (i - 1, j, k)], a)
    # Drop triangles that collapsed to a line.
    tris = [t for t in tris if len(set(t)) == 3]
    return verts, tris


def settle(verts):
    """Moves the mesh so it rests on z = 0, centered on x = y = 0."""
    mn = [min(p[t] for p in verts) for t in range(3)]
    mx = [max(p[t] for p in verts) for t in range(3)]
    off = ((mn[0] + mx[0]) / 2.0, (mn[1] + mx[1]) / 2.0, mn[2])
    return [(p[0] - off[0], p[1] - off[1], p[2] - off[2]) for p in verts], off


def normal(a, b, c):
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    n = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
    l = math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2) or 1.0
    return (n[0] / l, n[1] / l, n[2] / l)


def write_stl(path, verts, tris):
    with open(path, 'wb') as fh:
        fh.write(b'SlicerX X mark reference model, MPL-2.0'.ljust(80, b' '))
        fh.write(struct.pack('<I', len(tris)))
        for t in tris:
            a, b, c = (verts[i] for i in t)
            fh.write(struct.pack('<12fH', *normal(a, b, c), *a, *b, *c, 0))


def write_3mf(path, objects):
    """objects: list of (name, verts, tris, slot)."""
    parts = []
    for oid, (name, verts, tris, _) in enumerate(objects, start=1):
        vs = ''.join('<vertex x="%.4f" y="%.4f" z="%.4f"/>' % p for p in verts)
        ts = ''.join('<triangle v1="%d" v2="%d" v3="%d"/>' % t for t in tris)
        parts.append('<object id="%d" name="%s" type="model"><mesh><vertices>%s</vertices>'
                     '<triangles>%s</triangles></mesh></object>' % (oid, name, vs, ts))
    items = ''.join('<item objectid="%d"/>' % oid for oid in range(1, len(objects) + 1))
    model = ('<?xml version="1.0" encoding="UTF-8"?>\n'
             '<model unit="millimeter" xml:lang="en-US" '
             'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
             '<resources>%s</resources><build>%s</build></model>\n' % (''.join(parts), items))
    settings = ('<?xml version="1.0" encoding="UTF-8"?>\n<config>%s</config>\n' % ''.join(
        '<object id="%d"><metadata key="extruder" value="%d"/></object>' % (oid, o[3])
        for oid, o in enumerate(objects, start=1)))
    content_types = ('<?xml version="1.0" encoding="UTF-8"?>\n'
                     '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                     '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                     '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
                     '<Default Extension="config" ContentType="text/xml"/></Types>\n')
    rels = ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Target="/3D/3dmodel.model" Id="rel0" '
            'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>\n')
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, text in (('[Content_Types].xml', content_types), ('_rels/.rels', rels),
                           ('3D/3dmodel.model', model), ('Metadata/model_settings.config', settings)):
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, text)


def check(verts, tris):
    edges = {}
    for t in tris:
        for a, b in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
            edges[(a, b)] = edges.get((a, b), 0) + 1
    open_edges = sum(1 for (a, b) in edges if (b, a) not in edges)
    repeated = sum(1 for n in edges.values() if n > 1)
    vol = 0.0
    for t in tris:
        a, b, c = (verts[i] for i in t)
        vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
    mn = [min(p[t] for p in verts) for t in range(3)]
    mx = [max(p[t] for p in verts) for t in range(3)]
    return {
        'triangles': len(tris), 'vertices': len(verts), 'open_edges': open_edges,
        'repeated_edges': repeated, 'volume_mm3': round(vol, 1),
        'size_mm': [round(mx[t] - mn[t], 2) for t in range(3)],
    }


def read_stl(path):
    data = open(path, 'rb').read()
    n = struct.unpack_from('<I', data, 80)[0]
    index, verts, tris = {}, [], []
    for i in range(n):
        vals = struct.unpack_from('<12f', data, 84 + 50 * i)
        t = []
        for k in range(3):
            p = vals[3 + 3 * k: 6 + 3 * k]
            if p not in index:
                index[p] = len(verts)
                verts.append(p)
            t.append(index[p])
        tris.append(tuple(t))
    return verts, tris


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--height', type=float, default=80.0, help='height of the X, mm')
    ap.add_argument('--thickness', type=float, default=16.0, help='thickness of the X, mm')
    ap.add_argument('--twist-deg', type=float, default=0.0, help='twist across the height, degrees')
    ap.add_argument('--taper', type=float, default=0.0, help='fraction the X shrinks toward the top')
    ap.add_argument('--cell', type=float, default=1.2, help='grid size, mm (smaller means more triangles)')
    ap.add_argument('--out', default='x-mark.stl', help='single-color STL path')
    ap.add_argument('--out-2color', default='x-mark-2color.3mf', help='two-color 3MF path ("" to skip)')
    ap.add_argument('--check', metavar='STL', help='only report on an existing binary STL')
    a = ap.parse_args()
    if a.check:
        print(check(*read_stl(a.check)))
        return 0
    shape = Shape(a.height, a.thickness, a.twist_deg, a.taper, radius=1.5, plinth_h=6.0, inset=0.6, groove=0.5)
    lo, hi = shape.bounds()
    # Offset the grid by a fraction of a cell so no sample lands exactly on a band boundary.
    lo = (lo[0] + 0.137 * a.cell, lo[1] + 0.071 * a.cell, lo[2] + 0.293 * a.cell)
    verts, tris = surface_nets(shape.sd, lo, hi, a.cell)
    verts, off = settle(verts)
    write_stl(a.out, verts, tris)
    print(a.out, check(verts, tris))
    if a.out_2color:
        top = shape.z0 + shape.height
        even = [(-10.0, shape.z0 + shape.band_h)] + [
            (shape.z0 + k * shape.band_h, shape.z0 + (k + 1) * shape.band_h) for k in range(2, BANDS, 2)]
        odd = [(shape.z0 + k * shape.band_h, shape.z0 + (k + 1) * shape.band_h) for k in range(1, BANDS, 2)]
        objects = []
        for name, slabs, slot in (('X mark bands A', even, 1), ('X mark bands B', odd, 2)):
            f = lambda x, y, z, s=slabs: max(shape.sd(x, y, z), slab_sd(z, s))
            pv, pt = surface_nets(f, lo, (hi[0], hi[1], top + 2.0), a.cell)
            pv = [(p[0] - off[0], p[1] - off[1], p[2] - off[2]) for p in pv]
            print(name, check(pv, pt))
            objects.append((name, pv, pt, slot))
        write_3mf(a.out_2color, objects)
        print(a.out_2color, 'written')
    return 0


if __name__ == '__main__':
    sys.exit(main())
