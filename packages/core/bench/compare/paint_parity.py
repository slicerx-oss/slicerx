#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Painted colors: SlicerX against OrcaSlicer and Bambu Studio, as black boxes, on painted models.

    python3 paint_parity.py --sx <sx> --orca <OrcaSlicer> [--bambu <BambuStudio>] [--cases faces2,faces4,slant3]
        [--file project.3mf ...] [--workdir paint-work] [--out paint-results.json] [--tol 0.05] [--overlap 0.9]

Each model is one painted object (Bambu and Orca `paint_color` on its triangles) in a plain 3MF, the same file
for every slicer, on the Bambu Lab P1S with 0.20mm Standard and PLA Basic, one filament per paint color:

- generated cases: a box with whole faces painted (`faces2`, `faces4`) and a box with slanted sides
  (`slant3`), so paint meets layers at an angle;
- `--file`: a Bambu Studio or Orca project, flattened to one painted object (each part's own filament becomes
  paint on its unpainted triangles), centered on the bed. Its own settings are not used.

OrcaSlicer is the reference. SlicerX gets every setting Orca resolved for the run (the config block at the end
of its G-code). Bambu Studio gets its own P1S presets with the same filaments, as a second opinion on how close
two mature slicers come. Measured from the G-code of each: filament per tool on the model's own features (prime
tower, flushes and custom G-code left out), per layer and in total; where each filament prints on each layer:
the bed in 1 mm cells, each cell given to the filament whose beads pass over it most on that layer (after moving
each slicer's first layer to the same center), compared on the cells both slicers print as the share where
they give the same filament; and wall time, peak memory and CPU time of each run.

Exit code 1 when SlicerX misses Orca: a filament's total off by more than --tol (with a 20 mm floor), or a
filament's placement agreeing on less than --overlap of its cells. Standard library only.
"""
import argparse
import json
import math
import os
import re
import subprocess
import sys
import zipfile

import measure
import paint3mf
import profile_parity
import slicers
from gcode import is_layer_mark, plain

HERE = os.path.dirname(os.path.abspath(__file__))
MACHINE, PROCESS, FILAMENT = "Bambu Lab P1S 0.4 nozzle", "0.20mm Standard @BBL X1C", "Bambu PLA Basic @BBL X1C"
COLORS = ["#FFFFFF", "#FF0000", "#00A0FF", "#FFD000", "#20C040", "#A040FF", "#FF8000", "#000000"]
# Features that are not the model: the prime tower, the flushes and wipes around a change, custom G-code.
NOT_MODEL = re.compile(r"prime tower|wipe tower|flush|purge|custom|skirt|brim", re.I)
CELL = 1.0
# Seconds one slicer run may take before it is stopped.
TIMEOUT = 240


# ---------------------------------------------------------------------------------------------------- models


def box_case(faces, size, top_scale=1.0):
    """A box centered on the bed with whole faces painted: (vertices, [(a, b, c, code)])."""
    dx, dy, dz = size
    verts, tris = paint3mf.box(-dx / 2, dx / 2, -dy / 2, dy / 2, 0, dz)
    verts = [(128 + x * (top_scale if z > 0 else 1), 128 + y * (top_scale if z > 0 else 1), z) for x, y, z in verts]
    return verts, [(a, b, c, paint3mf.paint_code(faces.get(face, 0))) for (a, b, c), face in tris]


CASES = {
    "faces2": (lambda: box_case({"top": 2, "right": 2}, (20.0, 20.0, 10.0)), 2),
    "faces4": (lambda: box_case({"front": 2, "back": 3, "left": 4, "top": 2}, (24.0, 18.0, 12.0)), 4),
    "slant3": (lambda: box_case({"front": 2, "right": 3, "back": 2}, (20.0, 20.0, 10.0), top_scale=1.4), 3),
}


def _mul(a, b):
    """3MF transforms (12 numbers, rows of a 4x3 matrix): `a` then `b`."""
    m = [a[0:3], a[3:6], a[6:9], a[9:12]]
    n = [b[0:3], b[3:6], b[6:9], b[9:12]]
    out = []
    for r in range(4):
        row = [sum(m[r][k] * n[k][c] for k in range(3)) + (n[3][c] if r == 3 else 0.0) for c in range(3)]
        out.extend(row)
    return out


IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]


def flatten_project(path):
    """A project's printable objects as one painted mesh centered on the bed: (vertices, triangles, filaments)."""
    z = zipfile.ZipFile(path)
    names = set(z.namelist())
    settings = z.read("Metadata/model_settings.config").decode("utf-8", "replace") if "Metadata/model_settings.config" in names else ""
    # the filament of each object and part id
    extruder, owner = {}, None
    for m in re.finditer(r"<(object|part)\s+id=\"(\d+)\"|<metadata key=\"extruder\" value=\"(\d+)\"|</part>", settings):
        if m.group(1):
            owner = (m.group(1), int(m.group(2)))
        elif m.group(3) and owner:
            extruder[owner] = int(m.group(3))
    project = json.loads(z.read("Metadata/project_settings.config")) if "Metadata/project_settings.config" in names else {}
    count = max(len(project.get("filament_colour", [])), 1)
    models = {}

    def model(name):
        if name not in models:
            xml = z.read(name).decode("utf-8", "replace")
            objs = {}
            for om in re.finditer(r"<object\s+id=\"(\d+)\"(.*?)</object>", xml, re.S):
                body = om.group(2)
                verts = [tuple(float(v) for v in vm.groups()) for vm in re.finditer(r"<vertex x=\"([^\"]+)\" y=\"([^\"]+)\" z=\"([^\"]+)\"", body)]
                tris = []
                for tm in re.finditer(r"<triangle ([^>]*?)/>", body):
                    attr = dict(re.findall(r"(\S+?)=\"([^\"]*)\"", tm.group(1)))
                    tris.append((int(attr["v1"]), int(attr["v2"]), int(attr["v3"]), attr.get("paint_color") or None))
                comps = []
                for cm in re.finditer(r"<component ([^>]*?)/>", body):
                    attr = dict(re.findall(r"(\S+?)=\"([^\"]*)\"", cm.group(1)))
                    t = [float(v) for v in attr.get("transform", "").split()] or IDENT
                    comps.append((int(attr["objectid"]), attr.get("p:path", "").lstrip("/") or name, t))
                objs[int(om.group(1))] = (verts, tris, comps)
            build = []
            for im in re.finditer(r"<item ([^>]*?)/>", xml):
                attr = dict(re.findall(r"(\S+?)=\"([^\"]*)\"", im.group(1)))
                if attr.get("printable", "1") != "0":
                    build.append((int(attr["objectid"]), [float(v) for v in attr.get("transform", "").split()] or IDENT))
            models[name] = (objs, build)
        return models[name]

    out_v, out_t = [], []

    def place(name, oid, t, top, default):
        objs, _ = model(name)
        verts, tris, comps = objs[oid]
        own = extruder.get(("part", oid), default)
        base = len(out_v)
        for x, y, zz in verts:
            out_v.append((x * t[0] + y * t[3] + zz * t[6] + t[9], x * t[1] + y * t[4] + zz * t[7] + t[10], x * t[2] + y * t[5] + zz * t[8] + t[11]))
        for a, b, c, code in tris:
            out_t.append((base + a, base + b, base + c, code if code else (paint3mf.paint_code(own) if own > 1 else None)))
        for cid, cpath, ct in comps:
            place(cpath, cid, _mul(ct, t), top, own)

    root = "3D/3dmodel.model"
    for oid, t in model(root)[1]:
        place(root, oid, t, oid, extruder.get(("object", oid), 1))
    xs, ys, zs = [v[0] for v in out_v], [v[1] for v in out_v], [v[2] for v in out_v]
    dx, dy, dz = 128 - (min(xs) + max(xs)) / 2, 128 - (min(ys) + max(ys)) / 2, -min(zs)
    return [(x + dx, y + dy, zz + dz) for x, y, zz in out_v], out_t, count


def write_3mf(path, verts, tris, project=None, bambu_header=False):
    """One painted object in a plain 3MF, with project settings when given."""
    head = '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n'
    if bambu_header:
        head += ' <metadata name="Application">BambuStudio-02.08.02.61</metadata>\n <metadata name="BambuStudio:3mfVersion">1</metadata>\n'
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
        with z.open("3D/3dmodel.model", "w", force_zip64=True) as m:
            m.write((head + ' <resources>\n  <object id="1" name="painted" type="model">\n   <mesh>\n    <vertices>\n').encode())
            m.write("".join(f'     <vertex x="{x:.6g}" y="{y:.6g}" z="{zz:.6g}"/>\n' for x, y, zz in verts).encode())
            m.write(b"    </vertices>\n    <triangles>\n")
            m.write("".join(f'     <triangle v1="{a}" v2="{b}" v3="{c}"' + (f' paint_color="{code}"' if code else "") + "/>\n"
                            for a, b, c, code in tris).encode())
            m.write(b'    </triangles>\n   </mesh>\n  </object>\n </resources>\n <build>\n  <item objectid="1" printable="1"/>\n </build>\n</model>\n')
        z.writestr("Metadata/model_settings.config", '<?xml version="1.0" encoding="UTF-8"?><config><object id="1"><metadata key="name" value="painted"/>'
                   '<metadata key="extruder" value="1"/></object></config>')
        if project:
            z.writestr("Metadata/project_settings.config", json.dumps(project))


def filament_lists(n):
    """Per-filament project keys for n filaments: Orca 2.4.2 needs them in the file to slice several filaments."""
    return {"filament_colour": COLORS[:n], "filament_type": ["PLA"] * n, "filament_is_support": ["0"] * n,
            "filament_diameter": ["1.75"] * n, "nozzle_temperature": ["220"] * n,
            "nozzle_temperature_initial_layer": ["220"] * n, "filament_settings_id": [FILAMENT] * n,
            "filament_flow_ratio": ["0.98"] * n,
            "flush_volumes_matrix": [("0" if i == j else "280") for i in range(n) for j in range(n)],
            "flush_volumes_vector": ["140"] * (2 * n)}


# ---------------------------------------------------------------------------------------------------- slicers


def run_orca(orca, work, model3mf, n):
    """OrcaSlicer on the P1S presets (flattened: its CLI keeps only what a user preset lists) with n filaments."""
    out = os.path.join(work, "orca")
    os.makedirs(out, exist_ok=True)
    files = {}
    for kind, name in (("machine", MACHINE), ("process", PROCESS), ("filament", FILAMENT)):
        d = profile_parity.flatten("BBL", kind, name)
        d.update({"type": kind, "name": f"paint {kind}", "from": "User", "inherits": name})
        if kind != "machine":
            d.update({"compatible_printers": ["paint machine", MACHINE]})
            d.pop("compatible_printers_condition", None)
        if kind == "filament":
            d["filament_is_support"] = ["0"]
        files[kind] = os.path.join(work, f"orca-{kind}.json")
        json.dump(d, open(files[kind], "w"))
    fil = json.load(open(files["filament"]))
    paths = [files["filament"]]
    for i in range(1, n):
        p = os.path.join(work, f"orca-filament-{i + 1}.json")
        json.dump(dict(fil, name=f"paint filament {i + 1}", filament_colour=[COLORS[i]]), open(p, "w"))
        paths.append(p)
    cmd = [orca, "--slice", "0", "--arrange", "0", "--outputdir", out, "--load-settings", f"{files['machine']};{files['process']}",
           "--load-filaments", ";".join(paths), model3mf]
    m = measure.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=TIMEOUT)
    return os.path.join(out, "plate_1.gcode"), m


