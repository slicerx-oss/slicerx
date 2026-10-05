#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Parity check for painted seams: a box with `paint_seam` on one face, sliced by SlicerX and OrcaSlicer;
compares where the outer wall loops start (median over the layers) for each seam position.

    python3 probe_seam.py --sx path/to/sx --orca path/to/OrcaSlicer --workdir seam-work
"""
import argparse
import json
import os
import statistics
import subprocess
import sys

import models as model_lib
import paint3mf
import parity
import settings
import slicers
from gcode import plain


def wall_starts(gcode):
    """XY before the first extrusion of each outer wall block."""
    pos, kind, pending, out = None, "", False, []
    for ln in map(plain, open(gcode, errors="replace")):
        if ln.startswith(";TYPE:"):
            kind, pending = ln[6:].strip(), True
            continue
        w = ln.split(";", 1)[0].split()
        if not w or w[0] not in ("G0", "G1"):
            continue
        f = {t[0]: t[1:] for t in w[1:] if len(t) > 1}
        if kind == "Outer wall" and pending and w[0] == "G1" and "E" in f and "X" in f and pos:
            out.append(pos)
            pending = False
        if "X" in f and "Y" in f:
            pos = (float(f["X"]), float(f["Y"]))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sx")
    ap.add_argument("--orca")
    ap.add_argument("--workdir", default="seam-work")
    a = ap.parse_args()
    d = os.path.abspath(a.workdir)
    os.makedirs(os.path.join(d, "models"), exist_ok=True)
    sx = slicers.SlicerX(a.sx).path
    cases = [(m, face, st) for m in ("aligned", "back", "nearest") for face, st in (("front", 1), ("left", 1), ("back", 2))]
    ok = True
    for mode, face, state in cases:
        name = f"{mode}-{face}-{state}"
        m3 = os.path.join(d, "models", name + ".3mf")
        paint3mf.write_painted(m3, 128.0, 128.0, (40, 20, 10), {}, seam={face: state})
        cfg = settings.sx_config()
        cfg.update({"seam_position": mode, "slow_down_for_layer_cooling": False})
        req = {"schemaVersion": 1, "meshes": {"b": m3}, "plate": {"objects": [{"id": "o", "mesh": "b"}]},
               "config": cfg, "options": {"flavor": "marlin2"}}
        rp = os.path.join(d, name + ".json")
        json.dump(req, open(rp, "w"))
        out = os.path.join(d, "sx-" + name)
        subprocess.run([sx, "slice", "--request", rp, "--out-dir", out], capture_output=True, check=True)
        extra = dict(parity.ORCA_ONLY)
        extra["seam_position"] = mode
        orca = parity.ParityOrca(slicers.Orca(a.orca).path, extra)
        bp = os.path.join(d, "models", "body.stl")
        model_lib.write_stl(bp, model_lib._box(-20, 20, -10, 10, 0, 10))
        orca.prepare(d, {"cube": bp})
        od = os.path.join(d, "orca-" + name)
        os.makedirs(od, exist_ok=True)
        for f in os.listdir(od):
            os.remove(os.path.join(od, f))
        r = subprocess.run(orca._cmd(m3, od, ["--debug", "1", "--arrange", "0"]), capture_output=True, text=True)
        og = os.path.join(od, "plate_1.gcode")
        if not os.path.exists(og):
            print(name, "Orca produced no G-code:", (r.stdout + r.stderr)[-300:])
            ok = False
            continue
        res = []
        for g in (os.path.join(out, "slice.gcode"), og):
            s = wall_starts(g)
            res.append((statistics.median(p[0] for p in s) - 128, statistics.median(p[1] for p in s) - 128) if s else None)
        good = res[0] and res[1] and abs(res[0][0] - res[1][0]) < 3 and abs(res[0][1] - res[1][1]) < 3
        ok &= bool(good)
        print(f"{'ok  ' if good else 'FAIL'} {name:<22} sx {res[0]}  orca {res[1]}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
