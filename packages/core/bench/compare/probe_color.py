#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Probe: two boxes on two filaments in OrcaSlicer, to see how it changes tools and purges.

    python3 probe_color.py --orca path/to/OrcaSlicer --workdir color-work [--set key=value ...]
"""
import argparse
import json
import os
import subprocess
import sys

import models as model_lib
import parity
import parity_sequence as seq
import slicers


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--orca")
    ap.add_argument("--sx", help="also slice with SlicerX and compare the tool changes")
    ap.add_argument("--workdir", default="color-work")
    ap.add_argument("--set", action="append", default=[])
    ap.add_argument("--machine", action="append", default=[])
    ap.add_argument("--tall", type=float, default=10.0)
    ap.add_argument("--paint", default="", help="paint one box instead: face=filament,... e.g. right=2")
    ap.add_argument("--top-scale", type=float, default=1.0, help="with --paint: scale of the top face, to slant the sides")
    ap.add_argument("--ext", default="1,2")
    ap.add_argument("--sxset", action="append", default=[], help="SlicerX config key=value")
    ap.add_argument("--projectjson", default="", help="Metadata/project_settings.config content as JSON")
    ap.add_argument("--procjson", default="{}", help="process keys as JSON, for list values")
    ap.add_argument("--bbl", action="store_true", help="use the P1S machine profile")
    ap.add_argument("--filaments", type=int, default=2)
    ap.add_argument("--orca-config", action="store_true", help="kept for old command lines: SlicerX always gets the settings Orca resolved")
    a = ap.parse_args()
    d = os.path.abspath(a.workdir)
    os.makedirs(os.path.join(d, "models"), exist_ok=True)
    extra = dict(parity.ORCA_ONLY)
    extra.update(s.split("=", 1) for s in a.set)
    orca = parity.ParityOrca(slicers.Orca(a.orca).path, extra)
    objs = [("left", 90.0, 128.0, a.tall), ("right", 170.0, 128.0, a.tall)]
    m3 = os.path.join(d, "models", "two.3mf")
    project = json.loads(a.projectjson) if a.projectjson else None
    if project is None and a.filaments >= 2:
        # Orca 2.4.2 segfaults slicing two filaments when the project carries no per-filament settings,
        # so the probe always writes them (two PLA filaments, the flush matrix Orca's GUI writes for them).
        n = a.filaments
        project = {"filament_colour": ["#FF0000", "#00FF00", "#0000FF", "#FFFF00"][:n], "filament_type": ["PLA"] * n,
                   "filament_is_support": ["0"] * n, "filament_diameter": ["1.75"] * n,
                   "nozzle_temperature": ["220"] * n, "nozzle_temperature_initial_layer": ["220"] * n,
                   "filament_settings_id": ["Generic PLA @BBL X1C"] * n,
                   # Orca fills a per-filament key the project lists for fewer filaments with 0: without this the
                   # second filament prints with a flow ratio of 0.
                   "filament_flow_ratio": ["1"] * n,
                   "flush_volumes_matrix": [("0" if i == j else "280") for i in range(n) for j in range(n)],
                   "flush_volumes_vector": ["140"] * (2 * n)}
    if a.paint:
        import paint3mf
        faces = {k: int(v) for k, v in (t.split("=") for t in a.paint.split(","))}
        m3 = os.path.join(d, "models", "painted.3mf")
        paint3mf.write_painted(m3, 128.0, 128.0, (20.0, 20.0, a.tall), faces, project=project, top_scale=a.top_scale)
    else:
        seq.write_3mf(m3, objs, {"left": {"extruder": a.ext.split(",")[0]}, "right": {"extruder": a.ext.split(",")[1]}}, project)
    orca.prepare(d, {"cube": os.path.join(d, "models", "x.stl")})
    # a second filament and a machine that shares one nozzle between them
    mach = json.load(open(orca.files["machine"]))
    if a.bbl:
        # Orca's CLI keeps only what a user preset lists, so each preset carries everything its system
        # parent has (flattened), as profile_parity does; an `inherits` alone leaves a generic printer.
        import profile_parity
        mach = profile_parity.flatten("BBL", "machine", "Bambu Lab P1S 0.4 nozzle")
        mach.update({"type": "machine", "name": "compare machine", "from": "User", "inherits": "Bambu Lab P1S 0.4 nozzle", "layer_change_gcode": "G92 E0"})
        proc = profile_parity.flatten("BBL", "process", "0.20mm Standard @BBL X1C")
        proc.update(extra)  # only what the probe sets, on top of the P1S process
        proc.update({"type": "process", "name": "compare process", "from": "User", "inherits": "0.20mm Standard @BBL X1C",
                     "compatible_printers": ["compare machine", "Bambu Lab P1S 0.4 nozzle"]})
        proc.pop("compatible_printers_condition", None)
        json.dump(proc, open(orca.files["process"], "w"))
        fbase = profile_parity.flatten("BBL", "filament", "Bambu PLA Basic @BBL X1C")
        fbase.update({"type": "filament", "name": "compare filament", "from": "User", "inherits": "Bambu PLA Basic @BBL X1C",
                      "compatible_printers": ["compare machine", "Bambu Lab P1S 0.4 nozzle"]})
        fbase.pop("compatible_printers_condition", None)
        json.dump(fbase, open(orca.files["filament"], "w"))
    if a.filaments > 1 and not a.bbl:
        mach["single_extruder_multi_material"] = "1"
        # Prusa style multi material machines list every setting once per extruder.
        for k, v in list(mach.items()):
            if isinstance(v, list) and len(v) == 1:
                mach[k] = v * a.filaments
    mach.update(s.split("=", 1) for s in a.machine)
    json.dump(mach, open(orca.files["machine"], "w"))
    proc = json.load(open(orca.files["process"]))
    proc.update(json.loads(a.procjson))
    json.dump(proc, open(orca.files["process"], "w"))
    fil = json.load(open(orca.files["filament"]))
    fil2 = dict(fil, name="compare filament 2")
    f2 = os.path.join(d, "orca-filament2.json")
    json.dump(fil2, open(f2, "w"))
    cmd = orca._cmd(m3, os.path.join(d, "orca"), ["--debug", "3", "--arrange", "0", "--logfile", os.path.join(d, "orca.log")])
    if a.filaments > 1:
        cmd[cmd.index("--load-filaments") + 1] = orca.files["filament"] + ";" + f2
    os.makedirs(os.path.join(d, "orca"), exist_ok=True)
    r = subprocess.run(cmd, capture_output=True, text=True)
    print(r.returncode, (r.stdout + r.stderr)[-800:])
    if not a.sx:
        return 0
    return compare(a, d, objs, os.path.join(d, "orca", "plate_1.gcode"))


def tools(path):
    """Tool commands in order, and filament mm per feature per tool."""
    seq, tool, kind, rel, e = [], 0, "", False, 0.0
    per = {}
    with open(path, errors="replace") as f:
        for ln in f:
            if ln.startswith(";TYPE:"):
                kind = ln[6:].strip()
                continue
            if ln.startswith("; FEATURE:"):
                kind = ln[10:].strip()
                continue
            w = ln.split(";", 1)[0].split()
            if not w:
                continue
            if len(w[0]) == 2 and w[0][0] == "T" and w[0][1].isdigit():
                tool = int(w[0][1])
                seq.append(tool)
            elif w[0] == "M82":
                rel = False
            elif w[0] == "M83":
                rel = True
            elif w[0] in ("G1", "G92"):
                f_ = {t[0]: t[1:] for t in w[1:] if len(t) > 1}
                if w[0] == "G92":
                    e = float(f_["E"]) if "E" in f_ else e
                    continue
                if "E" in f_:
                    v = float(f_["E"])
                    d = v if rel else v - e
                    e = 0.0 if rel else v
                    if d > 0 and ("X" in f_ or "Y" in f_):
                        per[(kind, tool)] = per.get((kind, tool), 0.0) + d
    return seq, per


def compare(a, d, objs, orca_gcode):
    # SlicerX gets every setting Orca resolved for this run (its config block), so no key falls back to a
    # SlicerX default; --sxset then changes single keys on the SlicerX side only.
    import profile_parity
    cfg = profile_parity.sx_config_from_block(profile_parity.config_block(orca_gcode))
    for kv in a.sxset:
        k, v = kv.split("=", 1)
        try:
            cfg[k] = json.loads(v)  # numbers, lists and booleans keep their type
        except ValueError:
            cfg[k] = v
    plate, meshes = [], {}
    if a.paint:
        meshes = {"p": os.path.join(d, "models", "painted.3mf")}
        plate = [{"id": "p", "mesh": "p"}]
        objs = []
    # The filament of each box, as --ext gives it to Orca.
    ext = [int(e) for e in a.ext.split(",")]
    for k, (name, cx, cy, h) in enumerate(objs):
        p = os.path.join(d, "models", f"{name}.stl")
        model_lib.write_stl(p, seq.box(h))
        meshes[name] = p
        plate.append({"id": name, "mesh": name, "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, cx, cy, 0, 1],
                      "slotOverrides": {p: ext[k], os.path.basename(p): ext[k], name: ext[k]}})
    rp = os.path.join(d, "request.json")
    json.dump({"schemaVersion": 1, "meshes": meshes, "plate": {"objects": plate}, "config": cfg,
               "options": {"flavor": "marlin2"}}, open(rp, "w"))
    out = os.path.join(d, "sx")
    r = subprocess.run([a.sx, "slice", "--request", rp, "--out-dir", out], capture_output=True, text=True)
    if r.returncode:
        print(r.stderr[-500:])
        return 1
    sa, pa = tools(os.path.join(out, "slice.gcode"))
    sb, pb = tools(orca_gcode)
    ok = True
    good = len(sa) == len(sb)
    ok &= good
    print(f"{'ok  ' if good else 'FAIL'} tool changes                sx {len(sa)}  orca {len(sb)}")
    good = sa == sb
    ok &= good
    first = next((i for i, (x, y) in enumerate(zip(sa, sb)) if x != y), 0 if good else min(len(sa), len(sb)))
    at = "" if good else f"  (first difference at change {first})"
    print(f"{'ok  ' if good else 'FAIL'} tool order                   sx {sa[first:first + 12]}  orca {sb[first:first + 12]}{at}")
    row = parity.time_row(parity.print_time(os.path.join(out, "slice.gcode")), parity.print_time(orca_gcode))
    ok &= row["ok"]
    print(f"{'ok  ' if row['ok'] else 'FAIL'} print time s                 sx {row['sx']}  orca {row['orca']}")
    keys = sorted(set(pa) | set(pb))
    for kind, tool in keys:
        x, y = pa.get((kind, tool), 0.0), pb.get((kind, tool), 0.0)
        good = abs(x - y) <= max(0.12 * y, 8.0)
        ok &= good
        print(f"{'ok  ' if good else 'FAIL'} {kind:<24} T{tool}  sx {x:8.1f}  orca {y:8.1f}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
