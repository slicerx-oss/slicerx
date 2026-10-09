# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Showcase model: the SlicerX X mark with exact geometry, for close-up views.

The same X as generate.py (the logo mark standing upright on a plinth, eight horizontal bands with alternate bands
set in 0.6 mm), built from exact faces instead of a meshed distance field: the outline is extruded, every band step
is a flat face with a V groove at the boundary and a 45 degree underside where a band stands out over the one below,
and the front and back edges are rounded as fine facets. The mesh is closed and consistently
oriented, and its edges are clean at any zoom. generate.py's x-mark.stl stays the benchmark model.

    python3 generate_showcase.py                  # writes x-mark-showcase.stl and x-mark-showcase-2color.3mf
    python3 generate_showcase.py --check FILE.stl

Standard library only. The same arguments always give the same bytes.
"""

import argparse
import json
import math
import sys

import struct
import zipfile

from generate import MARK, check, normal, read_stl

BANDS = 8


# ---- 2D helpers (x, z) ----

def area(poly):
    return sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1]
               for i in range(len(poly))) / 2.0


def cross(o, a, b):
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def in_triangle(p, a, b, c):
    return cross(a, b, p) >= 0 and cross(b, c, p) >= 0 and cross(c, a, p) >= 0


def ear_clip(poly):
    """Triangulates a simple counterclockwise polygon; returns index triples into poly."""
    idx = list(range(len(poly)))
    out = []
    guard = 0
    while len(idx) > 3 and guard < 100000:
        guard += 1
        n = len(idx)
        for k in range(n):
            i0, i1, i2 = idx[(k - 1) % n], idx[k], idx[(k + 1) % n]
            a, b, c = poly[i0], poly[i1], poly[i2]
            if cross(a, b, c) <= 1e-12:
                continue
            if any(in_triangle(poly[j], a, b, c) for j in idx if j not in (i0, i1, i2) and poly[j] not in (a, b, c)):
                continue
            out.append((i0, i1, i2))
            del idx[k]
            break
        else:
            # Only collinear corners left: cut the flattest one away.
            k = min(range(n), key=lambda k: abs(cross(poly[idx[(k - 1) % n]], poly[idx[k]], poly[idx[(k + 1) % n]])))
            out.append((idx[(k - 1) % n], idx[k], idx[(k + 1) % n]))
            del idx[k]
    if len(idx) == 3:
        out.append(tuple(idx))
    return out


def bridge_holes(outer, holes):
    """One simple counterclockwise polygon from an outer polygon (ccw) and holes (cw), joined by bridges."""
    poly = list(outer)
    for hole in sorted(holes, key=lambda h: -max(p[0] for p in h)):
        hi = max(range(len(hole)), key=lambda i: (hole[i][0], hole[i][1]))
        m = hole[hi]
        # The nearest polygon vertex the hole's rightmost point sees.
        best = None
        for i, p in enumerate(poly):
            if p[0] < m[0]:
                continue
            ok = True
            for j in range(len(poly)):
                a, b = poly[j], poly[(j + 1) % len(poly)]
                if p in (a, b):
                    continue
                if segments_cross(m, p, a, b):
                    ok = False
                    break
            if ok:
                d = (p[0] - m[0]) ** 2 + (p[1] - m[1]) ** 2
                if best is None or d < best[0]:
                    best = (d, i)
        i = best[1]
        ring = hole[hi:] + hole[:hi] + [hole[hi]]
        poly = poly[:i + 1] + ring + poly[i:]
    return poly


def segments_cross(p1, p2, p3, p4):
    d1, d2 = cross(p3, p4, p1), cross(p3, p4, p2)
    d3, d4 = cross(p1, p2, p3), cross(p1, p2, p4)
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)) and abs(d1) > 1e-12 and abs(d2) > 1e-12


def line_x_at(a, b, z):
    t = (z - a[1]) / (b[1] - a[1])
    return a[0] + (b[0] - a[0]) * t


# ---- the X profile, cut into bands ----

def band_pieces(poly, lo, hi, eps=1e-9):
    """The parts of a ccw polygon between the cut lines z = lo and z = hi (either may be None: no cut there), each a
    ccw list of (point, kind of the edge from it to the next point): 'side' for a piece of the outline, 'cut' for a
    piece of a cut line."""
    lines = [z for z in (lo, hi) if z is not None]
    n = len(poly)
    pts = []
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        pts.append(a)
        for c in sorted([z for z in lines if min(a[1], b[1]) + eps < z < max(a[1], b[1]) - eps],
                        key=lambda z: (z - a[1]) / (b[1] - a[1])):
            pts.append((line_x_at(a, b, c), c))
    # Points on a cut line within eps are put on it exactly.
    pts = [next(((p[0], z) for z in lines if abs(p[1] - z) <= eps), p) for p in pts]
    m = len(pts)
    on = [any(p[1] == z for z in lines) for p in pts]

    def inside(p):
        return (lo is None or p[1] > lo) and (hi is None or p[1] < hi)

    if not any(on):
        return [[(p, 'side') for p in pts]] if inside(pts[0]) else []
    chains = []
    for s in range(m):
        if not on[s]:
            continue
        nx = (s + 1) % m
        if not (inside(pts[nx]) or (on[nx] and pts[nx][1] != pts[s][1])):
            continue
        chain = [s]
        j = nx
        while not on[j]:
            chain.append(j)
            j = (j + 1) % m
        chain.append(j)
        chains.append(chain)
    by_start = {c[0]: c for c in chains}
    starts = [c[0] for c in chains]

    def next_chain(e):
        """Along the cut line from e, the interior on the left: leftward on the top line, rightward on the bottom one."""
        p = pts[e]
        same = [s for s in starts if pts[s][1] == p[1]]
        if hi is not None and p[1] == hi:
            s = max((s for s in same if pts[s][0] < p[0]), key=lambda s: pts[s][0])
        else:
            s = min((s for s in same if pts[s][0] > p[0]), key=lambda s: pts[s][0])
        return by_start[s]

    pieces, used = [], set()
    for c in chains:
        if c[0] in used:
            continue
        piece, cur = [], c
        while cur[0] not in used:
            used.add(cur[0])
            piece += [(pts[k], 'side') for k in cur[:-1]]
            piece.append((pts[cur[-1]], 'cut'))
            cur = next_chain(cur[-1])
        pieces.append(piece)
    return pieces


def offset_piece(piece, d):
    """The piece with its outline edges moved in by d (cut edges stay on their line); mitered corners."""
    n = len(piece)
    lines = []
    for i in range(n):
        a, kind = piece[i]
        b = piece[(i + 1) % n][0]
        ex, ez = b[0] - a[0], b[1] - a[1]
        l = math.hypot(ex, ez)
        nx, nz = -ez / l, ex / l  # inward for ccw
        s = d if kind == 'side' else 0.0
        lines.append(((a[0] + nx * s, a[1] + nz * s), (ex, ez)))
    out = []
    for i in range(n):
        (p, u), (q, v) = lines[i - 1], lines[i]
        den = u[0] * v[1] - u[1] * v[0]
        if abs(den) < 1e-12:
            out.append(q)
            continue
        t = ((q[0] - p[0]) * v[1] - (q[1] - p[1]) * v[0]) / den
        out.append((p[0] + u[0] * t, p[1] + u[1] * t))
    return out


class Mesh:
    def __init__(self):
        self.verts = []
        self.index = {}
        self.tris = []

    def v(self, p):
        key = (round(p[0], 6), round(p[1], 6), round(p[2], 6))
        i = self.index.get(key)
        if i is None:
            i = self.index[key] = len(self.verts)
            self.verts.append(key)
        return i

    def tri(self, a, b, c):
        ia, ib, ic = self.v(a), self.v(b), self.v(c)
        if len({ia, ib, ic}) == 3:
            self.tris.append((ia, ib, ic))

    def quad(self, a, b, c, d):
        """a, b, c, d counterclockwise seen from outside."""
        self.tri(a, b, c)
        self.tri(a, c, d)

    def face(self, pts3, normal):
        """A planar polygon (3D points, in order, either way round), triangulated facing `normal`."""
        ax = max(range(3), key=lambda k: abs(normal[k]))
        u, w = [k for k in range(3) if k != ax]
        flat = [(p[u], p[w]) for p in pts3]
        ccw = area(flat) > 0
        order = list(range(len(flat))) if ccw else list(range(len(flat)))[::-1]
        poly = [flat[i] for i in order]
        for t in ear_clip(poly):
            a, b, c = (pts3[order[k]] for k in t)
            # The triangle's normal sign along the face's axis, from its own winding in (u, w).
            sign = 1 if (u, w) in ((0, 1), (1, 2), (2, 0)) else -1
            if (sign > 0) == (normal[ax] > 0):
                self.tri(a, b, c)
            else:
                self.tri(a, c, b)


class Showcase:
    def __init__(self, height=80.0, thickness=16.0, inset=0.6, radius=1.2, steps=10, plinth_h=6.0, plinth_r=2.0, groove=0.6,
                 groove_width=1.2):
        s = height / 24.0
        self.z0 = plinth_h
        self.poly = [((px - 16.0) * s, self.z0 + (28.0 - py) * s) for px, py in MARK]
        if area(self.poly) < 0:
            self.poly.reverse()
        self.height = height
        self.band_h = height / BANDS
        self.h_thick = thickness / 2.0
        self.h_thin = thickness / 2.0 - inset
        self.r = radius
        self.steps = steps
        self.groove = groove
        self.groove_w = groove_width / 2.0
        xs = [p[0] for p in self.poly]
        self.plinth = (max(xs) + 4.0, self.h_thick + 5.0, plinth_h, plinth_r)

    def h_of(self, k):
        return self.h_thick if k % 2 == 0 else self.h_thin

    def bounds_of(self, k):
        lo = None if k == 0 else self.z0 + k * self.band_h
        hi = None if k == BANDS - 1 else self.z0 + (k + 1) * self.band_h
        return lo, hi

    def levels(self, h):
        """(inset, y) of each step of the rounded edge, from the wall top (0, h - r) to the face (r, h)."""
        out = []
        for i in range(self.steps + 1):
            phi = (math.pi / 2.0) * i / self.steps
            out.append((self.r * (1.0 - math.cos(phi)), h - self.r + self.r * math.sin(phi)))
        return out

    def groove_at(self, z):
        """How far the faces are set in at height z by the V groove centered on each band boundary."""
        k = round((z - self.z0) / self.band_h)
        if not 0 < k < BANDS:
            return 0.0
        return self.groove * max(0.0, 1.0 - abs(z - (self.z0 + k * self.band_h)) / self.groove_w)

    def chamfered(self, k):
        """Whether band k stands out over the band below it: its step then has a 45 degree underside, not a ledge."""
        return k > 0 and self.h_of(k) > self.h_of(k - 1)

    def chamfer_h(self, k):
        """How far above band k's bottom its 45 degree underside reaches its full face."""
        return self.h_of(k) - (self.h_of(k - 1) - self.groove)

    def h_at(self, k, z):
        h = self.h_of(k) - self.groove_at(z)
        if self.chamfered(k):
            lo = self.bounds_of(k)[0]
            # From the groove's bottom in the band below, out at 45 degrees to this band's face.
            h = min(h, self.h_of(k - 1) - self.groove + (z - lo))
        return h

    def wall_rows(self, k, z):
        """The wall's rows at height z. A set-out band's wall has the set-in band's rows too, so its step meets them."""
        h = self.h_at(k, z)
        rows = [-(h - self.r), h - self.r]
        if self.h_of(k) > self.h_thin:
            t = self.h_thin - self.groove_at(z)
            rows = [-(h - self.r), -(t - self.r), t - self.r, h - self.r]
        return rows

    def sub_bands(self, k):
        """Band k's height ranges: the groove slopes next to each band boundary, and the flat face between."""
        lo, hi = self.bounds_of(k)
        cuts = [lo]
        if lo is not None:
            cuts.append(lo + (self.chamfer_h(k) if self.chamfered(k) else self.groove_w))
        if hi is not None:
            cuts.append(hi - self.groove_w)
        cuts.append(hi)
        return list(zip(cuts, cuts[1:]))

    def slab(self, mesh, k, caps):
        """Band k's surfaces into mesh. Returns its sections at band boundaries: [(z, 'lo' or 'hi', section)]."""
        lo, hi = self.bounds_of(k)
        insets = [d for d, _ in self.levels(0.0)]
        sections = []
        for slo, shi in self.sub_bands(k):
            for piece in band_pieces(self.poly, slo, shi):
                n = len(piece)
                # The X stands on the plinth: its bottom edges are a cut, not an outline to round.
                piece = [(p, 'cut' if p[1] == self.z0 and piece[(i + 1) % n][0][1] == self.z0 else kind) for i, (p, kind) in enumerate(piece)]
                off = [offset_piece(piece, d) for d in insets]
                for q in off[-1]:
                    if not (slo is None or q[1] >= slo - 1e-9) or not (shi is None or q[1] <= shi + 1e-9):
                        raise ValueError('band %d: the rounded edge does not fit between z %s and %s' % (k, slo, shi))
                # Each point's face height follows the groove at its own height.
                ys = [[y for _, y in self.levels(self.h_at(k, q[1]))] for q in off[0]]
                rows = [self.wall_rows(k, q[1]) for q in off[0]]
                for i in range(n):
                    if piece[i][1] != 'side':
                        continue
                    j = (i + 1) % n
                    a, b = piece[i][0], piece[j][0]
                    for (ya0, ya1), (yb0, yb1) in zip(zip(rows[i], rows[i][1:]), zip(rows[j], rows[j][1:])):
                        mesh.quad((a[0], ya0, a[1]), (a[0], ya1, a[1]), (b[0], yb1, b[1]), (b[0], yb0, b[1]))
                    for t in range(self.steps):
                        a0, b0, a1, b1 = off[t][i], off[t][j], off[t + 1][i], off[t + 1][j]
                        ia0, ia1, ib0, ib1 = ys[i][t], ys[i][t + 1], ys[j][t], ys[j][t + 1]
                        mesh.quad((a0[0], ia0, a0[1]), (a1[0], ia1, a1[1]), (b1[0], ib1, b1[1]), (b0[0], ib0, b0[1]))
                        mesh.quad((a1[0], -ia1, a1[1]), (a0[0], -ia0, a0[1]), (b0[0], -ib0, b0[1]), (b1[0], -ib1, b1[1]))
                face = off[-1]
                mesh.face([(p[0], ys[i][-1], p[1]) for i, p in enumerate(face)], (0, 1, 0))
                mesh.face([(p[0], -ys[i][-1], p[1]) for i, p in enumerate(face)], (0, -1, 0))
                for i in range(n):
                    if piece[i][1] != 'cut':
                        continue
                    j = (i + 1) % n
                    z = piece[i][0][1]
                    if z == self.z0 or (lo is not None and z == lo):
                        side = 'lo'
                    elif hi is not None and z == hi:
                        side = 'hi'
                    else:
                        continue  # between a band's own groove slope and its face: the surfaces meet there
                    sections.append((z, side, self.section(off, ys[i], rows[i], i, j)))
        for z, side, sec in sections:
            if caps.get((k, side)):
                mesh.face([(x, y, z) for x, y in sec['ring']], (0, 0, 1 if side == 'hi' else -1))
        return sections

    def section(self, off, ys, rows, i, j):
        """The cut section between piece points i and j (in x, y; both at the cut's height, so sharing ys and rows)."""
        steps = self.steps
        xp = [off[t][i][0] for t in range(steps + 1)]
        xq = [off[t][j][0] for t in range(steps + 1)]
        ring = [(xp[0], y) for y in rows]
        ring += [(xp[t], ys[t]) for t in range(1, steps + 1)]
        ring += [(xq[t], ys[t]) for t in range(steps, 0, -1)]
        ring += [(xq[0], y) for y in reversed(rows)]
        ring += [(xq[t], -ys[t]) for t in range(1, steps + 1)]
        ring += [(xp[t], -ys[t]) for t in range(steps, 0, -1)]
        return {'ring': ring, 'xp': xp, 'xq': xq, 'ys': ys}

    def steps_between(self, mesh, below, above):
        """The flat band steps between two touching bands' sections at their cut."""
        for z, side, a in below:
            if side != 'hi':
                continue
            for z2, side2, b in above:
                if side2 != 'lo' or z2 != z:
                    continue
                if sorted((round(a['xp'][0], 6), round(a['xq'][0], 6))) != sorted((round(b['xp'][0], 6), round(b['xq'][0], 6))):
                    continue
                if abs(a['ys'][-1] - b['ys'][-1]) < 1e-9:
                    continue  # a chamfered band meets the band below at the same face: no step there
                big, small, up = (a, b, 1) if a['ys'][-1] > b['ys'][-1] else (b, a, -1)
                # The two bands run the cut segment opposite ways: match the ends by x.
                if abs(big['xp'][0] - small['xp'][0]) > 1e-6:
                    small = {'xp': small['xq'], 'xq': small['xp'], 'ys': small['ys']}
                st, s0 = self.steps, small['ys'][0]
                for sign in (1, -1):
                    chain_big = [(big['xp'][0], sign * s0)]
                    chain_big += [(big['xp'][t], sign * big['ys'][t]) for t in range(st + 1)]
                    chain_big += [(big['xq'][t], sign * big['ys'][t]) for t in range(st, -1, -1)]
                    chain_big += [(big['xq'][0], sign * s0)]
                    chain_small = [(small['xp'][t], sign * small['ys'][t]) for t in range(1, st + 1)]
                    chain_small += [(small['xq'][t], sign * small['ys'][t]) for t in range(st, 0, -1)]
                    ring = chain_big + chain_small[::-1]
                    mesh.face([(x, y, z) for x, y in ring], (0, 0, up))

    def plinth_mesh(self, mesh, holes):
        hx, hy, ph, pr = self.plinth
        n = self.steps
        arc = 8

        def ring(e, z):
            rad = pr - e
            pts = []
            for cx, cy, a0 in ((hx - pr, hy - pr, 0.0), (-(hx - pr), hy - pr, 90.0), (-(hx - pr), -(hy - pr), 180.0),
                               (hx - pr, -(hy - pr), 270.0)):
                for s in range(arc + 1):
                    a = math.radians(a0 + 90.0 * s / arc)
                    pts.append((cx + rad * math.cos(a), cy + rad * math.sin(a), z))
            return pts

        rings = []
        for t in range(n + 1):
            b = (math.pi / 2.0) * t / n
            rings.append(ring(pr - pr * math.sin(b), pr - pr * math.cos(b)))
        for t in range(n + 1):
            b = (math.pi / 2.0) * t / n
            rings.append(ring(pr - pr * math.cos(b), ph - pr + pr * math.sin(b)))
        for r0, r1 in zip(rings, rings[1:]):
            m = len(r0)
            for i in range(m):
                mesh.quad(r0[i], r0[(i + 1) % m], r1[(i + 1) % m], r1[i])
        bottom = [p for i, p in enumerate(rings[0]) if i % (arc + 1) == 0]
        mesh.face(bottom, (0, 0, -1))
        top = [(p[0], p[1]) for i, p in enumerate(rings[-1]) if i % (arc + 1) == 0]
        hole_rings = [h if area(h) < 0 else h[::-1] for h in holes]
        poly = bridge_holes(top if area(top) > 0 else top[::-1], hole_rings)
        for t in ear_clip(poly):
            a, b, c = (poly[k] for k in t)
            mesh.tri((a[0], a[1], ph), (b[0], b[1], ph), (c[0], c[1], ph))

    def build(self, bands, with_plinth, caps):
        mesh = Mesh()
        secs = {}
        for k in bands:
            secs[k] = self.slab(mesh, k, caps)
        for k in bands:
            if k + 1 in secs:
                self.steps_between(mesh, secs[k], secs[k + 1])
        if with_plinth:
            holes = [sec['ring'] for z, side, sec in secs[0] if side == 'lo']
            self.plinth_mesh(mesh, holes)
        return mesh.verts, mesh.tris


