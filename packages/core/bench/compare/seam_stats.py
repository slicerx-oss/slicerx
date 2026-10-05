#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Compares where two G-code files start their outer wall loops, layer by layer.

usage: seam_stats.py sx.gcode orca.gcode [line_width_mm]

A loop's seam is its first extruded point (the travel's end). Loops are matched across the files by the
nearest loop center on the same layer. Prints the share of loops whose seams lie within one line width,
within 1 mm, the median distance, and the drift (distance between the seams of consecutive layers) of
each file, which shows how aligned the seams are.
"""
import math
import re
import statistics
import sys
from gcode import is_layer_mark, plain


def loops(path):
    """layer index -> list of (seam point, center)."""
    layer = -1
    role = None
    x = y = 0.0
    cur = None
    out = {}
    with open(path, errors="replace") as f:
        for ln in map(plain, f):
            if is_layer_mark(ln):
                layer += 1
                cur = None
                continue
            if ln.startswith(";TYPE:"):
                role = ln[6:].strip()
                cur = None
                continue
            if ln[0] == ";":
                continue
            words = ln.split(";", 1)[0].split()
            if not words or words[0] not in ("G0", "G1", "G2", "G3"):
                continue
            d = {w[0]: w[1:] for w in words[1:] if len(w) > 1}
            try:
                nx = float(d["X"]) if "X" in d else x
                ny = float(d["Y"]) if "Y" in d else y
                e = float(d["E"]) if "E" in d else 0.0
            except ValueError:
                continue
            extruding = e > 0 and ("X" in d or "Y" in d)
            if role in ("Outer wall", "Overhang wall") and extruding:
                if cur is None:
                    cur = {"seam": (x, y), "pts": [(x, y)]}
                    out.setdefault(layer, []).append(cur)
                cur["pts"].append((nx, ny))
            elif cur is not None and not extruding and ("X" in d or "Y" in d):
                cur = None
            x, y = nx, ny
    res = {}
    for k, v in out.items():
        items = []
        for c in v:
            pts = c["pts"]
            # a closed loop only: an open stretch is not a seam
            if math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1]) > 0.5 or len(pts) < 4:
                continue
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            items.append((c["seam"], (cx, cy)))
        res[k] = items
    return res


def drift(ls):
    out = []
    for k in sorted(ls):
        nxt = ls.get(k + 1)
        if not nxt:
            continue
        for s, c in ls[k]:
            best = min(nxt, key=lambda o: math.hypot(o[1][0] - c[0], o[1][1] - c[1]))
            if math.hypot(best[1][0] - c[0], best[1][1] - c[1]) < 2.0:
                out.append(math.hypot(best[0][0] - s[0], best[0][1] - s[1]))
    return out


def main():
    a, b = loops(sys.argv[1]), loops(sys.argv[2])
    width = float(sys.argv[3]) if len(sys.argv) > 3 else 0.42
    dist = []
    for k in sorted(set(a) & set(b)):
        for s, c in b[k]:
            if not a[k]:
                continue
            m = min(a[k], key=lambda o: math.hypot(o[1][0] - c[0], o[1][1] - c[1]))
            dist.append(math.hypot(m[0][0] - s[0], m[0][1] - s[1]))
    if not dist:
        print("no loops matched")
        return
    da, db = drift(a), drift(b)
    med = lambda v: round(statistics.median(v), 2) if v else None
    print(
        f"loops {len(dist)}  within a line {sum(1 for v in dist if v <= width) / len(dist):.2f}  "
        f"within 1 mm {sum(1 for v in dist if v <= 1.0) / len(dist):.2f}  median dist {med(dist)} mm  "
        f"drift sx {med(da)} orca {med(db)} (mean sx {round(statistics.mean(da), 2) if da else None} orca {round(statistics.mean(db), 2) if db else None})"
    )


main()
