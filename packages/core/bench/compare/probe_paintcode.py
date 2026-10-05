#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Learns how a split `paint_color` maps to sub-triangles: paints one triangle of a box face with a
hand-written code and prints the colors OrcaSlicer puts on the outer wall of that face.

    python3 probe_paintcode.py --orca path/to/OrcaSlicer --workdir work --code 1 ...
"""
import argparse
import json
import os
import re
import subprocess
import sys

import parity
import paint3mf
import slicers
import settings
import probe_color
from gcode import is_layer_mark, plain


def leaf(state):
    if state < 3:
        return [state << 2]
    return [3 << 2, state - 3]


def code_text(split_sides, special, states):
    """Stream: the split nibble, then each child leaf; the text is the nibbles reversed."""
    if split_sides == 0:
        return "".join(f"{n:X}" for n in reversed(leaf(states[0])))
    stream = [split_sides | (special << 2)]
    for s in states:
        stream += leaf(s)
    return "".join(f"{n:X}" for n in reversed(stream))


def wall_map(gcode, face_x, size_y, dz):
    """Tool of the outer wall along the face at x >= face_x - 0.6, by layer and y, sampled along each move."""
    tool, layer, kind = 0, 0, ""
    rows = {}
    pos = None
    for ln in map(plain, open(gcode, errors="replace")):
        if is_layer_mark(ln):
            layer += 1
        elif ln.startswith(";TYPE:"):
            kind = ln[6:].strip()
        else:
            m = re.match(r"T(\d)$", ln)
            if m:
                tool = int(m.group(1))
            elif ln.startswith("G") and " X" in ln:
                x = re.search(r" X([\d.]+)", ln)
                y = re.search(r" Y([\d.]+)", ln)
                if not (x and y):
                    continue
                pt = (float(x.group(1)), float(y.group(1)))
                if ln.startswith("G1") and " E" in ln and kind == "Outer wall" and pos:
                    for t in range(21):
                        px = pos[0] + (pt[0] - pos[0]) * t / 20
                        py = pos[1] + (pt[1] - pos[1]) * t / 20
                        if px >= face_x - 0.6:
                            rows.setdefault(layer, {})[round(py * 2) / 2] = tool
                pos = pt
    return {k: sorted(v.items()) for k, v in rows.items()}


def map_for(code, filaments, d, orca_path, tri=6):
    """Slices a box whose triangle `tri` carries `code` and returns the outer wall's tool by layer and y."""
    os.makedirs(os.path.join(d, "models"), exist_ok=True)
    k = max(filaments, 2)
    m3 = os.path.join(d, "models", "p.3mf")
    project = {"filament_colour": ["#FF0000", "#00FF00", "#0000FF", "#FFFF00"][:k], "filament_type": ["PLA"] * k,
               "flush_volumes_matrix": [("0" if i == j else "140") for i in range(k) for j in range(k)],
               "flush_volumes_vector": ["140"] * (2 * k), "flush_multiplier": ["1"], "filament_map": ["1"] * k}
    paint3mf.write_painted(m3, 128.0, 128.0, (20.0, 20.0, 20.0), {}, project=project, raw={tri: code})
    orca = parity.ParityOrca(orca_path, parity.ORCA_ONLY)
    orca.prepare(d, {"cube": m3})
    mach = {"type": "machine", "name": "compare machine", "from": "User", "inherits": "Bambu Lab P1S 0.4 nozzle", "layer_change_gcode": "G92 E0"}
    json.dump(mach, open(orca.files["machine"], "w"))
    proc = json.load(open(orca.files["process"]))
    proc["inherits"] = "0.20mm Standard @BBL X1C"
    proc["compatible_printers"] = ["compare machine", "Bambu Lab P1S 0.4 nozzle"]
    json.dump(proc, open(orca.files["process"], "w"))
    fbase = json.load(open(orca.files["filament"]))
    fbase["inherits"] = "Generic PLA @BBL X1C"
    fbase["compatible_printers"] = ["compare machine", "Bambu Lab P1S 0.4 nozzle"]
    files = []
    for i in range(k):
        fp = os.path.join(d, f"f{i}.json")
        json.dump(dict(fbase, name=f"compare filament {i}"), open(fp, "w"))
        files.append(fp)
    od = os.path.join(d, "orca")
    os.makedirs(od, exist_ok=True)
    for f in os.listdir(od):
        os.remove(os.path.join(od, f))
    cmd = orca._cmd(m3, od, ["--debug", "1", "--arrange", "0"])
    cmd[cmd.index("--load-filaments") + 1] = ";".join(files)
    r = subprocess.run(cmd, capture_output=True, text=True)
    g = os.path.join(od, "plate_1.gcode")
    if not os.path.exists(g):
        raise RuntimeError(f"no gcode {r.returncode} {(r.stdout + r.stderr)[-300:]}")
    return wall_map(g, 138.0, 20.0, 20.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--orca")
    ap.add_argument("--workdir", default="pc-work")
    ap.add_argument("--raw", default="", help="a paint_color text to use as is")
    ap.add_argument("--split", type=int, default=0)
    ap.add_argument("--special", type=int, default=0)
    ap.add_argument("--states", default="1")
    ap.add_argument("--tri", type=int, default=6, help="triangle index: 6 and 7 are the right face")
    a = ap.parse_args()
    states = [int(x) for x in a.states.split(",")]
    code = a.raw or code_text(a.split, a.special, states)
    rows = map_for(code, 4 if a.raw else max(states), os.path.abspath(a.workdir), slicers.Orca(a.orca).path, a.tri)
    print("code", code)
    for layer in range(100, 0, -5):
        cells = ["."] * 20
        for y, t in rows.get(layer, []):
            cells[min(19, max(0, int(y - 118.0)))] = str(t + 1)
        print(f"z{layer * 0.2:5.1f} " + "".join(cells))
    return 0


if __name__ == "__main__":
    sys.exit(main())
