#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""First layer footprint: SlicerX against OrcaSlicer, side by side, on the first two layers.

    python3 footprint_parity.py --sx path/to/sx --orca path/to/OrcaSlicer
    python3 footprint_parity.py --models x-reference --set elefant_foot_compensation=0.3 --set elefant_foot_compensation_layers=3

Each model is sliced by both slicers with the matched settings of parity.py (Orca's resolved reference plus the
`--set` overrides; elephant foot compensation 0.2 mm by default) and left where the model file puts it, on the
bed center. From each G-code the outer wall loops of layers 1 and 2 (overhang walls included) are read and,
for each side of the part (left, right, bottom, top: the points within 2 mm of that side of the layer's box),
measured against the other slicer's: the mean signed distance, positive where SlicerX lies outside Orca's loop.
It also gives each slicer's own band between layers 1 and 2 per side, as an area: where layer 2 reaches past
layer 1 is what prints over air on layer 2. Exit code 1 when a side's mean distance is more than `--tol` mm.
Standard library only.
"""
import argparse
import json
import math
import os
import subprocess
import sys

import models as model_lib
import orca_base
import parity
import slicers
from gcode import plain

STEP = 0.25
EDGE = 2.0
SIDES = ("left", "right", "bottom", "top")


def outer_loops(path, layers=(1, 2)):
    """The outer wall loops (overhang walls included) of the given layers, 1-based, as point lists."""
    out = {n: [] for n in layers}
    feat, x, y, layer, cur = None, 0.0, 0.0, 0, None
    for line in open(path, errors="replace"):
        line = plain(line.rstrip("\n"))
        if line.startswith(";TYPE:"):
            feat, cur = line[6:].strip(), None
            continue
        if line.startswith(";LAYER_CHANGE"):
            layer, cur = layer + 1, None
            continue
        if not line.startswith(("G0", "G1")):
            continue
        v = {}
        for w in line.split(";")[0].split()[1:]:
            try:
                v[w[0]] = float(w[1:])
            except ValueError:
                pass
        nx, ny = v.get("X", x), v.get("Y", y)
        moves = "X" in v or "Y" in v
        if layer in out and feat in ("Outer wall", "Overhang wall") and v.get("E", 0) > 0 and moves:
            if cur is None:
                cur = [(x, y)]
                out[layer].append(cur)
            cur.append((nx, ny))
        elif moves:
            cur = None
        x, y = nx, ny
    return out


def _dist(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    n = dx * dx + dy * dy
    t = 0.0 if n == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / n))
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)


def _inside(p, loops):
    c = False
    for poly in loops:
        for (x1, y1), (x2, y2) in zip(poly, poly[1:]):
            if (y1 > p[1]) != (y2 > p[1]) and p[0] < x1 + (p[1] - y1) * (x2 - x1) / (y2 - y1):
                c = not c
    return c


def _points(loops):
    for poly in loops:
        for a, b in zip(poly, poly[1:]):
            n = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) / STEP))
            for i in range(n):
                yield (a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n)


def _box(loops):
    xs = [p[0] for poly in loops for p in poly]
    ys = [p[1] for poly in loops for p in poly]
    return min(xs), min(ys), max(xs), max(ys)


def by_side(a, b):
    """Signed distance of loops `a` from loops `b` at a's points near each side of a's box (+ outside b): per side
    the mean, the area of the band (distance times length) and the number of points."""
    x0, y0, x1, y1 = _box(a)
    segs = [(p, q) for poly in b for p, q in zip(poly, poly[1:])]
    acc = {}
    for p in _points(a):
        gaps = {"left": p[0] - x0, "right": x1 - p[0], "bottom": p[1] - y0, "top": y1 - p[1]}
        side = min(gaps, key=gaps.get)
        if gaps[side] > EDGE:
            continue
        d = min(_dist(p, q, r) for q, r in segs)
        acc.setdefault(side, []).append(-d if _inside(p, b) else d)
    return {s: {"mean": sum(v) / len(v), "area": sum(max(0.0, d) for d in v) * STEP, "points": len(v)} for s, v in acc.items()}


def run(model, overrides, sx_path, orca_path, work):
    d = os.path.join(work, model)
    os.makedirs(os.path.join(d, "models"), exist_ok=True)
    stl = os.path.join(d, "models", f"{model}.stl")
    model_lib.write_stl(stl, model_lib.MODELS[model]())
    cfg = orca_base.sx_base()
    cfg.update(parity.ORCA_ONLY)
    cfg.update(overrides)
    cfg_path = os.path.join(d, "sx.json")
    json.dump(cfg, open(cfg_path, "w"))
    sx_gcode = os.path.join(d, "sx.gcode")
    subprocess.run([sx_path, "slice", stl, "--config", cfg_path, "-o", sx_gcode], capture_output=True, check=True)
    orca = parity.ParityOrca(orca_path, {**parity.ORCA_ONLY, **overrides})
    orca.prepare(d, {"cube": stl})
    job = orca.job(model, d)
    subprocess.run(job.cmd, capture_output=True, text=True)
    if not os.path.exists(job.gcode):
        raise RuntimeError(f"{model}: Orca wrote no G-code")
    return outer_loops(sx_gcode), outer_loops(job.gcode)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sx")
    ap.add_argument("--orca")
    ap.add_argument("--models", default="x-reference,cube,leaning-slabs,first-layer-test")
    ap.add_argument("--set", action="append", default=[], help="key=value, Orca key names")
    ap.add_argument("--tol", type=float, default=0.02)
    ap.add_argument("--workdir", default="footprint-work")
    a = ap.parse_args()
    sx, orca = slicers.SlicerX(a.sx), slicers.Orca(a.orca)
    if not sx.available() or not orca.available():
        print("need both sx and OrcaSlicer (--sx, --orca)", file=sys.stderr)
        return 2
    overrides = {"elefant_foot_compensation": 0.2}
    for kv in a.set:
        k, _, v = kv.partition("=")
        overrides[k] = v
    ok = True
    for model in a.models.split(","):
        s, o = run(model, overrides, sx.path, orca.path, os.path.abspath(a.workdir))
        print(f"{model} {json.dumps(overrides)}")
        for n in (1, 2):
            if not s[n] or not o[n]:
                print(f"  layer {n}: outer wall loops sx {len(s[n])} orca {len(o[n])}")
                continue
            m = by_side(s[n], o[n])
            row = []
            for side in SIDES:
                if side in m:
                    bad = abs(m[side]["mean"]) > a.tol
                    ok &= not bad
                    row.append(f"{side} {m[side]['mean']:+.3f}{' <--' if bad else ''}")
            print(f"  layer {n}, sx from orca (mm): " + "  ".join(row))
        if s[1] and s[2] and o[1] and o[2]:
            for who, loops in (("sx", s), ("orca", o)):
                band = by_side(loops[2], loops[1])
                print(f"  {who:4} layer 2 past layer 1: " + "  ".join(
                    f"{side} {band[side]['mean']:+.3f} mm, {band[side]['area']:.2f} mm2" for side in SIDES if side in band))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
