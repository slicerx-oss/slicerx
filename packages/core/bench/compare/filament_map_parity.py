#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Which extruder each filament goes to on a printer with two (the Bambu Lab H2D), SlicerX against OrcaSlicer.

    python3 filament_map_parity.py --sx <sx> --orca <OrcaSlicer> [--cases two,three] [--runs 5] [--workdir DIR]

A 20 mm cube on the H2D's own machine settings and G-code, with features moved to other filaments (sparse infill
on filament 2 and the like), the filament map left to each slicer (automatic, for the least flushing). Both write
the map in their G-code (`; filament_map = 1,2`). OrcaSlicer 2.4.2 does not always give the same map for the same
plate when two maps cost the same, so it slices each case --runs times and the case passes when SlicerX's map is
the one Orca gives most often (or ties for it). Exit code 1 when a case fails. Standard library only.
"""
import argparse
import json
import os
import subprocess
import sys

import models as model_lib
import parity_gcode as pg
import printer_gcode_parity as pgp
import settings
import slicers

PRINTER = "bambu-h2d"
# Process keys for both slicers (Orca's names), and SlicerX's names for the same features.
CASES = {
    "one": ({}, 1),
    "two": ({"sparse_infill_filament": "2"}, 2),
    "two-walls": ({"wall_filament": "2", "sparse_infill_filament": "2", "solid_infill_filament": "2"}, 2),
    "three": ({"sparse_infill_filament": "2", "solid_infill_filament": "3"}, 3),
    "three-walls": ({"wall_filament": "2", "sparse_infill_filament": "3"}, 3),
}
SX_KEYS = {"sparse_infill_filament": ["sparse_infill_filament_id"],
           "wall_filament": ["outer_wall_filament_id", "inner_wall_filament_id"],
           "solid_infill_filament": ["internal_solid_filament_id", "top_surface_filament_id", "bottom_surface_filament_id"]}
COLORS = ["#ff0000", "#00ff00", "#0000ff", "#ffff00"]


def filament_map(path):
    if not os.path.exists(path):
        return None
    with open(path, errors="replace") as f:
        for ln in f:
            if ln.startswith("; filament_map = "):
                return ln.split("=", 1)[1].strip()
    return None


def run_case(name, sx, orca, profiles, work, runs):
    process, n = CASES[name]
    gdoc = json.load(open(os.path.join(profiles, "gcode.json")))
    mdoc = json.load(open(os.path.join(profiles, "machine.json")))
    family, machine, sections = pgp.printer_inputs(PRINTER, gdoc, mdoc)
    d = os.path.join(work, name)
    os.makedirs(os.path.join(d, "models"), exist_ok=True)
    stl = os.path.join(d, "models", "cube.stl")
    c = pgp.bed_center(machine)
    model_lib.write_stl(stl, [tuple((v[0] + c[0] - 128, v[1] + c[1] - 128, v[2]) for v in t) for t in model_lib.MODELS["cube"]()])
    over = {**machine, **sections}
    temps = [str(220 + 5 * i) for i in range(n)]
    per_filament = {"filament_diameter": ["1.75"] * n, "nozzle_temperature": temps, "nozzle_temperature_initial_layer": temps,
                    "filament_type": ["PLA"] * n, "filament_colour": COLORS[:n]}
    # SlicerX
    cfg = settings.sx_config()
    cfg.update(over)
    for k, v in process.items():
        for key in SX_KEYS[k]:
            cfg[key] = int(v)
    cfg.update({k: [float(x) if x.replace(".", "").isdigit() else x for x in v] for k, v in per_filament.items()})
    cfg["filament_max_volumetric_speed"] = ["100"] * n
    sg = os.path.join(d, "sx.gcode")
    slicers.slice_trusted(sx, stl, cfg, sg, pgp.bed_size(machine))
    # OrcaSlicer, one preset per filament (its CLI reads a filament list only from separate presets)
    o = slicers.Orca(orca)
    original = settings.slicer_filament

    def first_filament():
        f = original()
        f.update({k: v[:1] for k, v in per_filament.items()})
        return f

    settings.slicer_filament = first_filament
    try:
        pg.prepare(o, d, {"cube": stl}, over, process)
    finally:
        settings.slicer_filament = original
    job = o.job("cube", d)
    f1 = o.files["filament"]
    base = json.load(open(f1))
    base["filament_is_support"] = ["0"]  # Orca's CLI refuses several filaments without it
    json.dump(base, open(f1, "w"))
    presets = [f1]
    for i in range(1, n):
        p = f1.replace(".json", f"-{i + 1}.json")
        json.dump(dict(base, name=f"compare filament {i + 1}", filament_colour=[COLORS[i]], nozzle_temperature=[temps[i]],
                       nozzle_temperature_initial_layer=[temps[i]]), open(p, "w"))
        presets.append(p)
    job.cmd = [x if x != f1 else ";".join(presets) for x in job.cmd]
    seen = {}
    for _ in range(runs):
        if os.path.exists(job.gcode):
            os.remove(job.gcode)
        subprocess.run(job.cmd, capture_output=True, text=True, timeout=300)
        m = filament_map(job.gcode)
        seen[m] = seen.get(m, 0) + 1
    ours = filament_map(sg)
    top = max(seen.values())
    ok = ours is not None and seen.get(ours, 0) == top
    return {"case": name, "filaments": n, "sx": ours, "orca": seen, "ok": ok}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sx", required=True)
    ap.add_argument("--orca", required=True)
    ap.add_argument("--profiles", default=pgp.PROFILES, help="folder with gcode.json and machine.json")
    ap.add_argument("--cases", default=",".join(CASES))
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--workdir", default="filament-map-work")
    a = ap.parse_args()
    work = os.path.abspath(a.workdir)
    bad = 0
    for name in a.cases.split(","):
        r = run_case(name, a.sx, a.orca, a.profiles, work, a.runs)
        bad += not r["ok"]
        print(("ok   " if r["ok"] else "FAIL ") + f"{name} ({r['filaments']} filaments): SlicerX {r['sx']}, Orca over {a.runs} runs {r['orca']}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
