#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Overhang speed: SlicerX against OrcaSlicer, feature by feature.

    python3 overhang_parity.py --sx path/to/sx --orca path/to/OrcaSlicer [--models flare,x-reference]
        [--set slowdown_for_curled_perimeters=1]

Both slicers get the matched settings plus Bambu-like overhang speeds. For the walls, overhang walls and
bridges the script reads every extruding move and reports, per feature, the extruded length, the time
at the written speeds (length over F) and the length printed at each speed band. Exit code 1 when the
wall time of a model is more than --tol (default 0.05) apart. Standard library only.
"""
import argparse
import os
import re
import sys

import firmware_parity as fp
import orca_base
import settings
import time_parity as tp
from gcode import plain

OVERHANG = {"enable_overhang_speed": 1, "overhang_1_4_speed": 0, "overhang_2_4_speed": 50,
            "overhang_3_4_speed": 30, "overhang_4_4_speed": 10, "bridge_speed": 50,
            "brim_type": "no_brim", "slow_down_for_layer_cooling": 0}
FEATURES = ("Outer wall", "Inner wall", "Overhang wall", "Bridge", "Internal Bridge")
BANDS = (0, 11, 21, 31, 51, 101, 201, 10000)


def read(g):
    """Per feature: [length mm, seconds, {band: length}]."""
    out = {f: [0.0, 0.0, {}] for f in FEATURES}
    feature, f_mm_s, x, y = None, 0.0, 0.0, 0.0
    num = re.compile(r"([XYZEF])(-?[\d.]+)")
    for line in map(plain, g.splitlines()):
        if line.startswith(";TYPE:"):
            feature = line[6:].strip()
            continue
        if not (line.startswith("G1") or line.startswith("G0")):
            continue
        vals = dict((k, float(v)) for k, v in num.findall(line.split(";")[0]))
        # The path's own feed: travels, retractions and lifts set F too, which the comparison leaves out.
        own = line.startswith("G1") and not ("Z" in vals or ("E" in vals and "X" not in vals and "Y" not in vals))
        if "F" in vals and own:
            f_mm_s = vals["F"] / 60.0
        nx, ny = vals.get("X", x), vals.get("Y", y)
        if feature in out and vals.get("E", 0) > 0 and ("X" in vals or "Y" in vals):
            d = ((nx - x) ** 2 + (ny - y) ** 2) ** 0.5
            rec = out[feature]
            rec[0] += d
            rec[1] += d / max(f_mm_s, 0.1)
            band = max(b for b in BANDS if b <= f_mm_s)
            rec[2][band] = rec[2].get(band, 0.0) + d
        x, y = nx, ny
    return out


def show(name, o, s):
    print(f"{name}")
    for f in FEATURES:
        a, b = o[f], s[f]
        if a[0] < 0.5 and b[0] < 0.5:
            continue
        print(f"  {f:16} length {a[0]:9.1f} vs {b[0]:9.1f} mm   time {a[1]:8.1f} vs {b[1]:8.1f} s")
        bands = sorted(set(a[2]) | set(b[2]))
        print("    " + "  ".join(f"F>={k}: {a[2].get(k, 0):.0f}/{b[2].get(k, 0):.0f}" for k in bands))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sx", required=True)
    ap.add_argument("--orca", required=True)
    ap.add_argument("--models", default="flare,x-reference,mushroom,toadstool")
    ap.add_argument("--workdir", default="overhang-work")
    ap.add_argument("--set", action="append", default=[], help="key=value for both slicers")
    ap.add_argument("--tol", type=float, default=0.05)
    a = ap.parse_args()
    work = os.path.abspath(a.workdir)
    os.makedirs(work, exist_ok=True)
    extra = dict(OVERHANG)
    for kv in a.set:
        k, v = kv.split("=", 1)
        extra[k] = v
    bad = 0
    for name in a.models.split(","):
        og = fp.orca_slice(a.orca, work, "marlin2", extra, {}, name, 1)
        # Every key stated, as Orca resolves it (precise_outer_wall and the like), then the matched values.
        cfg = orca_base.sx_base()
        cfg.update(settings.sx_config())
        cfg.update({"brim_width": 0, **extra})
        sg = tp.one_object(a.sx, work, cfg, name)
        o, s = read(og), read(sg)
        show(name, o, s)
        wall_o = sum(o[f][1] for f in FEATURES)
        wall_s = sum(s[f][1] for f in FEATURES)
        ratio = wall_s / wall_o if wall_o else None
        ok = ratio is not None and abs(ratio - 1) <= a.tol
        bad += not ok
        print(("ok   " if ok else "FAIL ") + f"{name}: wall and bridge time {wall_o:.0f} s vs {wall_s:.0f} s, ratio {ratio and round(ratio, 3)}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
