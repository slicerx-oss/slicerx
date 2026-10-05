#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Acceleration and jerk lines: SlicerX against OrcaSlicer on one model.

    python3 accel_parity.py --sx path/to/sx --orca path/to/OrcaSlicer [--models cube,gear]

Per-feature accelerations and jerks (all distinct) go to both slicers. The M204 and M205
lines each writes are counted by text and compared: a line passes when the counts are within
25 percent or 3 lines. Path order differs between the slicers, so counts, not order, are
compared. Standard library only.
"""
import argparse
import collections
import os
import re
import sys

import firmware_parity as fp
import settings
import time_parity as tp

PROCESS = {"outer_wall_acceleration": 3000, "inner_wall_acceleration": 4000, "top_surface_acceleration": 2000,
           "sparse_infill_acceleration": 6000, "internal_solid_infill_acceleration": 5500,
           "initial_layer_acceleration": 1000, "travel_acceleration": 8000, "default_acceleration": 5000,
           "outer_wall_jerk": 7, "inner_wall_jerk": 8, "top_surface_jerk": 6, "infill_jerk": 9,
           "default_jerk": 10, "initial_layer_jerk": 5}


def lines(g):
    return collections.Counter(re.split(r"\s*;", l)[0] for l in g.splitlines() if l.startswith(("M204 T", "M204 P", "M205 X")) and " R" not in l and "Z" not in l)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sx", required=True)
    ap.add_argument("--orca", required=True)
    ap.add_argument("--models", default="cube,gear")
    ap.add_argument("--workdir", default="accel-work")
    a = ap.parse_args()
    work = os.path.abspath(a.workdir)
    bad = 0
    for name in a.models.split(","):
        og = fp.orca_slice(a.orca, work, "marlin2", {**PROCESS, "brim_type": "no_brim", "slow_down_for_layer_cooling": 0}, {}, name, 1)
        cfg = settings.sx_config()
        cfg.update({"brim_width": 0, "slow_down_for_layer_cooling": False, **{k: v.split(",") for k, v in fp.LIMITS.items()}, **PROCESS})
        sg = tp.one_object(a.sx, work, cfg, name)
        co, cs = lines(og), lines(sg)
        print(f"== {name}")
        for k in sorted(set(co) | set(cs)):
            o, s = co.get(k, 0), cs.get(k, 0)
            ok = abs(o - s) <= max(3, 0.25 * o)
            bad += not ok
            print(("ok   " if ok else "FAIL ") + f"{k:<14} orca {o:>5} sx {s:>5}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
