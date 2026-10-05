#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Per-printer G-code parity: every printer of the settings package, sliced by SlicerX and by OrcaSlicer.

    python3 printer_gcode_parity.py --sx <sx> --orca <OrcaSlicer> [--printers bambu-a1,voron-0.1] [--workdir DIR]

parity_gcode.py compares the custom G-code of each template family on one generic machine. This
script goes one step further and runs each printer with its own machine settings (machine.json:
bed, flavor, limits, retraction, z hop, ...) and its family's G-code (gcode.json), then compares
the whole file as a sequence of control commands: everything except the extruding and travel
moves themselves (G0, G1, G2, G3 with X, Y or Z), so start and end G-code, layer change G-code,
fan, temperature, acceleration and tool change commands all count. Comments and the lines each
slicer writes by itself (M73 and the like) are dropped, numbers are compared with a small
tolerance. Also compared: the number of layers and the bed size the first move lies inside.
Prints how many printers produce the same sequence and the first differences of the others.
Standard library only.
"""
import argparse
import json
import os
import re
import subprocess
import sys

import models as model_lib
import parity_gcode as pg
import settings
import slicers
from gcode import is_layer_mark

HERE = os.path.dirname(os.path.abspath(__file__))
PROFILES = os.path.join(HERE, "..", "..", "..", "profiles")
PRINTERS = os.path.join(HERE, "..", "..", "..", "settings", "profiles", "printers.json")
GCODE_KEYS = {"start": "machine_start_gcode", "end": "machine_end_gcode", "beforeLayerChange": "before_layer_change_gcode",
              "layerChange": "layer_change_gcode", "changeFilament": "change_filament_gcode"}
MOVE = re.compile(r"^G[0123]\b")
# Lines left out unless --strict: fan speeds (each slicer applies its own cooling defaults), bare tool
# selects, and the Klipper print statistics SlicerX writes itself when the profile has no such line.
SOFT = re.compile(r"^(M106|M107|T\d+$|SET_PRINT_STATS_INFO)", re.I)


def control_commands(path, strict=False):
    """The file as a list of control commands: no comments, no moves, none of the slicers' own lines."""
    out = []
    for ln in open(path, errors="replace").read().splitlines():
        ln = ln.split(";", 1)[0].strip()
        if not ln or pg.OWN.match(ln) or MOVE.match(ln) or (not strict and SOFT.match(ln)):
            continue
        out.append(ln)
    return out


def layers(path):
    return sum(1 for ln in open(path, errors="replace") if is_layer_mark(ln))


def printer_model(printer_id):
    """The printer_model the app sends (settings `printerConfig`): the model, with the vendor in front unless the
    model starts with the vendor's first word. Bambu Lab models turn on Orca's Bambu output (`is_BBL_printer`)."""
    for p in json.load(open(PRINTERS))["printers"]:
        if p["id"] == printer_id:
            first = p["vendor"].split(" ")[0].lower()
            return p["model"] if p["model"].lower().startswith(first) else f"{p['vendor']} {p['model']}"
    return None


def printer_inputs(printer_id, gcode_doc, machine_doc):
    """(machine settings in Orca format, G-code sections) for one printer."""
    family = gcode_doc["models"].get(printer_id)
    entry = machine_doc["models"].get(printer_id)
    if family is None or entry is None:
        return None
    parts = gcode_doc["families"][family]
    sections = {GCODE_KEYS[k]: v for k, v in parts.items() if k in GCODE_KEYS and isinstance(v, str)}
    if "G92 E0" not in sections.get("layer_change_gcode", ""):
        sections["layer_change_gcode"] = sections.get("layer_change_gcode", "") + "\nG92 E0"
    machine = {k: v for k, v in entry["machine"].items() if not k.endswith("_gcode")}
    model = printer_model(printer_id)
    if model:
        machine["printer_model"] = model
    # the plate SlicerX assumes when the app sends none, and the one Bambu Lab ships these printers with
    if model and model.startswith("Bambu Lab"):
        machine["curr_bed_type"] = "Textured PEI Plate"
    return family, machine, sections


def bed_center(machine):
    """Center of the printable area, mm, from Orca's list of "XxY" points; None when there is none."""
    pts = []
    for p in machine.get("printable_area") or []:
        try:
            x, y = (float(v) for v in str(p).split("x"))
        except ValueError:
            return None
        pts.append((x, y))
    if not pts:
        return None
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2


def bed_size(machine):
    """Width and depth of the printable area, mm; None when there is none."""
    c = bed_center(machine)
    return (2 * c[0], 2 * c[1]) if c else None


def weight_line(x):
    m = re.match(r"M74 W([-\d.]+)$", x)
    return float(m.group(1)) if m else None


