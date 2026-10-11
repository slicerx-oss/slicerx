#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Which extruder each filament goes to on a printer with two (the Bambu Lab H2D), SlicerX against OrcaSlicer
and Bambu Studio.

    python3 filament_map_parity.py --sx <sx> [--orca <OrcaSlicer>] [--bambu [<BambuStudio>]] [--cases two,three] [--runs 5] [--workdir DIR]

A 20 mm cube on the H2D's own machine settings and G-code, with features moved to other filaments (sparse infill
on filament 2 and the like), the filament map left to each slicer (automatic, for the least flushing). Each slicer
writes the map in its G-code (`; filament_map = 1,2`: 1 is the left extruder, 2 the right). Give one reference or
both; a case passes when SlicerX's map is the one the reference gives most often over --runs slices (or ties for it).

- OrcaSlicer 2.4.2 does not always give the same map for the same plate when two maps cost the same.
- Bambu Studio (--bambu, its install found as compare.py finds it when no path is given) slices a 3MF project
  built here from its own installed H2D machine, 0.20 mm process and PLA presets, read at run time and not stored
  here. Both it and SlicerX get the same flush volumes (--flush mm3 between any two filaments, on both extruders),
  so a map that costs the same both ways shows each slicer's tie-break. For Bambu printers Bambu Studio is the
  reference where the two differ.

Each line also gives every slicer's median wall time per slice. Exit code 1 when a case fails against a reference.
Standard library only.
"""
import argparse
import json
import os
import subprocess
import sys
import time
import zipfile
from statistics import median

import models as model_lib
import parity_gcode as pg
import printer_gcode_parity as pgp
import settings
import slicers

PRINTER = "bambu-h2d"
# Process keys for every slicer (Orca's and Bambu Studio's names), and SlicerX's names for the same features.
CASES = {
    "one": ({}, 1),
    "two": ({"sparse_infill_filament": "2"}, 2),
    "two-walls": ({"wall_filament": "2", "sparse_infill_filament": "2", "solid_infill_filament": "2"}, 2),
    "three": ({"sparse_infill_filament": "2", "solid_infill_filament": "3"}, 3),
    "three-walls": ({"wall_filament": "2", "sparse_infill_filament": "3"}, 3),
    "four": ({"wall_filament": "2", "sparse_infill_filament": "3", "solid_infill_filament": "4"}, 4),
}
SX_KEYS = {"sparse_infill_filament": ["sparse_infill_filament_id"],
           "wall_filament": ["outer_wall_filament_id", "inner_wall_filament_id"],
           "solid_infill_filament": ["internal_solid_filament_id", "top_surface_filament_id", "bottom_surface_filament_id"]}
COLORS = ["#ff0000", "#00ff00", "#0000ff", "#ffff00"]
EXTRUDERS = 2


def filament_map(path):
    if not os.path.exists(path):
        return None
    with open(path, errors="replace") as f:
        for ln in f:
            if ln.startswith("; filament_map = "):
                return ln.split("=", 1)[1].strip()
    return None


def flush_matrix(n, flush):
    """The same flush volume between any two filaments, an n by n block per extruder."""
    return [("0" if a == b else str(flush)) for _ in range(EXTRUDERS) for a in range(n) for b in range(n)]


def tally(seen, ours):
    top = max(seen.values())
    return ours is not None and seen.get(ours, 0) == top


def setup_case(name, profiles, work):
    """The case's folder and model, and the H2D machine settings from SlicerX's profiles."""
    process, n = CASES[name]
    gdoc = json.load(open(os.path.join(profiles, "gcode.json")))
    mdoc = json.load(open(os.path.join(profiles, "machine.json")))
    family, machine, sections = pgp.printer_inputs(PRINTER, gdoc, mdoc)
    d = os.path.join(work, name)
    os.makedirs(os.path.join(d, "models"), exist_ok=True)
    stl = os.path.join(d, "models", "cube.stl")
    c = pgp.bed_center(machine)
    model_lib.write_stl(stl, [tuple((v[0] + c[0] - 128, v[1] + c[1] - 128, v[2]) for v in t) for t in model_lib.MODELS["cube"]()])
    temps = [str(220 + 5 * i) for i in range(n)]
    per_filament = {"filament_diameter": ["1.75"] * n, "nozzle_temperature": temps, "nozzle_temperature_initial_layer": temps,
                    "filament_type": ["PLA"] * n, "filament_colour": COLORS[:n]}
    return {"process": process, "n": n, "dir": d, "stl": stl, "machine": machine, "over": {**machine, **sections},
            "temps": temps, "per_filament": per_filament}


def sx_map(sx, case, flush=None, tag="sx"):
    """SlicerX's map for the case, and the wall time of the slice. `flush` gives it the flush volumes."""
    n = case["n"]
    cfg = settings.sx_config()
    cfg.update(case["over"])
    # Every feature named, the unset ones on the object's filament as the others print them: left unset,
    # SlicerX prints solid infill with the sparse infill's filament.
    for k, keys in SX_KEYS.items():
        for key in keys:
            cfg[key] = int(case["process"].get(k, 1))
    cfg.update({k: [float(x) if x.replace(".", "").isdigit() else x for x in v] for k, v in case["per_filament"].items()})
    cfg["filament_max_volumetric_speed"] = ["100"] * n
    if flush is not None:
        cfg["flush_volumes_matrix"] = [float(x) for x in flush_matrix(n, flush)]
        cfg["flush_multiplier"] = [1.0] * EXTRUDERS
    sg = os.path.join(case["dir"], f"{tag}.gcode")
    t = time.perf_counter()
    slicers.slice_trusted(sx, case["stl"], cfg, sg, pgp.bed_size(case["machine"]))
    return filament_map(sg), time.perf_counter() - t