def write_stl(path, verts, tris):
    with open(path, 'wb') as fh:
        fh.write(b'SlicerX X mark showcase model, Apache-2.0'.ljust(80, b' '))
        fh.write(struct.pack('<I', len(tris)))
        for t in tris:
            a, b, c = (verts[i] for i in t)
            fh.write(struct.pack('<12fH', *normal(a, b, c), *a, *b, *c, 0))


# The two filaments of the 3MF: the X mark's teal and an off-white, both Generic PLA. Only filament keys go in the
# project settings, so opening the file never asks about a project's printer, process or G-code.
FILAMENTS = (('#26A69A', 'PLA', 'Generic PLA @System'), ('#F2EFE6', 'PLA', 'Generic PLA @System'))


def project_settings(filaments):
    """Metadata/project_settings.config with the filament colour, type and preset of each slot, nothing else."""
    keys = {'filament_colour': [f[0] for f in filaments], 'filament_type': [f[1] for f in filaments],
            'filament_settings_id': [f[2] for f in filaments]}
    return json.dumps(keys, indent=4) + '\n'


def write_3mf_parts(path, name, parts):
    """One object made of parts (name, verts, tris, slot), as Bambu Studio and OrcaSlicer save a multi-part object:
    each part a mesh object, joined by components, its filament in Metadata/model_settings.config. Slicers keep the
    parts where they are, so the bands stay stacked. The filaments' colours are in Metadata/project_settings.config."""
    objs = []
    for oid, (pname, verts, tris, _) in enumerate(parts, start=1):
        vs = ''.join('<vertex x="%.4f" y="%.4f" z="%.4f"/>' % p for p in verts)
        ts = ''.join('<triangle v1="%d" v2="%d" v3="%d"/>' % t for t in tris)
        objs.append('<object id="%d" name="%s" type="model"><mesh><vertices>%s</vertices>'
                    '<triangles>%s</triangles></mesh></object>' % (oid, pname, vs, ts))
    top = len(parts) + 1
    comps = ''.join('<component objectid="%d"/>' % oid for oid in range(1, top))
    objs.append('<object id="%d" name="%s" type="model"><components>%s</components></object>' % (top, name, comps))
    model = ('<?xml version="1.0" encoding="UTF-8"?>\n'
             '<model unit="millimeter" xml:lang="en-US" '
             'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
             '<resources>%s</resources><build><item objectid="%d"/></build></model>\n' % (''.join(objs), top))
    part_cfg = ''.join(
        '<part id="%d" subtype="normal_part"><metadata key="name" value="%s"/><metadata key="extruder" value="%d"/></part>'
        % (oid, p[0], p[3]) for oid, p in enumerate(parts, start=1))
    settings = ('<?xml version="1.0" encoding="UTF-8"?>\n<config><object id="%d"><metadata key="name" value="%s"/>'
                '<metadata key="extruder" value="%d"/>%s</object></config>\n' % (top, name, parts[0][3], part_cfg))
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
        for fname, text in (('[Content_Types].xml', content_types), ('_rels/.rels', rels),
                            ('3D/3dmodel.model', model), ('Metadata/model_settings.config', settings),
                            ('Metadata/project_settings.config', project_settings(FILAMENTS))):
            info = zipfile.ZipInfo(fname, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, text)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--out', default='x-mark-showcase.stl', help='single-color STL path')
    ap.add_argument('--out-2color', default='x-mark-showcase-2color.3mf', help='two-color 3MF path ("" to skip)')
    ap.add_argument('--steps', type=int, default=10, help='facets per rounded edge')
    ap.add_argument('--check', metavar='STL', help='only report on an existing binary STL')
    a = ap.parse_args()
    if a.check:
        print(check(*read_stl(a.check)))
        return 0
    x = Showcase(steps=a.steps)
    verts, tris = x.build(range(BANDS), True, {})
    write_stl(a.out, verts, tris)
    print(a.out, check(verts, tris))
    if a.out_2color:
        objects = []
        for name, bands, plinth, slot in (('X mark bands A', [0, 2, 4, 6], True, 1), ('X mark bands B', [1, 3, 5, 7], False, 2)):
            caps = {}
            for k in bands:
                caps[(k, 'hi')] = k != BANDS - 1
                caps[(k, 'lo')] = k != 0
            pv, pt = x.build(bands, plinth, caps)
            print(name, check(pv, pt))
            objects.append((name, pv, pt, slot))
        write_3mf_parts(a.out_2color, 'X mark', objects)
        print(a.out_2color, 'written')
    return 0


if __name__ == '__main__':
    sys.exit(main())
