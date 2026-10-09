#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Custom G-code parity: the start, end and layer change G-code that the settings package
ships for its printers, rendered by SlicerX and by OrcaSlicer for the same print.

    python3 parity_gcode.py --sx <sx> --orca <OrcaSlicer> [--gcode-json ../../../profiles/gcode.json]

For each printer family the templates go into an Orca machine preset and into the sx config,
a small cube is sliced by both, and the G-code before the first layer and after the last one
is compared as commands: comments and the lines each slicer adds itself (M73, motion limits,
M83, G90 and the like) are dropped, numbers are read as numbers and compared with a tolerance.
Prints how many families produce the same commands and lists the first differences of the
others. Standard library only.
"""
import argparse
import json
import os
import re
import subprocess
import sys

import models as model_lib
import settings
import slicers
from gcode import is_layer_mark

# Lines a slicer writes around the profile's own G-code. Not compared.
OWN = re.compile(r"^(M73|M20[1345]|M83|M82|G90|G91|G21|M106 S0|M107|G92 E0|M140|M104|M190|M109|M141|M191)\b", re.I)


def commands(text):
    out = []
    for ln in text.splitlines():
        ln = ln.split(";", 1)[0].strip()
        if ln and not OWN.match(ln):
            out.append(ln)
    return out


def split(path):
    """Text before the first layer and after the last extrusion."""
    lines = open(path, errors="replace").read().splitlines()
    first = next((i for i, ln in enumerate(lines) if is_layer_mark(ln)), len(lines))
    head = lines[:first]
    # The body ends where the slicer's own end marker starts (its tail is the machine end G-code).
    last_move = max((i for i, ln in enumerate(lines) if re.match(r"G1 X[-\d.]+ Y[-\d.]+ E[-\d.]+", ln)), default=first)
    tail = [ln for ln in lines[last_move + 1:] if not ln.startswith("; ")]
    return "\n".join(head), "\n".join(tail)


def same(a, b):
    """Commands equal, numbers within a small tolerance."""
    if len(a) != len(b):
        return False
    for x, y in zip(a, b):
        tx, ty = re.split(r"(-?\d*\.?\d+)", x), re.split(r"(-?\d*\.?\d+)", y)
        if len(tx) != len(ty):
            return False
        for p, q in zip(tx, ty):
            if re.fullmatch(r"-?\d*\.?\d+", p or "") and re.fullmatch(r"-?\d*\.?\d+", q or ""):
                if abs(float(p) - float(q)) > 0.011 + 1e-3 * abs(float(q)):
                    return False
            elif p != q:
                return False
    return True


def diff(a, b, limit=4):
    out = []
    for i in range(max(len(a), len(b))):
        x = a[i] if i < len(a) else "(nothing)"
        y = b[i] if i < len(b) else "(nothing)"
        if not same([x], [y]):
            out.append(f"      line {i}: sx {x!r} | orca {y!r}")
            if len(out) >= limit:
                break
    return out


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("--sx")
    ap.add_argument("--orca")
    ap.add_argument("--gcode-json", default=os.path.join(here, "..", "..", "..", "profiles", "gcode.json"))
    ap.add_argument("--workdir", default="parity-gcode-work")
    ap.add_argument("--families", default="")
    a = ap.parse_args()
    sx, orca = slicers.SlicerX(a.sx), slicers.Orca(a.orca)
    if not (sx.available() and orca.available()):
        print("need sx and OrcaSlicer", file=sys.stderr)
        return 2
    doc = json.load(open(a.gcode_json))
    work = os.path.abspath(a.workdir)
    keys = {"start": "machine_start_gcode", "end": "machine_end_gcode", "beforeLayerChange": "before_layer_change_gcode",
            "layerChange": "layer_change_gcode", "changeFilament": "change_filament_gcode"}
    names = [n for n in (a.families.split(",") if a.families else doc["families"]) if n]
    passed = 0
    for fam in names:
        parts = doc["families"][fam]
        over = {keys[k]: v for k, v in parts.items() if k in keys and isinstance(v, str)}
        # Orca refuses relative extrusion without a G92 E0 in the layer change G-code; a few
        # printers reset E in firmware, so both slicers get the line (it is not compared).
        if "G92 E0" not in over.get("layer_change_gcode", ""):
            over["layer_change_gcode"] = over.get("layer_change_gcode", "") + "\nG92 E0"
        d = os.path.join(work, fam)
        os.makedirs(os.path.join(d, "models"), exist_ok=True)
        stl = os.path.join(d, "models", "cube.stl")
        model_lib.write_stl(stl, model_lib.MODELS["cube"]())
        cfg = settings.sx_config()
        cfg.update(over)
        # What the Orca filament preset carries and the profiles read.
        cfg.update({"filament_max_volumetric_speed": ["100"], "nozzle_temperature_range_high": ["240"], "nozzle_temperature_range_low": ["190"]})
        cfg["slow_down_for_layer_cooling"] = False
        cfg_path = os.path.join(d, "sx.json")
        json.dump(cfg, open(cfg_path, "w"))
        sx_gcode = os.path.join(d, "sx.gcode")
        r = slicers.slice_trusted(sx.path, stl, cfg, sx_gcode)
        if r.returncode != 0:
            print(f"SXERR {fam}: {r.stderr.strip()[-160:]}")
            continue
        o = slicers.Orca(a.orca)
        o.extra_machine = over
        prepare(o, d, {"cube": stl}, over)
        job = o.job("cube", d)
        subprocess.run(job.cmd, capture_output=True, text=True)
        if not os.path.exists(job.gcode):
            print(f"ORCAERR {fam}: no G-code")
            continue
        (sh, st), (oh, ot) = split(sx_gcode), split(job.gcode)
        hs, ho, ts, to = commands(sh), commands(oh), commands(st), commands(ot)
        ok = same(hs, ho) and same(ts, to)
        passed += ok
        print(("ok   " if ok else "DIFF ") + fam + f"  start {len(hs)} vs {len(ho)} commands, end {len(ts)} vs {len(to)}")
        if not ok:
            for ln in diff(hs, ho) + diff(ts, to):
                print(ln)
    print(f"{passed} of {len(names)} families produce the same commands")
    return 0 if passed == len(names) else 1


PLATE_TEMPS = {f"{k}_temp{sfx}": [str(settings.MATCHED["bed_temperature"])]
               for k in ("cool_plate", "eng_plate", "hot_plate", "textured_plate") for sfx in ("", "_initial_layer")}


def prepare(o, work, models, over, process=None):
    """Orca presets for the matched settings plus the machine G-code under test, and `process` settings on top."""
    orig = settings.slicer_machine
    orig_process = settings.slicer_process

    def proc(flavor):
        p = orig_process(flavor)
        p.update({k: str(v) for k, v in (process or {}).items()})
        return p

    settings.slicer_process = proc

    def machine(flavor):
        m = orig(flavor)
        m.update({k: v for k, v in over.items()})
        return m

    settings.slicer_machine = machine
    orig_filament = settings.slicer_filament

    def filament():
        f = orig_filament()
        f.update(PLATE_TEMPS)
        return f

    settings.slicer_filament = filament
    try:
        o.prepare(work, models)
    finally:
        settings.slicer_machine = orig
        settings.slicer_process = orig_process
        settings.slicer_filament = orig_filament


if __name__ == "__main__":
    sys.exit(main())
