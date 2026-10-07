#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""The skirt against OrcaSlicer: what it goes round on the first layer.

    python3 skirt_parity.py --sx path/to/sx --orca path/to/OrcaSlicer [--workdir skirt-work]

Two plates, each sliced by both: two boxes on two filaments with a prime tower (probe_color.py), and the knot with
support. On each first layer the skirt must enclose every support and prime tower extrusion, and its gap to the
nearest other extrusion (what it goes round) is compared. Positions differ between the slicers on the knot plate
(Orca arranges it), so only these relative numbers are compared. Standard library only.
"""
import argparse
import json
import math
import os
import subprocess
import sys

import firmware_parity as fp
import profile_parity

HERE = os.path.dirname(os.path.abspath(__file__))


def first_layer(path):
    """The first layer's extruding segments by feature, as ((x0, y0), (x1, y1)) in mm."""
    feats, feat, at, layer = {}, "", None, 0
    with open(path, errors="replace") as f:
        for ln in f:
            if ln.startswith(";LAYER_CHANGE") or ln.startswith("; CHANGE_LAYER"):
                layer += 1
                if layer > 1:
                    break
            if ln.startswith(";TYPE:") or ln.startswith("; FEATURE:"):
                feat = ln.split(":", 1)[1].strip().lower()
                continue
            w = ln.split(";", 1)[0].split()
            if not w or w[0] not in ("G0", "G1", "G2", "G3"):
                continue
            v = {t[0]: t[1:] for t in w[1:] if len(t) > 1}
            try:
                nxt = (float(v.get("X", at[0] if at else 0)), float(v.get("Y", at[1] if at else 0)))
                e = float(v.get("E", 0))
            except ValueError:
                continue
            if at and e > 0 and w[0] != "G0":
                feats.setdefault(feat, []).append((at, nxt))
            at = nxt
    return feats


def hull(points):
    pts = sorted(set(points))
    if len(pts) < 3:
        return pts
    cross = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, hi = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(hi) >= 2 and cross(hi[-2], hi[-1], p) <= 0:
            hi.pop()
        hi.append(p)
    return lo[:-1] + hi[:-1]


def inside(poly, p, tol=0.05):
    n = len(poly)
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        if (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) < -tol * math.hypot(b[0] - a[0], b[1] - a[1]):
            return False
    return True


def seg_dist(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)


def measure(path):
    feats = first_layer(path)
    skirt = [s for k, v in feats.items() if "skirt" in k for s in v]
    # what the skirt goes round: the print itself, not the start G-code's purge line
    rest = {k: v for k, v in feats.items() if "skirt" not in k and k not in ("", "custom")}
    if not skirt:
        return None
    ring = hull([p for s in skirt for p in s])
    out = {"loops_mm": round(sum(math.dist(a, b) for a, b in skirt), 1)}
    for name, keys in (("support", ("support",)), ("tower", ("tower", "wipe"))):
        pts = [p for k, v in rest.items() if any(t in k for t in keys) for s in v for p in s]
        out[name] = None if not pts else all(inside(ring, p) for p in pts)
    # how far the skirt stands past what it goes round, on each side of their boxes (left, front, right, back)
    box = lambda ps: (min(p[0] for p in ps), min(p[1] for p in ps), max(p[0] for p in ps), max(p[1] for p in ps))
    pts = [p for v in rest.values() for s in v for p in s]
    if pts:
        sb, ob = box([p for s in skirt for p in s]), box(pts)
        out["margins_mm"] = [round(ob[0] - sb[0], 2), round(ob[1] - sb[1], 2), round(sb[2] - ob[2], 2), round(sb[3] - ob[3], 2)]
    return out


def run(args):
    return subprocess.run(args, capture_output=True, text=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sx", required=True)
    ap.add_argument("--orca", required=True)
    ap.add_argument("--workdir", default="skirt-work")
    a = ap.parse_args()
    work = os.path.abspath(a.workdir)
    os.makedirs(work, exist_ok=True)
    rows = []

    # Two boxes on two filaments: a prime tower beside them.
    tw = os.path.join(work, "tower")
    r = run([sys.executable, os.path.join(HERE, "probe_color.py"), "--orca", a.orca, "--sx", a.sx, "--workdir", tw,
             "--set", "skirt_loops=2", "--set", "skirt_distance=3", "--set", "enable_prime_tower=1",
             "--sxset", "skirt_loops=2", "--sxset", "skirt_distance=3"])
    rows.append(("two boxes, prime tower", os.path.join(tw, "orca", "plate_1.gcode"), os.path.join(tw, "sx", "slice.gcode"), r))

    # The knot with support.
    sp = os.path.join(work, "support")
    process = {"enable_support": 1, "support_type": "normal(auto)", "skirt_loops": 2, "skirt_distance": 3, "brim_type": "no_brim"}
    og = fp.orca_slice(a.orca, sp, "marlin2", process, {}, "knot", 1)
    opath = os.path.join(sp, "orca-knot.gcode")
    open(opath, "w").write(og)
    cfg = profile_parity.sx_config_from_block(profile_parity.config_block(opath))
    cfg.update({"enable_support": True, "skirt_loops": 2, "skirt_distance": 3, "brim_width": 0})
    sg = fp.sx_slice(a.sx, sp, "marlin2", cfg, [(128.0, 128.0)], ["knot"], model="knot")
    spath = os.path.join(sp, "sx-knot.gcode")
    open(spath, "w").write(sg)
    rows.append(("knot, support", opath, spath, None))

    ok = True
    for name, op, sxp, res in rows:
        if not (os.path.exists(op) and os.path.exists(sxp)):
            print(f"FAIL {name}: missing output {(res.stdout + res.stderr)[-400:] if res else ''}")
            ok = False
            continue
        o, s = measure(op), measure(sxp)
        print(f"{name}\n  orca {json.dumps(o)}\n  sx   {json.dumps(s)}")
        if not (o and s):
            ok = False
            continue
        for k in ("support", "tower"):
            if o[k] is not None or s[k] is not None:
                good = o[k] == s[k]
                ok &= good
                print(f"  {'ok  ' if good else 'FAIL'} encloses {k}: orca {o[k]} sx {s[k]}")
        good = "margins_mm" in o and "margins_mm" in s and all(abs(x - y) <= 0.5 for x, y in zip(o["margins_mm"], s["margins_mm"]))
        ok &= good
        print(f"  {'ok  ' if good else 'FAIL'} skirt past what it goes round (left, front, right, back): orca {o.get('margins_mm')} sx {s.get('margins_mm')} mm")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
