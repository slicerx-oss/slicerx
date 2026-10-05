#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Print time estimate: SlicerX against OrcaSlicer on the same model, limits and accelerations.

    python3 time_parity.py --sx path/to/sx --orca path/to/OrcaSlicer [--models cube,gear,x-reference]

Both slicers get the machine limits and per-feature accelerations of firmware_parity.py; the
estimated printing time in each G-code footer is compared. Exit code 1 when any model is more
than --tol (default 0.12) apart. Standard library only.
"""
import argparse
import json
import os
import re
import subprocess
import sys

import firmware_parity as fp
import models as model_lib
import settings


def minutes(text):
    m = re.search(r"estimated printing time \(normal mode\) = (.*)", text)
    if not m:
        return None
    t = 0
    for n, u in re.findall(r"(\d+)([dhms])", m.group(1)):
        t += int(n) * {"d": 86400, "h": 3600, "m": 60, "s": 1}[u]
    return t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sx", required=True)
    ap.add_argument("--orca", required=True)
    ap.add_argument("--models", default="cube,gear,x-reference")
    ap.add_argument("--workdir", default="time-work")
    ap.add_argument("--tol", type=float, default=0.12)
    a = ap.parse_args()
    work = os.path.abspath(a.workdir)
    os.makedirs(work, exist_ok=True)
    accel = {"outer_wall_acceleration": 5000, "inner_wall_acceleration": 8000, "top_surface_acceleration": 3000,
             "sparse_infill_acceleration": 10000, "internal_solid_infill_acceleration": 8000,
             "initial_layer_acceleration": 1000, "travel_acceleration": 10000, "default_acceleration": 10000}
    bad = 0
    for name in a.models.split(","):
        proc = {**accel, "brim_type": "no_brim", "slow_down_for_layer_cooling": 0}
        og = fp.orca_slice(a.orca, work, "marlin2", proc, {**LIMITS_ORCA(), "machine_limits_usage": "emit_to_gcode"}, name, 1)
        cfg = settings.sx_config()
        cfg.update({"brim_width": 0, "slow_down_for_layer_cooling": False, "machine_limits_usage": "emit_to_gcode",
                    **{k: v.split(",") for k, v in fp.LIMITS.items()}, **accel})
        sg = fp.sx_slice(a.sx, work, "marlin2", cfg, [(128, 128)], ["obj"], name) if False else one_object(a.sx, work, cfg, name)
        to, ts = minutes(og), minutes(sg)
        ratio = ts / to if to and ts else None
        ok = ratio is not None and abs(ratio - 1) <= a.tol
        bad += not ok
        print(("ok   " if ok else "FAIL ") + f"{name}: orca {to} s, sx {ts} s, ratio {ratio and round(ratio, 3)}")
    return 1 if bad else 0


def LIMITS_ORCA():
    return dict(fp.LIMITS)


def one_object(sx, work, cfg, name):
    d = os.path.join(work, f"sx-{name}")
    os.makedirs(d, exist_ok=True)
    stl = os.path.join(d, "m.stl")
    model_lib.write_stl(stl, model_lib.MODELS[name]())
    cfgp = os.path.join(d, "cfg.json")
    json.dump(cfg, open(cfgp, "w"))
    out = os.path.join(d, "out.gcode")
    r = subprocess.run([sx, "slice", stl, "--config", cfgp, "-o", out], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-300:])
    return open(out, errors="replace").read()


if __name__ == "__main__":
    sys.exit(main())