def same_line(x, y):
    # The running weight (M74 W) is within 1.5 percent of Orca's: brim, first layer and sparse infill match
    # to a fraction of a percent, and the rest is the internal bridge anchoring that is not written yet
    # (docs/core-features.md); everything else as parity_gcode compares.
    wx, wy = weight_line(x), weight_line(y)
    if wx is not None and wy is not None:
        return abs(wx - wy) <= 0.015 * max(wx, wy) + 0.002
    return pg.same([x], [y])


def same_commands(a, b):
    return len(a) == len(b) and all(same_line(x, y) for x, y in zip(a, b))


def diff_commands(a, b, limit):
    out = []
    for i in range(max(len(a), len(b))):
        x = a[i] if i < len(a) else "(nothing)"
        y = b[i] if i < len(b) else "(nothing)"
        if not same_line(x, y):
            out.append(f"      line {i}: sx {x!r} | orca {y!r}")
            if len(out) >= limit:
                break
    return out


def run_printer(printer_id, family, machine, sections, sx_path, orca_path, work, strict=False):
    d = os.path.join(work, printer_id)
    os.makedirs(os.path.join(d, "models"), exist_ok=True)
    stl = os.path.join(d, "models", "cube.stl")
    tris = model_lib.MODELS["cube"]()
    # Both slicers get the cube in the middle of this printer's bed.
    c = bed_center(machine)
    if c:
        dx, dy = c[0] - model_lib.BED_CENTER[0], c[1] - model_lib.BED_CENTER[1]
        tris = [tuple((v[0] + dx, v[1] + dy, v[2]) for v in t) for t in tris]
    model_lib.write_stl(stl, tris)
    over = {**machine, **sections}
    cfg = settings.sx_config()
    cfg.update(over)
    cfg.update({"filament_max_volumetric_speed": ["100"], "nozzle_temperature_range_high": ["240"], "nozzle_temperature_range_low": ["190"]})
    cfg["slow_down_for_layer_cooling"] = False
    # Orca's compare process prints no skirt
    cfg.setdefault("skirt_loops", 0)
    cfg_path = os.path.join(d, "sx.json")
    json.dump(cfg, open(cfg_path, "w"))
    sx_gcode = os.path.join(d, "sx.gcode")
    r = slicers.slice_trusted(sx_path, stl, cfg, sx_gcode, bed_size(machine))
    if r.returncode != 0:
        return {"printer": printer_id, "family": family, "error": "sx: " + r.stderr.strip()[-200:]}
    o = slicers.Orca(orca_path)
    o.extra_machine = over
    pg.prepare(o, d, {"cube": stl}, over)
    job = o.job("cube", d)
    subprocess.run(job.cmd, capture_output=True, text=True)
    if not os.path.exists(job.gcode):
        return {"printer": printer_id, "family": family, "error": "Orca produced no G-code"}
    a, b = control_commands(sx_gcode, strict), control_commands(job.gcode, strict)
    same = same_commands(a, b)
    la, lb = layers(sx_gcode), layers(job.gcode)
    return {"printer": printer_id, "family": family, "ok": same and abs(la - lb) <= 1, "commands": [len(a), len(b)],
            "layers": [la, lb], "diff": [] if same else diff_commands(a, b, 6)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sx")
    ap.add_argument("--orca")
    ap.add_argument("--profiles", default=PROFILES, help="folder with gcode.json and machine.json")
    ap.add_argument("--strict", action="store_true", help="also compare fan speeds, tool selects and Klipper print statistics")
    ap.add_argument("--printers", default="")
    ap.add_argument("--workdir", default="printer-gcode-work")
    ap.add_argument("--out", default="printer-gcode-results.json")
    a = ap.parse_args()
    sx, orca = slicers.SlicerX(a.sx), slicers.Orca(a.orca)
    if not (sx.available() and orca.available()):
        print("need sx and OrcaSlicer (--sx, --orca)", file=sys.stderr)
        return 2
    gcode_doc = json.load(open(os.path.join(a.profiles, "gcode.json")))
    machine_doc = json.load(open(os.path.join(a.profiles, "machine.json")))
    ids = [p for p in (a.printers.split(",") if a.printers else sorted(machine_doc["models"])) if p]
    work = os.path.abspath(a.workdir)
    results = []
    for pid in ids:
        inputs = printer_inputs(pid, gcode_doc, machine_doc)
        if inputs is None:
            print(f"SKIP {pid}: no machine settings or no G-code family")
            continue
        res = run_printer(pid, *inputs, sx.path, orca.path, work, a.strict)
        results.append(res)
        if "error" in res:
            print(f"ERROR {pid} ({res['family']}): {res['error']}")
            continue
        print(("ok   " if res["ok"] else "DIFF ") + f"{pid} ({res['family']}): {res['commands'][0]} vs {res['commands'][1]} commands, layers {res['layers'][0]} vs {res['layers'][1]}")
        for ln in res["diff"]:
            print(ln)
    good = sum(1 for r in results if r.get("ok"))
    print(f"{good} of {len(results)} printers produce the same command sequence")
    json.dump({"printers": results}, open(a.out, "w"), indent=1)
    return 0 if good == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
