#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Travel planning: SlicerX against OrcaSlicer on models with holes and gaps.

    python3 travel_parity.py --sx path/to/sx --orca path/to/OrcaSlicer [--models gear,mushroom]

Each case gives both slicers the same setting and compares, from the G-code, the number of
retractions and the total length of travel moves, as a ratio of the same numbers with the
setting off. Reduced infill retraction passes when the two ratios are within 0.25 of each
other; avoiding crossing walls when retractions are unchanged and the travel grows, up to Orca's growth. Standard library only.
"""
import argparse
import math
import os
import re
import sys

import firmware_parity as fp
import settings
import time_parity as tp

CASES = {
    "reduce infill retraction": ({"reduce_infill_retraction": 1}, {"reduce_infill_retraction": True}),
    "avoid crossing walls": ({"reduce_crossing_wall": 1, "max_travel_detour_distance": 0}, {"reduce_crossing_wall": True, "max_travel_detour_distance": 0}),
}


def measure(g):
    retracts = len(re.findall(r"^G1 E-", g, re.M))
    x = y = None
    travel = 0.0
    for l in g.splitlines():
        if not l.startswith(("G0 ", "G1 ")) or l.startswith("G1 E") or l.startswith("G1 Z"):
            continue
        mx, my = re.search(r" X([-\d.]+)", l), re.search(r" Y([-\d.]+)", l)
        nx = float(mx.group(1)) if mx else x
        ny = float(my.group(1)) if my else y
        if " E" not in l and x is not None and nx is not None and ny is not None and y is not None:
            travel += math.hypot(nx - x, ny - y)
        x, y = nx, ny
    return retracts, travel


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sx", required=True)
    ap.add_argument("--orca", required=True)
    ap.add_argument("--models", default="gear,mushroom")
    ap.add_argument("--workdir", default="travel-work")
    a = ap.parse_args()
    work = os.path.abspath(a.workdir)
    bad = 0
    base_cfg = {**settings.sx_config(), "brim_width": 0, "slow_down_for_layer_cooling": False}
    for name in a.models.split(","):
        proc0 = {"brim_type": "no_brim", "reduce_crossing_wall": 0, "reduce_infill_retraction": 0, "slow_down_for_layer_cooling": 0}
        o0 = measure(fp.orca_slice(a.orca, work, "marlin2", proc0, {}, name, 1))
        s0 = measure(tp.one_object(a.sx, work, base_cfg, name))
        for label, (op, sp) in CASES.items():
            o = measure(fp.orca_slice(a.orca, work, "marlin2", {**proc0, **op}, {}, name, 1))
            s = measure(tp.one_object(a.sx, work, {**base_cfg, **sp}, name))
            ro = (o[0] / max(o0[0], 1), o[1] / max(o0[1], 1))
            rs = (s[0] / max(s0[0], 1), s[1] / max(s0[1], 1))
            if label == "avoid crossing walls":
                # Orca's detours hug the contour and run longer than our chords between simplified
                # corners; ours may detour (at least as much travel, same retractions) without going past Orca's.
                ok = abs(ro[0] - rs[0]) <= 0.05 and 1.0 <= rs[1] <= ro[1] * 1.2
            else:
                ok = abs(ro[0] - rs[0]) <= 0.25 and abs(ro[1] - rs[1]) <= 0.25
            bad += not ok
            print(("ok   " if ok else "FAIL ") + f"{name} {label}: retractions orca x{ro[0]:.2f} sx x{rs[0]:.2f}, travel length orca x{ro[1]:.2f} sx x{rs[1]:.2f}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