def orca_maps(orca, case, runs):
    """OrcaSlicer's maps over `runs` slices, one preset per filament (its CLI reads a filament list only from
    separate presets), and the median wall time."""
    n, per_filament, temps, d = case["n"], case["per_filament"], case["temps"], case["dir"]
    o = slicers.Orca(orca)
    original = settings.slicer_filament

    def first_filament():
        f = original()
        f.update({k: v[:1] for k, v in per_filament.items()})
        return f

    settings.slicer_filament = first_filament
    try:
        pg.prepare(o, d, {"cube": case["stl"]}, case["over"], case["process"])
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
    seen, walls = {}, []
    for _ in range(runs):
        if os.path.exists(job.gcode):
            os.remove(job.gcode)
        t = time.perf_counter()
        subprocess.run(job.cmd, capture_output=True, text=True, timeout=300)
        walls.append(time.perf_counter() - t)
        m = filament_map(job.gcode)
        seen[m] = seen.get(m, 0) + 1
    return seen, median(walls)


class BambuH2D(slicers.Bambu):
    """Bambu Studio on the H2D, from a 3MF project in the shape Bambu Studio saves one in."""
    MACHINE = "Bambu Lab H2D 0.4 nozzle"
    PROCESS = "0.20mm Standard @BBL H2D"
    FILAMENT = "Bambu PLA Basic @BBL H2D"
    VARIANT = "Direct Drive Standard"

    def project(self, base, case, flush):
        """Project settings: the machine and process presets with a value per extruder variant, as the presets
        give them; each filament's values for the standard nozzle; automatic map; the same flush everywhere. The
        case's feature filaments go in the object's settings (`maps`)."""
        n = case["n"]
        cfg = dict(base)
        cfg.update(self._resolve("machine", self.MACHINE, includes=True))
        cfg.update(self._resolve("process", self.PROCESS, includes=True))
        fil = self._resolve("filament", self.FILAMENT, includes=True)
        variants = fil.get("filament_extruder_variant") or [self.VARIANT]
        pick = variants.index(self.VARIANT) if self.VARIANT in variants else 0
        for k, v in fil.items():
            if isinstance(v, list) and len(v) == len(variants):
                cfg[k] = [v[pick]] * n
            elif isinstance(v, list) and len(v) == 1:
                cfg[k] = v * n
            else:
                cfg[k] = v
        for k, v in case["per_filament"].items():
            cfg[k] = [str(x) for x in v]
        cfg.update({
            "filament_self_index": [str(i + 1) for i in range(n)],
            "filament_map": ["1"] * n, "filament_map_mode": "Auto For Flush",
            "nozzle_volume_type": cfg.get("default_nozzle_volume_type") or ["Standard"] * EXTRUDERS,
            # Without one nozzle per extruder named here, Bambu Studio's command line fails every H2D slice.
            "extruder_nozzle_stats": ["Standard#1"] * EXTRUDERS,
            "flush_volumes_matrix": flush_matrix(n, flush), "flush_multiplier": ["1"] * EXTRUDERS,
            "version": "02.01.01.52", "from": "project", "name": "project_settings",
            "print_settings_id": self.PROCESS, "printer_settings_id": self.MACHINE, "filament_settings_id": [self.FILAMENT] * n,
            "inherits_group": [self.PROCESS] + [self.FILAMENT] * n + [self.MACHINE], "different_settings_to_system": [""] * (n + 2),
        })
        return cfg

    def maps(self, base, case, runs, flush):
        """Bambu Studio's maps over `runs` slices and the median wall time."""
        d = os.path.join(case["dir"], "bambu")
        os.makedirs(d, exist_ok=True)
        proj = os.path.join(d, "cube.3mf")
        self._write_3mf(proj, case["stl"], self.project(base, case, flush), legacy_header=True)
        # The feature filaments go in the object's settings: Bambu Studio prints a plate-wide
        # `sparse_infill_filament` and the like with the object's own filament.
        meta = "".join(f'<metadata key="{k}" value="{v}"/>' for k, v in case["process"].items())
        with zipfile.ZipFile(proj, "a") as z:
            z.writestr("Metadata/model_settings.config", '<?xml version="1.0" encoding="UTF-8"?>\n<config><object id="1">'
                       f'<metadata key="name" value="cube"/><metadata key="extruder" value="1"/>{meta}</object></config>\n')
        gcode = os.path.join(d, "plate_1.gcode")
        seen, walls = {}, []
        for _ in range(runs):
            if os.path.exists(gcode):
                os.remove(gcode)
            t = time.perf_counter()
            try:
                subprocess.run([self.path, "--slice", "1", "--outputdir", d, "--debug", "1", proj], capture_output=True, timeout=60)
            except subprocess.TimeoutExpired:
                pass  # it now and then hangs on exit after writing the G-code; the median leaves such a run out
            walls.append(time.perf_counter() - t)
            m = filament_map(gcode)
            seen[m] = seen.get(m, 0) + 1
        return seen, median(walls)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sx", required=True)
    ap.add_argument("--orca", help="compare with OrcaSlicer")
    ap.add_argument("--bambu", nargs="?", const="", help="compare with Bambu Studio (its path, or found in its install folder)")
    ap.add_argument("--bambu-profiles", help="Bambu Studio's profiles/BBL folder, when it is not next to the executable")
    ap.add_argument("--flush", type=float, default=280, help="flush volume in mm3 between any two filaments, for Bambu Studio and SlicerX")
    ap.add_argument("--profiles", default=pgp.PROFILES, help="folder with gcode.json and machine.json")
    ap.add_argument("--cases", default=",".join(CASES))
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--workdir", default="filament-map-work")
    a = ap.parse_args()
    if a.orca is None and a.bambu is None:
        ap.error("give --orca, --bambu or both")
    work = os.path.abspath(a.workdir)
    bambu = base = None
    if a.bambu is not None:
        bambu = BambuH2D(a.bambu or None, a.bambu_profiles)
        if not bambu.available():
            ap.error("Bambu Studio not found; pass its path to --bambu")
        os.makedirs(work, exist_ok=True)
        seed = setup_case("one", a.profiles, work)
        base = bambu.defaults(work, seed["stl"])
    bad = 0
    for name in a.cases.split(","):
        case = setup_case(name, a.profiles, work)
        n = case["n"]
        if a.orca:
            ours, sx_s = sx_map(a.sx, case)
            seen, ref_s = orca_maps(a.orca, case, a.runs)
            ok = tally(seen, ours)
            bad += not ok
            print(("ok   " if ok else "FAIL ") + f"{name} ({n} filaments): SlicerX {ours}, Orca over {a.runs} runs {seen}"
                  f" (wall s per slice: SlicerX {sx_s:.2f}, Orca {ref_s:.2f})")
        if bambu:
            ours, sx_s = sx_map(a.sx, case, a.flush, "sx-flush")
            seen, ref_s = bambu.maps(base, case, a.runs, a.flush)
            ok = tally(seen, ours)
            bad += not ok
            print(("ok   " if ok else "FAIL ") + f"{name} ({n} filaments): SlicerX {ours}, Bambu Studio {bambu.version} over {a.runs} runs {seen}"
                  f" (wall s per slice: SlicerX {sx_s:.2f}, Bambu Studio {ref_s:.2f})")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
