#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Parity check for print by object: two boxes, one tall and one short, sliced by object.

    python3 parity_sequence.py --sx path/to/sx --orca path/to/OrcaSlicer --workdir seq-work

Both slicers get the same two objects at the same places (SlicerX as a request with two
objects, OrcaSlicer as a 3MF with two build items). Compared: layer count, the height of
every layer in order, filament length, and which object each stretch of layers belongs to.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import zipfile

import models as model_lib
import parity
import settings
import slicers
from gcode import is_layer_mark, plain

OBJECTS = [("tall", 90.0, 128.0, 20.0), ("short", 170.0, 128.0, 6.0)]


def box(h):
    return model_lib._box(-10, 10, -10, 10, 0, h)


def write_3mf(path, objects, settings=None, project=None):
    items, res = [], []
    for i, (name, cx, cy, h) in enumerate(objects, start=1):
        tris = box(h)
        verts, idx = [], []
        for t in tris:
            for v in t:
                if v not in verts:
                    verts.append(v)
            idx.append(tuple(verts.index(v) for v in t))
        vx = "".join(f'<vertex x="{x}" y="{y}" z="{z}"/>' for x, y, z in verts)
        tx = "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in idx)
        res.append(f'<object id="{i}" name="{name}" type="model"><mesh><vertices>{vx}</vertices><triangles>{tx}</triangles></mesh></object>')
        items.append(f'<item objectid="{i}" transform="1 0 0 0 1 0 0 0 1 {cx} {cy} 0"/>')
    model = ('<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" '
             'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>'
             + "".join(res) + "</resources><build>" + "".join(items) + "</build></model>")
    types = ('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
             '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
             '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", types)
        z.writestr("_rels/.rels", rels)
        z.writestr("3D/3dmodel.model", model)
        if project:
            z.writestr("Metadata/project_settings.config", json.dumps(project))
        if settings:
            rows = "".join(
                f'<object id="{i}"><metadata key="name" value="{name}"/>'
                + "".join(f'<metadata key="{k}" value="{v}"/>' for k, v in settings.get(name, {}).items())
                + "</object>"
                for i, (name, *_rest) in enumerate(objects, start=1))
            z.writestr("Metadata/model_settings.config", f'<?xml version="1.0" encoding="UTF-8"?><config>{rows}</config>')


def layer_zs(path):
    return [float(m.group(1)) for ln in open(path, errors="replace") if (m := re.match(r";Z:([\d.]+)", plain(ln)))]


def first_x_per_layer(path):
    """Mean x of the extruding moves of each layer, to tell which object a layer belongs to."""
    out, cur = [], None
    with open(path, errors="replace") as f:
        for ln in f:
            if is_layer_mark(ln):
                cur = []
                out.append(cur)
            elif cur is not None and ln.startswith("G1") and " E" in ln and " X" in ln:
                m = re.search(r" X([\d.]+)", ln)
                if m and re.search(r" E[\d.]", ln):
                    cur.append(float(m.group(1)))
    return [sum(v) / len(v) if v else None for v in out]


def feature_mm_by_side(path, split_x):
    """Filament mm per feature on each side of `split_x`, read the same way for both slicers."""
    rel, e, kind = False, 0.0, ""
    out = {}
    with open(path, errors="replace") as f:
        for ln in map(plain, f):
            if ln.startswith(";TYPE:"):
                kind = ln[6:].strip()
                continue
            w = ln.split(";", 1)[0].split()
            if not w:
                continue
            if w[0] == "M82":
                rel = False
            elif w[0] == "M83":
                rel = True
            if w[0] not in ("G0", "G1", "G92"):
                continue
            f_ = {t[0]: t[1:] for t in w[1:] if len(t) > 1}
            if w[0] == "G92":
                if "E" in f_:
                    e = float(f_["E"])
                continue
            if "E" not in f_:
                continue
            v = float(f_["E"])
            d = v if rel else v - e
            e = 0.0 if rel else v
            if d > 0 and "X" in f_:
                key = (kind, float(f_["X"]) > split_x)
                out[key] = out.get(key, 0.0) + d
    return out


def per_object_settings(a, sx, orca_path):
    """Two boxes side by side; the right one carries its own walls and infill density."""
    d = os.path.abspath(a.workdir)
    os.makedirs(os.path.join(d, "models"), exist_ok=True)
    objs = [("left", 90.0, 128.0, 6.0), ("right", 170.0, 128.0, 6.0)]
    own = {"wall_loops": 5, "sparse_infill_density": "60%"}
    cfg = settings.sx_config()
    cfg["slow_down_for_layer_cooling"] = False
    plate, meshes = [], {}
    for name, cx, cy, h in objs:
        p = os.path.join(d, "models", f"{name}.stl")
        model_lib.write_stl(p, box(h))
        meshes[name] = p
        o = {"id": name, "mesh": name, "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, cx, cy, 0, 1]}
        if name == "right":
            o["settings"] = {"wall_loops": 5, "sparse_infill_density": 60}
        plate.append(o)
    rp = os.path.join(d, "request.json")
    json.dump({"schemaVersion": 1, "meshes": meshes, "plate": {"objects": plate}, "config": cfg, "options": {"flavor": "marlin2"}}, open(rp, "w"))
    out = os.path.join(d, "sx")
    subprocess.run([sx, "slice", "--request", rp, "--out-dir", out], capture_output=True, check=True)
    orca = parity.ParityOrca(orca_path, parity.ORCA_ONLY)
    m3 = os.path.join(d, "models", "two.3mf")
    write_3mf(m3, objs, {"right": own})
    orca.prepare(d, {"cube": os.path.join(d, "models", "left.stl")})
    od = os.path.join(d, "orca")
    os.makedirs(od, exist_ok=True)
    for f in os.listdir(od):
        os.remove(os.path.join(od, f))
    r = subprocess.run(orca._cmd(m3, od, ["--debug", "1", "--arrange", "0"]), capture_output=True, text=True)
    og = os.path.join(od, "plate_1.gcode")
    if not os.path.exists(og):
        print("Orca produced no G-code:", (r.stdout + r.stderr)[-600:])
        return 1
    A, B = feature_mm_by_side(os.path.join(out, "slice.gcode"), 128.0), feature_mm_by_side(og, 128.0)
    ok = True
    for feat in ("Outer wall", "Inner wall", "Sparse infill", "Internal solid infill", "Top surface", "Bottom surface"):
        for right in (False, True):
            x, y = A.get((feat, right), 0.0), B.get((feat, right), 0.0)
            good = abs(x - y) <= max(0.12 * y, 8.0)
            ok &= good
            print(f"{'ok  ' if good else 'FAIL'} {feat + (' (right, own settings)' if right else ' (left)'):<44} sx {x:8.1f}  orca {y:8.1f}")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--object-settings", action="store_true", help="check per-object settings instead of print by object")
    ap.add_argument("--sx")
    ap.add_argument("--orca")
    ap.add_argument("--workdir", default="seq-work")
    ap.add_argument("--gap", type=float, default=0.0, help="move the second object so the boxes are this far apart (0 keeps 60)")
    ap.add_argument("--orca-set", action="append", default=[], help="Orca process key=value")
    ap.add_argument("--orca-machine", action="append", default=[], help="Orca machine key=value")
    ap.add_argument("--reverse", action="store_true", help="list the short object first")
    a = ap.parse_args()
    if a.gap:
        OBJECTS[1] = (OBJECTS[1][0], OBJECTS[0][1] + 20.0 + a.gap, OBJECTS[1][2], OBJECTS[1][3])
    if a.reverse:
        OBJECTS.reverse()
    sx, orca_path = slicers.SlicerX(a.sx).path, slicers.Orca(a.orca).path
    if a.object_settings:
        return per_object_settings(a, sx, orca_path)
    d = os.path.abspath(a.workdir)
    os.makedirs(os.path.join(d, "models"), exist_ok=True)
    cfg = settings.sx_config()
    cfg["slow_down_for_layer_cooling"] = False
    cfg["print_sequence"] = "by object"
    plate, meshes = [], {}
    for name, cx, cy, h in OBJECTS:
        p = os.path.join(d, "models", f"{name}.stl")
        model_lib.write_stl(p, box(h))
        meshes[name] = p
        plate.append({"id": name, "mesh": name, "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, cx, cy, 0, 1]})
    req = {"schemaVersion": 1, "meshes": meshes, "plate": {"objects": plate}, "config": cfg, "options": {"flavor": "marlin2"}}
    rp = os.path.join(d, "request.json")
    json.dump(req, open(rp, "w"))
    out = os.path.join(d, "sx")
    subprocess.run([sx, "slice", "--request", rp, "--out-dir", out], capture_output=True, check=True)
    sxg = os.path.join(out, "slice.gcode")
    orca = parity.ParityOrca(orca_path, {**parity.ORCA_ONLY, "print_sequence": "by object", **dict(t.split("=", 1) for t in a.orca_set)})
    m3 = os.path.join(d, "models", "two.3mf")
    write_3mf(m3, OBJECTS)
    orca.prepare(d, {"cube": os.path.join(d, "models", "tall.stl")})
    if a.orca_machine:
        mach = json.load(open(orca.files["machine"]))
        mach.update(dict(t.split("=", 1) for t in a.orca_machine))
        json.dump(mach, open(orca.files["machine"], "w"))
    od = os.path.join(d, "orca")
    os.makedirs(od, exist_ok=True)
    r = subprocess.run(orca._cmd(m3, od, ["--debug", "1", "--arrange", "0"]), capture_output=True, text=True)
    og = os.path.join(od, "plate_1.gcode")
    if not os.path.exists(og):
        print("Orca produced no G-code:", (r.stdout + r.stderr)[-600:])
        return 1
    A, B = parity.parse(sxg), parity.parse(og)
    za, zb = layer_zs(sxg), layer_zs(og)
    xa, xb = first_x_per_layer(sxg), first_x_per_layer(og)
    ok = True
    def row(what, s, o, good):
        nonlocal ok
        ok &= good
        print(f"{'ok  ' if good else 'FAIL'} {what:<28} sx {s}  orca {o}")
    row("layers", A["layers"], B["layers"], A["layers"] == B["layers"])
    row("layer heights in order", len(za), len(zb), len(za) == len(zb) and all(abs(p - q) < 1e-3 for p, q in zip(za, zb)))
    row("total filament mm", round(A["total_mm"], 1), round(B["total_mm"], 1), abs(A["total_mm"] - B["total_mm"]) <= 0.07 * B["total_mm"])
    first_x = OBJECTS[0][1]
    side = lambda xs: "".join("A" if x is not None and abs(x - first_x) < 40 else "B" if x is not None else "-" for x in xs)
    row("object per layer", side(xa)[:8] + ".." + side(xa)[-8:], side(xb)[:8] + ".." + side(xb)[-8:], side(xa) == side(xb))
    for feat in ("Outer wall", "Inner wall", "Sparse infill", "Skirt", "Brim"):
        fa, fb = A["features"].get(feat), B["features"].get(feat)
        if fa or fb:
            ma, mb = (fa or {"mm": 0})["mm"], (fb or {"mm": 0})["mm"]
            row(f"{feat} mm", round(ma, 1), round(mb, 1), abs(ma - mb) <= max(0.15 * mb, 15.0))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
