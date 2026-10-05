#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Arc fitting: SlicerX against OrcaSlicer on curved models.

    python3 arc_parity.py --sx path/to/sx --orca path/to/OrcaSlicer [--models gear,flare]

Both slice with arc fitting on. Compared: the share of the extruded length written as G2 and G3, the
size of the file against the same model without arcs, and total filament. Passes when the arc share
is within 25 points of Orca's (filament totals differ by unrelated features and are only printed). Standard library only.
"""
import argparse
import math
import os
import re
import sys

import firmware_parity as fp
import settings
import time_parity as tp


def stats(g):
    """Arc moves, extruding moves, share of the extruded length written as arcs, filament used."""
    x = y = 0.0
    arc_len = line_len = 0.0
    arcs = lines = 0
    for l in g.splitlines():
        m = re.match(r"G([0123]) ", l)
        if not m:
            continue
        mx, my = re.search(r" X([-\d.]+)", l), re.search(r" Y([-\d.]+)", l)
        nx, ny = float(mx.group(1)) if mx else x, float(my.group(1)) if my else y
        d = math.hypot(nx - x, ny - y)
        if m.group(1) in "23":
            arcs += 1
            arc_len += d
        elif m.group(1) == "1" and " E" in l and not l.startswith("G1 E"):
            lines += 1
            line_len += d
        x, y = nx, ny
    f = re.search(r"filament used \[mm\] = ([\d.]+)", g)
    return arcs, lines, arc_len / max(arc_len + line_len, 1e-9) * 100, float(f.group(1)) if f else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sx", required=True)
    ap.add_argument("--orca", required=True)
    ap.add_argument("--models", default="gear,flare")
    ap.add_argument("--workdir", default="arc-work")
    a = ap.parse_args()
    work = os.path.abspath(a.workdir)
    bad = 0
    for name in a.models.split(","):
        og = fp.orca_slice(a.orca, work, "marlin2", {"enable_arc_fitting": 1, "brim_type": "no_brim"}, {}, name, 1)
        cfg = settings.sx_config()
        cfg.update({"brim_width": 0, "enable_arc_fitting": True})
        sg = tp.one_object(a.sx, work, cfg, name)
        (oa, ol, so, of), (sa, sl, ss, sf) = stats(og), stats(sg)
        ok = abs(so - ss) <= 25
        bad += not ok
        print(("ok   " if ok else "FAIL ") + f"{name}: share of extruded length as arcs orca {so:.0f}% sx {ss:.0f}% ({oa} and {sa} arcs), filament orca {of} sx {sf}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
