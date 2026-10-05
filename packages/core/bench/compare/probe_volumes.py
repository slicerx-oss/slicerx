#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Parity check for modifier volumes: a box with a modifier over its right half that changes the walls
and infill density there, sliced by SlicerX and OrcaSlicer (the modifier goes into the 3MF as a
`modifier_part` with its own settings).

    python3 probe_volumes.py --sx path/to/sx --orca path/to/OrcaSlicer --workdir vol-work
"""
import argparse
import json
import os
import subprocess
import sys
import zipfile

import models as model_lib
import parity
import parity_sequence as seq
import settings
import slicers
from gcode import plain


def mesh_xml(tris):
    verts, idx = [], []
    for t in tris:
        for v in t:
            if v not in verts:
                verts.append(v)
        idx.append(tuple(verts.index(v) for v in t))
    vx = "".join(f'<vertex x="{x}" y="{y}" z="{z}"/>' for x, y, z in verts)
    tx = "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in idx)
    return f"<mesh><vertices>{vx}</vertices><triangles>{tx}</triangles></mesh>"


def write_3mf(path, body, vol, vol_settings, role, cx, cy):
    model = ('<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" '
             'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>'
             f'<object id="1" type="model">{mesh_xml(body)}</object>'
             f'<object id="2" type="model">{mesh_xml(vol)}</object>'
             '<object id="3" type="model"><components><component objectid="1"/><component objectid="2"/></components></object>'
             f'</resources><build><item objectid="3" transform="1 0 0 0 1 0 0 0 1 {cx} {cy} 0"/></build></model>')
    types = ('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
             '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
             '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
    ident = "1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"
    meta = "".join(f'<metadata key="{k}" value="{v}"/>' for k, v in vol_settings.items())
    cfg = ('<?xml version="1.0" encoding="UTF-8"?><config><object id="3"><metadata key="name" value="volumes"/>'
           f'<part id="1" subtype="normal_part"><metadata key="name" value="body"/><metadata key="matrix" value="{ident}"/></part>'
           f'<part id="2" subtype="{role}"><metadata key="name" value="vol"/><metadata key="matrix" value="{ident}"/>{meta}</part>'
           '</object></config>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", types)
        z.writestr("_rels/.rels", rels)
        z.writestr("3D/3dmodel.model", model)
        z.writestr("Metadata/model_settings.config", cfg)


def write_painted_supports(path, body, code, cx, cy):
    """The body as one object; the triangles of its underside at z = 10 carry `paint_supports`."""
    verts, idx = [], []
    for t in body:
        for v in t:
            if v not in verts:
                verts.append(v)
        idx.append(tuple(verts.index(v) for v in t))
    vx = "".join(f'<vertex x="{x}" y="{y}" z="{z}"/>' for x, y, z in verts)
    rows = []
    for t, (a, b, c) in zip(body, idx):
        down = all(abs(v[2] - 10.0) < 1e-6 for v in t) and (t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1]) < 0
        attr = f' paint_supports="{code}"' if down else ""
        rows.append(f'<triangle v1="{a}" v2="{b}" v3="{c}"{attr}/>')
    model = ('<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" '
             'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>'
             f'<object id="1" type="model"><mesh><vertices>{vx}</vertices><triangles>{"".join(rows)}</triangles></mesh></object>'
             f'</resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 {cx} {cy} 0"/></build></model>')
    types = ('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
             '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
             '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", types)
        z.writestr("_rels/.rels", rels)
        z.writestr("3D/3dmodel.model", model)


def side_mm(gcode, split_x):
    """Filament per feature on each side of x = split_x. A move that crosses the line is split in proportion
    to its length on each side, so the result does not depend on which way the slicer runs a line."""
    rel, e, kind, out = False, 0.0, "", {}
    x = None
    for ln in map(plain, open(gcode, errors="replace")):
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
        f = {t[0]: t[1:] for t in w[1:] if len(t) > 1}
        if w[0] == "G92":
            e = float(f["E"]) if "E" in f else e
            continue
        nx = float(f["X"]) if "X" in f else x
        if "E" in f:
            v = float(f["E"])
            d = v if rel else v - e
            e = 0.0 if rel else v
            if d > 0 and "X" in f:
                x0 = nx if x is None else x
                if (x0 - split_x) * (nx - split_x) < 0:
                    t = (split_x - x0) / (nx - x0)
                    first, second = d * t, d * (1 - t)
                    for part, right in ((first, x0 > split_x), (second, nx > split_x)):
                        out[(kind, right)] = out.get((kind, right), 0.0) + part
                else:
                    k = (kind, nx > split_x)
                    out[k] = out.get(k, 0.0) + d
        x = nx
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sx")
    ap.add_argument("--orca")
    ap.add_argument("--workdir", default="vol-work")
    ap.add_argument("--walls", type=int, default=5)
    ap.add_argument("--density", type=int, default=60)
    ap.add_argument("--shells", type=int, help="top and bottom shell layers inside the modifier")
    ap.add_argument("--line-width", type=float, help="line width inside the modifier, mm")
    ap.add_argument("--pattern", help="sparse infill pattern inside the modifier")
    ap.add_argument("--height", type=float, default=6.0, help="height of the body, mm")
    ap.add_argument("--sparse", help="sparse infill pattern of the object on both sides (the slicers' names differ for zig-zag)")
    ap.add_argument("--plain", action="store_true", help="with --hole: move the hole away from the block, for the same block without one")
    ap.add_argument("--hole", action="store_true", help="negative role: a 30 mm block with a 10 mm square hole through it, compared as totals")
    ap.add_argument("--vol-box", help="x0,x1,y0,y1 of a support blocker or enforcer around the centered table, mm")
    ap.add_argument("--role", default="modifier", help="modifier, support_blocker, support_enforcer, negative, paint_enforcer or paint_blocker")
    a = ap.parse_args()
    d = os.path.abspath(a.workdir)
    os.makedirs(os.path.join(d, "models"), exist_ok=True)
    sx = slicers.SlicerX(a.sx).path
    supports = a.role in ("support_blocker", "support_enforcer", "paint_enforcer", "paint_blocker")
    if supports:
        # The slab on two pillars, centered; the volume covers the right half of the gap under the slab.
        body = [tuple((x - 20, y - 10, z) for x, y, z in t) for t in
                model_lib._box(0, 8, 0, 20, 0, 10) + model_lib._box(32, 40, 0, 20, 0, 10) + model_lib._box(0, 40, 0, 20, 10, 12)]
        vol = model_lib._box(0, 22, -12, 12, -1, 13) if a.role in ("support_blocker", "paint_blocker") else model_lib._box(-22, 22, -12, 12, 9, 11)
        if a.vol_box:
            x0, x1, y0, y1 = (float(v) for v in a.vol_box.split(","))
            vol = model_lib._box(x0, x1, y0, y1, -1, 13)
        vs = {}
        painted = a.role.startswith("paint_")
    else:
        body = model_lib._box(-20, 20, -10, 10, 0, a.height)
        vol = model_lib._box(0, 30, -20, 20, -1, a.height + 1)
        if a.hole:
            body = model_lib._box(-15, 15, -15, 15, 0, a.height)
            vol = model_lib._box(-5, 5, -5, 5, -1, a.height + 1)
            if a.plain:
                vol = model_lib._box(60, 70, -5, 5, -1, a.height + 1)
        vs = {"wall_loops": a.walls, "sparse_infill_density": f"{a.density}%"}
        sx_vs = {"wall_loops": a.walls, "sparse_infill_density": a.density}
        if a.hole:
            vs, sx_vs = {}, {}
        if a.shells is not None:
            vs.update({"top_shell_layers": a.shells, "bottom_shell_layers": a.shells})
            sx_vs.update({"top_shell_layers": a.shells, "bottom_shell_layers": a.shells})
        if a.line_width:
            # Orca keeps a width per feature; SlicerX has one line width.
            for k in ("line_width", "outer_wall_line_width", "inner_wall_line_width", "sparse_infill_line_width",
                      "internal_solid_infill_line_width", "top_surface_line_width"):
                vs[k] = a.line_width
            sx_vs["line_width"] = a.line_width
        if a.pattern:
            vs["sparse_infill_pattern"] = a.pattern
            sx_vs["sparse_infill_pattern"] = a.pattern
    if supports and painted:
        write_painted_supports(os.path.join(d, "models", "v.3mf"), body, "4" if a.role == "paint_enforcer" else "8", 128.0, 128.0)
    sub = {"modifier": "modifier_part", "negative": "negative_part", "support_blocker": "support_blocker", "support_enforcer": "support_enforcer", "paint_enforcer": "", "paint_blocker": ""}[a.role]
    m3 = os.path.join(d, "models", "v.3mf")
    if not (supports and painted):
        write_3mf(m3, body, vol, vs, sub, 128.0, 128.0)
    bp, vp = os.path.join(d, "models", "body.stl"), os.path.join(d, "models", "vol.stl")
    model_lib.write_stl(bp, body)
    model_lib.write_stl(vp, vol)
    cfg = settings.sx_config()
    cfg["slow_down_for_layer_cooling"] = False
    if a.sparse:
        cfg["sparse_infill_pattern"] = a.sparse
    if supports:
        cfg.update({"enable_support": 1, "support_type": "normal(auto)", "support_style": "grid", "support_threshold_angle": 30,
                    "support_on_build_plate_only": 0, "support_object_xy_distance": 0.35, "support_top_z_distance": 0.2,
                    "support_bottom_z_distance": 0.2, "support_interface_top_layers": 2, "support_interface_bottom_layers": 0,
                    "support_base_pattern": "rectilinear", "support_base_pattern_spacing": 2.5, "support_interface_spacing": 0.5,
                    "support_speed": 150, "support_interface_speed": 80, "independent_support_layer_height": 0})
        if a.role in ("support_enforcer", "paint_enforcer"):
            cfg["support_threshold_angle"] = 0
    if supports and painted:
        req = {"schemaVersion": 1, "meshes": {"b": m3}, "plate": {"objects": [{"id": "o", "mesh": "b"}]},
               "config": cfg, "options": {"flavor": "marlin2"}}
    else:
        req = None
    req = req or {"schemaVersion": 1, "meshes": {"b": bp, "v": vp},
           "plate": {"objects": [{"id": "o", "mesh": "b", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 128, 128, 0, 1],
                                  "volumes": [{"role": a.role, "mesh": "v", "settings": ({} if supports else sx_vs)}]}]},
           "config": cfg, "options": {"flavor": "marlin2"}}
    rp = os.path.join(d, "request.json")
    json.dump(req, open(rp, "w"))
    out = os.path.join(d, "sx")
    subprocess.run([sx, "slice", "--request", rp, "--out-dir", out], capture_output=True, check=True)
    extra = dict(parity.ORCA_ONLY)
    if a.sparse:
        extra["sparse_infill_pattern"] = a.sparse
    if supports:
        extra.update({"enable_support": 1, "support_type": "normal(auto)", "support_style": "grid", "support_threshold_angle": 0 if a.role in ("support_enforcer", "paint_enforcer") else 30,
                      "support_on_build_plate_only": 0, "support_object_xy_distance": 0.35, "support_top_z_distance": 0.2, "support_bottom_z_distance": 0.2,
                      "support_interface_top_layers": 2, "support_interface_bottom_layers": 0, "support_base_pattern": "rectilinear",
                      "support_base_pattern_spacing": 2.5, "support_interface_spacing": 0.5, "support_speed": 150, "support_interface_speed": 80,
                      "independent_support_layer_height": 0})
    orca = parity.ParityOrca(slicers.Orca(a.orca).path, extra)
    orca.prepare(d, {"cube": bp})
    od = os.path.join(d, "orca")
    os.makedirs(od, exist_ok=True)
    for f in os.listdir(od):
        os.remove(os.path.join(od, f))
    r = subprocess.run(orca._cmd(m3, od, ["--debug", "1", "--arrange", "0"]), capture_output=True, text=True)
    og = os.path.join(od, "plate_1.gcode")
    if not os.path.exists(og):
        print("Orca produced no G-code:", (r.stdout + r.stderr)[-500:])
        return 1
    A, B = side_mm(os.path.join(out, "slice.gcode"), 128.0), side_mm(og, 128.0)
    ok = True
    if a.hole:
        for feat in ("Outer wall", "Inner wall", "Sparse infill", "Internal solid infill", "Top surface", "Bottom surface", "Internal Bridge"):
            x = A.get((feat, False), 0.0) + A.get((feat, True), 0.0)
            y = B.get((feat, False), 0.0) + B.get((feat, True), 0.0)
            print(f"{feat:<24} sx {x:8.1f}  orca {y:8.1f}")
        return 0
    feats = ("Support", "Support interface", "Outer wall") if supports else ("Outer wall", "Inner wall", "Sparse infill", "Internal solid infill", "Top surface", "Bottom surface")
    for feat in feats:
        for right in (False, True):
            x, y = A.get((feat, right), 0.0), B.get((feat, right), 0.0)
            good = abs(x - y) <= max(0.15 * y, 8.0)
            ok &= good
            print(f"{'ok  ' if good else 'FAIL'} {feat + (' (right, modifier)' if right else ' (left)'):<40} sx {x:8.1f}  orca {y:8.1f}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
