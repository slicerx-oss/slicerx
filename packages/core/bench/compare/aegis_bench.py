#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""aegis walls against Arachne (ours and Orca's) and classic, on every generated model, plus aegis with the
features that touch walls. Each run is checked (it slices, the G-code exists, shards change nothing) and
measured: slice time, filament, print time, and how steady the wall widths are.

    python3 aegis_bench.py --sx path/to/sx [--orca path/to/OrcaSlicer] [--models gear,wedge] [--workdir aegis-work]

Wall width metrics, read from the `;WIDTH:` comments inside Outer wall and Inner wall: width changes per meter
of wall, the narrowest and widest bead, and the share of wall length more than 20 percent off the nominal width.
All runs use the parity base (orca_base.py), so the generators are the only difference. Standard library only.
"""
import argparse
import json
import math
import os
import subprocess
import sys
import time

import models as model_lib
import orca_base
import parity
import slicers
from gcode import plain

WALLS = ("Outer wall", "Inner wall", "Overhang wall")

# The features that read or change walls, each on aegis.
FEATURES = {
    "seam-aligned": {"seam_position": "aligned"},
    "seam-back": {"seam_position": "back"},
    "seam-nearest": {"seam_position": "nearest"},
    "seam-random": {"seam_position": "random"},
    "scarf": {"seam_slope_type": "external", "seam_slope_min_length": 10},
    "scarf-all": {"seam_slope_type": "all", "seam_slope_inner_walls": 1},
    "fuzzy": {"fuzzy_skin": "external", "fuzzy_skin_thickness": 0.2, "fuzzy_skin_point_distance": 0.6},
    "fuzzy-extrusion": {"fuzzy_skin": "external", "fuzzy_skin_mode": "extrusion", "fuzzy_skin_noise_type": "perlin"},
    "ironing": {"ironing_type": "top"},
    "onewalltop": {"only_one_wall_top": 1, "wall_loops": 3},
    "walls3": {"wall_loops": 3},
    "outer-first": {"wall_sequence": "outer wall/inner wall"},
}


def wall_stats(path, nominal):
    """Width changes per meter of wall, min and max width, share of wall length off nominal by over 20 percent."""
    kind, width, x, y = "", nominal, None, None
    total = off = 0.0
    changes, lo, hi = 0, 1e9, 0.0
    last_wall_width = None
    with open(path, errors="replace") as f:
        for ln in map(plain, f):
            if ln.startswith(";TYPE:"):
                kind = ln[6:].strip()
                continue
            if ln.startswith(";WIDTH:"):
                try:
                    width = float(ln[7:])
                except ValueError:
                    pass
                continue
            if ln[0] == ";":
                continue
            w = ln.split(";", 1)[0].split()
            if not w or w[0] not in ("G0", "G1", "G2", "G3"):
                continue
            d = {t[0]: t[1:] for t in w[1:] if len(t) > 1}
            try:
                nx = float(d["X"]) if "X" in d else x
                ny = float(d["Y"]) if "Y" in d else y
            except ValueError:
                continue
            extruding = "E" in d and not d["E"].startswith("-") and ("X" in d or "Y" in d)
            if extruding and kind in WALLS and x is not None and nx is not None:
                seg = math.hypot(nx - x, ny - y)
                total += seg
                if abs(width / nominal - 1) > 0.2:
                    off += seg
                lo, hi = min(lo, width), max(hi, width)
                if last_wall_width is not None and abs(width - last_wall_width) > 1e-3:
                    changes += 1
                last_wall_width = width
            x, y = nx, ny
    if total <= 0:
        return {"wall_mm": 0}
    return {"wall_mm": round(total), "changes_per_m": round(1000 * changes / total, 1), "min_w": round(lo, 3),
            "max_w": round(hi, 3), "off_pct": round(100 * off / total, 2)}


def slice_sx(sx, stl, cfg, out_dir, options=None, second=None):
    """Slices one model through a request; returns (G-code path or None, seconds, error text). `second` adds a
    cube 40 mm to the right on filament 2 (a two-color plate)."""
    os.makedirs(out_dir, exist_ok=True)
    meshes, objects = {"m": stl}, [{"id": "m", "mesh": "m"}]
    if second:
        meshes["c"] = second
        objects.append({"id": "c", "mesh": "c", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 40, 0, 0, 1],
                        "slotOverrides": {"c": 2, second: 2, os.path.basename(second): 2}})
    req = {"schemaVersion": 1, "meshes": meshes, "plate": {"objects": objects}, "config": cfg,
           "options": {"flavor": "marlin2", **(options or {})}}
    rp = os.path.join(out_dir, "request.json")
    json.dump(req, open(rp, "w"))
    t0 = time.monotonic()
    r = subprocess.run([sx, "slice", "--request", rp, "--out-dir", out_dir], capture_output=True, text=True)
    dt = time.monotonic() - t0
    g = os.path.join(out_dir, "slice.gcode")
    if r.returncode or not os.path.exists(g):
        return None, dt, (r.stderr or r.stdout)[-300:]
    return g, dt, ""


def gcode_body(path):
    """The G-code without the header and footer comments that name the run."""
    with open(path, errors="replace") as f:
        return [ln for ln in f if not ln.startswith("; generated") and not ln.startswith(";@") and "time" not in ln[:30]]


def run(a):
    sx = slicers.SlicerX(a.sx).path
    work = os.path.abspath(a.workdir)
    names = a.models.split(",") if a.models else sorted(n for n in model_lib.MODELS if n not in ("dense",))
    base = orca_base.sx_base()
    nominal = float(base.get("outer_wall_line_width") or base.get("line_width") or 0.42)
    rows = []
    for name in names:
        d = os.path.join(work, name)
        os.makedirs(d, exist_ok=True)
        stl = os.path.join(d, f"{name}.stl")
        model_lib.write_stl(stl, model_lib.MODELS[name]())
        runs = [(g, {"wall_generator": g}, None) for g in ("aegis", "arachne", "classic")]
        if not a.quick:
            runs += [(f"aegis+{k}", {"wall_generator": "aegis", **v}, None) for k, v in FEATURES.items()]
            # sleipnir: thin layers on the lower half, thick on the upper (the request's layer tops).
            tops, z = [], 0.2
            while z < 260:
                tops.append(round(z, 3))
                z += 0.08 if z < 4 else 0.28
            runs.append(("aegis+sleipnir", {"wall_generator": "aegis"}, {"layerTopsMm": tops}))
            runs.append(("aegis+shards5", {"wall_generator": "aegis"}, {"shards": 5}))
            # Two filaments: the model on filament 1, a cube beside it on filament 2, with a prime tower.
            two = {"wall_generator": "aegis", "enable_prime_tower": 1, "filament_colour": ["#FF0000", "#00FF00"],
                   "filament_type": ["PLA", "PLA"], "nozzle_temperature": [220, 220],
                   "nozzle_temperature_initial_layer": [220, 220], "filament_diameter": [1.75, 1.75],
                   "filament_density": [1.24, 1.24], "flush_volumes_matrix": [0, 280, 280, 0]}
            runs.append(("aegis+two-color", two, "two-color"))
        results = {}
        for label, extra, options in runs:
            cfg = dict(base)
            cfg.update(extra)
            second = None
            if options == "two-color":
                second = os.path.join(d, "cube.stl")
                model_lib.write_stl(second, model_lib.MODELS["cube"]())
                options = None
            g, dt, err = slice_sx(sx, stl, cfg, os.path.join(d, label.replace("+", "-")), options, second)
            row = {"model": name, "run": label, "ok": g is not None, "slice_s": round(dt, 2)}
            if g is None:
                row["error"] = err
            else:
                p = parity.parse(g)
                row.update({"filament_mm": round(p["total_mm"], 1), "time_s": p["time_s"], "layers": p["layers"]})
                row.update(wall_stats(g, nominal))
                results[label] = g
            rows.append(row)
            print(json.dumps(row), flush=True)
        # Shards must not change the G-code.
        if "aegis" in results and "aegis+shards5" in results:
            same = gcode_body(results["aegis"]) == gcode_body(results["aegis+shards5"])
            rows.append({"model": name, "run": "shards-identical", "ok": same})
            print(json.dumps(rows[-1]), flush=True)
        if a.orca:
            orca = parity.ParityOrca(slicers.Orca(a.orca).path, {"wall_generator": "arachne"})
            od = os.path.join(d, "orca")
            os.makedirs(os.path.join(od, "models"), exist_ok=True)
            ostl = os.path.join(od, "models", f"{name}.stl")
            model_lib.write_stl(ostl, model_lib.MODELS[name]())
            orca.prepare(od, {"cube": ostl})
            job = orca.job(name, od)
            t0 = time.monotonic()
            subprocess.run(job.cmd, capture_output=True, text=True)
            dt = time.monotonic() - t0
            row = {"model": name, "run": "orca-arachne", "ok": os.path.exists(job.gcode), "slice_s": round(dt, 2)}
            if row["ok"]:
                p = parity.parse(job.gcode)
                row.update({"filament_mm": round(p["total_mm"], 1), "time_s": p["time_s"], "layers": p["layers"]})
                row.update(wall_stats(job.gcode, nominal))
            rows.append(row)
            print(json.dumps(row), flush=True)
    json.dump(rows, open(a.out, "w"), indent=1)
    bad = [r for r in rows if not r.get("ok")]
    for r in bad:
        print("FAILED", r["model"], r["run"], r.get("error", ""))
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sx")
    ap.add_argument("--orca")
    ap.add_argument("--models", default="")
    ap.add_argument("--workdir", default="aegis-work")
    ap.add_argument("--out", default="aegis-results.json")
    ap.add_argument("--quick", action="store_true", help="the three generators only")
    return run(ap.parse_args())


if __name__ == "__main__":
    sys.exit(main())