def run_sx(sx, work, model3mf, orca_gcode):
    """SlicerX with every setting Orca resolved for the same file."""
    cfg = profile_parity.sx_config_from_block(profile_parity.config_block(orca_gcode))
    out = os.path.join(work, "sx")
    os.makedirs(out, exist_ok=True)
    rp = os.path.join(work, "sx-request.json")
    json.dump({"schemaVersion": 1, "meshes": {"m": os.path.abspath(model3mf)}, "plate": {"objects": [{"id": "m", "mesh": "m"}]},
               "config": cfg, "options": {"trustedGcode": True}}, open(rp, "w"))
    m = measure.run([sx, "slice", "--request", rp, "--out-dir", out], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=TIMEOUT)
    made = [f for f in os.listdir(out) if f.endswith(".gcode")]
    return (os.path.join(out, made[0]) if made else None), m


def run_bambu(bambu_path, work, verts, tris, n):
    """Bambu Studio on its own P1S presets with n filaments, from a project it accepts (slicers.Bambu's way)."""
    b = slicers.Bambu(bambu_path)
    b.profiles = b._find_profiles()
    # its own defaults first, through a project with only a printer name and a plain box
    seed = os.path.join(work, "bambu-seed.3mf")
    sv, st = box_case({}, (20.0, 20.0, 20.0))
    write_3mf(seed, sv, st, {"printer_settings_id": MACHINE})
    out = os.path.join(work, "bambu-seed-out")
    os.makedirs(out, exist_ok=True)
    defaults = os.path.join(out, "defaults.json")
    measure.run([b.path, "--export-settings", defaults, "--outputdir", out, os.path.abspath(seed)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=TIMEOUT)
    if not os.path.exists(defaults):
        return None, {"wall_ms": 0, "rc": None, "rss_mb": None, "cpu_s": None}
    cfg = json.load(open(defaults))
    fil = b._resolve("filament", FILAMENT)
    for kind, name in (("machine", MACHINE), ("process", PROCESS), ("filament", FILAMENT)):
        cfg.update(b._resolve(kind, name))
    # every filament key once per filament
    for k, v in fil.items():
        if isinstance(v, list) and len(v) == 1 and isinstance(cfg.get(k), list):
            cfg[k] = v * n
    cfg.update(filament_lists(n))
    cfg.update({"version": "02.01.01.52", "from": "project", "name": "project_settings", "print_settings_id": PROCESS,
                "printer_settings_id": MACHINE, "filament_settings_id": [FILAMENT] * n, "inherits_group": [PROCESS] + [""] * (n + 1)})
    proj = os.path.join(work, "bambu.3mf")
    write_3mf(proj, verts, tris, cfg, bambu_header=True)
    d = os.path.join(work, "bambu")
    os.makedirs(d, exist_ok=True)
    m = measure.run([b.path, "--slice", "1", "--outputdir", d, os.path.abspath(proj)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    timeout=TIMEOUT)
    return os.path.join(d, "plate_1.gcode"), m


# ---------------------------------------------------------------------------------------------------- reading


def read(path):
    """{"layers": [{"mm": {tool: mm}, "cells": {cell: {tool: samples}}}], "total": {tool: mm}} for the model's own
    features."""
    layers, tool, kind, rel, e = [], 0, "", False, 0.0
    x = y = None
    cur = None
    with open(path, errors="replace") as f:
        for ln in f:
            if ln.startswith(";"):
                t = plain(ln)
                if t.startswith(";TYPE:"):
                    kind = t[6:].strip()
                elif t.startswith("; FEATURE:"):
                    kind = t[10:].strip()
                elif is_layer_mark(ln):
                    cur = {"mm": {}, "cells": {}}
                    layers.append(cur)
                continue
            w = ln.split(";", 1)[0].split()
            if not w:
                continue
            g = w[0]
            if g[0] == "T" and g[1:].isdigit() and int(g[1:]) < 64:
                tool = int(g[1:])
                continue
            if g == "M82":
                rel = False
            elif g == "M83":
                rel = True
            if g not in ("G0", "G1", "G2", "G3", "G92"):
                continue
            v = {t[0]: t[1:] for t in w[1:] if len(t) > 1}
            try:
                nx = float(v["X"]) if "X" in v else x
                ny = float(v["Y"]) if "Y" in v else y
                ev = float(v["E"]) if "E" in v else None
            except ValueError:
                continue
            if g == "G92":
                e = ev if ev is not None else e
                continue
            d = 0.0
            if ev is not None:
                d = ev if rel else ev - e
                e = e if rel else ev
            if d > 0 and cur is not None and x is not None and nx is not None and (nx != x or ny != y) and not NOT_MODEL.search(kind):
                cur["mm"][tool] = cur["mm"].get(tool, 0.0) + d
                length = math.hypot(nx - x, ny - y)
                steps = max(1, int(length / (CELL / 4)))
                for s in range(steps):
                    px, py = x + (nx - x) * (s + 0.5) / steps, y + (ny - y) * (s + 0.5) / steps
                    by = cur["cells"].setdefault((math.floor(px / CELL), math.floor(py / CELL)), {})
                    by[tool] = by.get(tool, 0) + 1
            x, y = nx, ny
    layers = [l for l in layers if l["mm"]]
    total = {}
    for l in layers:
        for t, mm in l["mm"].items():
            total[t] = total.get(t, 0.0) + mm
    # each cell's filament: the one whose beads pass over it most
    for l in layers:
        l["cells"] = {c: max(by, key=lambda t: (by[t], -t)) for c, by in l["cells"].items()}
    return {"layers": layers, "total": total}


def centered(r):
    """Cells moved so the first layer's cells center on 0, 0."""
    if not r["layers"]:
        return r
    first = r["layers"][0]["cells"]
    cx = round((min(c[0] for c in first) + max(c[0] for c in first)) / 2)
    cy = round((min(c[1] for c in first) + max(c[1] for c in first)) / 2)
    for l in r["layers"]:
        l["cells"] = {(a - cx, b - cy): t for (a, b), t in l["cells"].items()}
    return r


def agreement(a, b):
    """Per filament, over all layers: of the cells both print where either gives that filament, the share where
    both do."""
    both, either = {}, {}
    for la, lb in zip(a["layers"], b["layers"]):
        ca, cb = la["cells"], lb["cells"]
        for c in ca.keys() & cb.keys():
            ta, tb = ca[c], cb[c]
            for t in {ta, tb}:
                either[t] = either.get(t, 0) + 1
                both[t] = both.get(t, 0) + (ta == tb)
    return {t: both[t] / either[t] for t in either}


# ---------------------------------------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sx", required=True)
    ap.add_argument("--orca", required=True)
    ap.add_argument("--bambu", default="")
    ap.add_argument("--cases", default=",".join(CASES))
    ap.add_argument("--file", action="append", default=[], help="a Bambu Studio or Orca project with paint")
    ap.add_argument("--workdir", default="paint-work")
    ap.add_argument("--out", default="paint-results.json")
    ap.add_argument("--tol", type=float, default=0.05)
    ap.add_argument("--overlap", type=float, default=0.9)
    a = ap.parse_args()
    # the Orca presets next to the given binary
    for up in range(4):
        cand = os.path.join(os.path.dirname(os.path.abspath(a.orca)), *([".."] * up), "resources", "profiles")
        if os.path.isdir(cand):
            profile_parity.PROFILE_DIRS.append(os.path.abspath(cand))
            break
    jobs = [(c, *CASES[c]) for c in a.cases.split(",") if c]
    for f in a.file:
        jobs.append((os.path.splitext(os.path.basename(f))[0], (lambda f=f: flatten_project(f)[:2]), flatten_project(f)[2]))
    results, bad = [], 0
    for name, build, n in jobs:
        work = os.path.abspath(os.path.join(a.workdir, name))
        os.makedirs(work, exist_ok=True)
        verts, tris = build()
        model3mf = os.path.join(work, "painted.3mf")
        write_3mf(model3mf, verts, tris, filament_lists(n))
        og, om = run_orca(a.orca, work, model3mf, n)
        if not os.path.exists(og):
            print(f"ERROR {name}: Orca wrote no G-code")
            bad += 1
            continue
        sg, sm = run_sx(a.sx, work, model3mf, og)
        runs = {"orca": (og, om), "sx": (sg, sm)}
        if a.bambu:
            runs["bambu"] = run_bambu(a.bambu, work, verts, tris, n)
        read_ = {k: centered(read(g)) for k, (g, _) in runs.items() if g and os.path.exists(g)}
        if "sx" not in read_:
            print(f"ERROR {name}: SlicerX wrote no G-code")
            bad += 1
            continue
        ref = read_["orca"]
        res = {"case": name, "filaments": n, "triangles": len(tris), "painted": sum(1 for t in tris if t[3]),
               "runs": {k: {"wall_ms": round(m["wall_ms"]), "peak_mb": m["rss_mb"] and round(m["rss_mb"]), "cpu_s": m["cpu_s"],
                            "timed_out": m["rc"] is None} for k, (_, m) in runs.items()},
               "layers": {k: len(r["layers"]) for k, r in read_.items()},
               "total_mm": {k: {str(t): round(v, 1) for t, v in sorted(r["total"].items())} for k, r in read_.items()},
               "overlap_vs_orca": {k: {str(t): round(v, 3) for t, v in sorted(agreement(r, ref).items())} for k, r in read_.items() if k != "orca"}}
        ok = True
        for t in set(ref["total"]) | set(read_["sx"]["total"]):
            x, y = read_["sx"]["total"].get(t, 0.0), ref["total"].get(t, 0.0)
            ok &= abs(x - y) <= max(a.tol * y, 20.0)
        ok &= all(v >= a.overlap for v in agreement(read_["sx"], ref).values())
        res["ok"] = ok
        bad += not ok
        results.append(res)
        print(("ok   " if ok else "FAIL ") + f"{name}: {n} filaments, {res['painted']} of {res['triangles']} triangles painted, layers {res['layers']}")
        for k in ("sx", "bambu"):
            if k in read_:
                print(f"       {k:5} filament mm by tool {res['total_mm'][k]}  orca {res['total_mm']['orca']}")
                print(f"       {k:5} placement agreeing with orca by tool {res['overlap_vs_orca'][k]}")
        # Bambu Studio's command line sometimes stays open after writing its G-code until it is stopped.
        print("       time and peak memory: " + ", ".join(
            f"{k} {'stopped after ' if v['timed_out'] else ''}{v['wall_ms']} ms {v['peak_mb']} MB" for k, v in res["runs"].items()))
    json.dump({"cases": results}, open(a.out, "w"), indent=1)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
