# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Prototype decoder of a Bambu or Orca `paint_color` text into painted sub-triangles, used to work out the
layout of split triangles against what OrcaSlicer prints (see probe_paintcode.py). 2D points are fine here."""

# Children of a split triangle, as lists of symbols over p0, p1, p2 (the triangle's vertices rotated so that
# p0 is the special one) and the side midpoints mA = mid(p0,p1), mB = mid(p2,p0), mC = mid(p1,p2), in the base
# counterclockwise order; ROT gives how far each child's own vertex list is rotated.
CHILDREN = {
    1: [("p0", "mC", "p2"), ("p0", "p1", "mC")],
    2: [("mB", "p1", "p2"), ("mA", "p1", "mB"), ("p0", "mA", "mB")],
    3: [("mA", "mC", "mB"), ("mB", "mC", "p2"), ("mA", "p1", "mC"), ("p0", "mA", "mB")],
}
ROT = {1: [1, 0], 2: [1, 0, 0], 3: [0, 1, 0, 0]}


def mid(a, b):
    return tuple((x + y) / 2 for x, y in zip(a, b))


def nibbles(text):
    # The text is the stream's nibbles in reverse order.
    return [int(c, 16) for c in reversed(text)]


def decode(text, tri, rot=None):
    """Returns [(vertices, state)] for a triangle `tri` (three points), state 0 meaning unpainted."""
    rot = rot or ROT
    stream = nibbles(text)
    pos = [0]

    def nxt():
        v = stream[pos[0]]
        pos[0] += 1
        return v

    out = []

    def node(v):
        code = nxt()
        splits = code & 3
        special = code >> 2
        if splits == 0:
            state = special
            if special == 3:
                state = nxt() + 3
            out.append((v, state))
            return
        s = special if splits != 3 or True else 0
        p = [v[(s + i) % 3] for i in range(3)]
        env = {"p0": p[0], "p1": p[1], "p2": p[2], "mA": mid(p[0], p[1]), "mB": mid(p[2], p[0]), "mC": mid(p[1], p[2])}
        for k, sym in enumerate(CHILDREN[splits]):
            verts = [env[x] for x in sym]
            r = rot[splits][k]
            verts = verts[r:] + verts[:r]
            node(verts)

    node(list(tri))
    return out


def inside(pt, tri):
    (x, y) = pt
    (ax, ay), (bx, by), (cx, cy) = tri
    d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by)
    d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy)
    d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay)
    neg = d1 < 0 or d2 < 0 or d3 < 0
    pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (neg and pos)


def state_at(subs, pt):
    for v, s in subs:
        if inside(pt, v):
            return s
    return None
