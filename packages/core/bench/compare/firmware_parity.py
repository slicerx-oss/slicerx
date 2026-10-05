#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Parity of the firmware output: SlicerX against OrcaSlicer on a two object plate.

    python3 firmware_parity.py --sx path/to/sx --orca path/to/OrcaSlicer [--workdir fw-work]

Slices two 20 mm cubes with both slicers and compares what firmware reads besides the
moves: Klipper `EXCLUDE_OBJECT_DEFINE` lines (names, centers, outlines) and the objects
printed on each layer, Marlin `M486` labels, OctoPrint style object comments, the
`M201` to `M205` machine limit lines, Bambu Lab `M624` labels, and the statistics footer (keys, filament used,
first and last `M73`). Exit code 1 when a check fails. Standard library only.
"""
import argparse
import base64
import json
import os
import re
import subprocess
import sys

import models as model_lib
import settings
from gcode import is_layer_mark

HERE = os.path.dirname(os.path.abspath(__file__))
LIMITS = {
    "machine_max_acceleration_x": "1000,1000", "machine_max_acceleration_y": "1000,1000",
    "machine_max_acceleration_z": "500,200", "machine_max_acceleration_e": "5000,5000",
    "machine_max_speed_x": "500,200", "machine_max_speed_y": "500,200", "machine_max_speed_z": "12,12",
    "machine_max_speed_e": "120,120", "machine_max_acceleration_extruding": "10000,10000",
    "machine_max_acceleration_retracting": "1500,1500", "machine_max_acceleration_travel": "10000,10000",
    "machine_max_jerk_x": "10,10", "machine_max_jerk_y": "10,10", "machine_max_jerk_z": "0.2,0.4",
    "machine_max_jerk_e": "2.5,2.5", "machine_max_junction_deviation": "0.01",
}


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def orca_slice(orca, work, flavor, extra_process, extra_machine, model="cube", copies=2):
    out = os.path.join(work, f"orca-{flavor}-" + str(abs(hash(json.dumps([sorted(extra_process.items()), sorted(extra_machine.items()), model, copies], default=str)))))
    args = [sys.executable, os.path.join(HERE, "orca_probe.py"), "--orca", orca, "--models", ",".join([model] * copies), "--flavor", flavor, "--out", out]
    for k, v in extra_process.items():
        args += ["--set", f"{k}={json.dumps(v) if isinstance(v, list) else v}"]
    for k, v in extra_machine.items():
        args += ["--machine", f"{k}={v}"]
    r = run(args)
    path = os.path.join(out, "orca", "plate_1.gcode")
    if not os.path.exists(path):
        raise RuntimeError(f"Orca produced no G-code: {r.stderr[-400:]}")
    return open(path, errors="replace").read()


def sx_slice(sx, work, flavor, config, centers, names, model="cube"):
    d = os.path.join(work, f"sx-{flavor}")
    os.makedirs(d, exist_ok=True)
    stl = os.path.join(d, "cube.stl")
    tris = model_lib.MODELS[model]()
    model_lib.write_stl(stl, tris)
    # Bounds of the generated cube, to center it on the wanted spot and set it on the bed.
    pts = [p for t in tris for p in t]
    lo = [min(p[i] for p in pts) for i in range(3)]
    hi = [max(p[i] for p in pts) for i in range(3)]
    objs = []
    for (cx, cy), name in zip(centers, names):
        t = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, cx - (lo[0] + hi[0]) / 2, cy - (lo[1] + hi[1]) / 2, -lo[2], 1]
        objs.append({"id": name, "name": name, "mesh": "cube", "transform": t})
    req = {"schemaVersion": 1, "meshes": {"cube": "cube.stl"}, "plate": {"objects": objs}, "config": config,
           "options": {"flavor": flavor}}
    rp = os.path.join(d, "request.json")
    json.dump(req, open(rp, "w"))
    r = run([sx, "slice", "--request", rp, "--out-dir", d])
    if r.returncode != 0:
        raise RuntimeError(f"sx failed: {r.stderr[-400:]}")
    return open(os.path.join(d, "slice.gcode"), errors="replace").read()


def defines(g):
    return [l for l in g.splitlines() if l.startswith("EXCLUDE_OBJECT_DEFINE")]


def same_defines(a, b, tol=0.2):
    """Same objects and centers; outline points differ (Orca simplifies the slice first), so its extent must agree within tol mm."""
    if len(a) != len(b):
        return False
    for x, y in zip(a, b):
        nx, ny = re.search(r"NAME=(\S+) CENTER=(\S+) ", x), re.search(r"NAME=(\S+) CENTER=(\S+) ", y)
        if not nx or not ny or nx.groups() != ny.groups():
            return False
        ex = [tuple(map(float, re.findall(r"[-\d.e+]+", p))) for p in re.findall(r"\[([^\[\]]+)\]", x.split("POLYGON=")[1])]
        ey = [tuple(map(float, re.findall(r"[-\d.e+]+", p))) for p in re.findall(r"\[([^\[\]]+)\]", y.split("POLYGON=")[1])]
        for i in (0, 1):
            if abs(min(p[i] for p in ex) - min(p[i] for p in ey)) > tol or abs(max(p[i] for p in ex) - max(p[i] for p in ey)) > tol:
                return False
    return True


def layers_of(g):
    """Layer index to the list of objects labeled in it, by label style."""
    out, cur = {}, -1
    for l in g.splitlines():
        if is_layer_mark(l):
            cur += 1
            out[cur] = []
        m = re.match(r"EXCLUDE_OBJECT_START NAME=(\S+)", l) or re.match(r"; printing object (\S+) id:", l)
        if m and cur >= 0:
            out[cur].append(m.group(1))
    return out


def m486_layers(g):
    out, cur = {}, -1
    for l in g.splitlines():
        if is_layer_mark(l):
            cur += 1
            out[cur] = []
        m = re.fullmatch(r"M486 S(\d+)", l)
        if m and cur >= 0:
            out[cur].append(int(m.group(1)))
    return out


def bambu_ids(g):
    m = re.search(r"^; model label id: ([\d,]+)$", g, re.M)
    return [int(v) for v in m.group(1).split(",")] if m else []


def bambu_layers(g):
    """Layer index to the places (in the label id list) of the objects labeled in it; None when a mask
    after a start line is not the bit of that object's place."""
    ids = sorted(bambu_ids(g))
    out, cur, lines = {}, -1, g.splitlines()
    for i, l in enumerate(lines):
        # Orca marks a Bambu Lab printer's layers with "; CHANGE_LAYER".
        if is_layer_mark(l):
            cur += 1
            out[cur] = []
        m = re.match(r"; start printing object, unique label id: (\d+)$", l)
        if m and cur >= 0:
            place = ids.index(int(m.group(1))) if int(m.group(1)) in ids else -1
            mask = int.from_bytes(base64.b64decode(lines[i + 1].split(" ")[1]), "little") if lines[i + 1].startswith("M624 ") else 0
            if place < 0 or mask != 1 << place:
                return None
            out[cur].append(place)
    return out


def stats(g):
    keys = {}
    for l in g.splitlines():
        m = re.match(r"; (filament used \[mm\]|filament used \[cm3\]|filament used \[g\]|total filament used \[g\]|total filament cost|total layers count|estimated printing time \(normal mode\)|estimated first layer printing time \(normal mode\)) = (.*)", l)
        if m:
            keys[m.group(1)] = m.group(2)
    m73 = [l for l in g.splitlines() if l.startswith("M73 P")]
    return keys, (m73[0] if m73 else None), (m73[-1] if m73 else None), len(m73)


def limits_block(g):
    # The block at the top; per-feature M204 lines during the print belong to the acceleration settings.
    return [l for l in g.splitlines() if re.match(r"M20[1345] ", l)][:5]


def check(name, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + name + (f"  {detail}" if detail and not ok else ""))
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sx", required=True)
    ap.add_argument("--orca", required=True)
    ap.add_argument("--workdir", default="fw-work")
    ap.add_argument("--model", default="cube", help="model from models.py, two copies")
    a = ap.parse_args()
    work = os.path.abspath(a.workdir)
    os.makedirs(work, exist_ok=True)
    ok = True
    base = settings.sx_config()
    base.update({"brim_width": 0, "slow_down_for_layer_cooling": False})

    # Klipper and OctoPrint style labels.
    og = orca_slice(a.orca, work, "klipper", {"exclude_object": 1, "gcode_label_objects": 1, "brim_type": "no_brim"}, {}, a.model)
    d = defines(og)
    centers = [tuple(float(v) for v in re.search(r"CENTER=([\d.]+),([\d.]+)", l).groups()) for l in d]
    names = [re.search(r"NAME=(\S+)_id_", l).group(1) for l in d]
    sg = sx_slice(a.sx, work, "klipper", {**base, "exclude_object": True, "gcode_label_objects": True}, centers, names, a.model)
    ok &= check("klipper EXCLUDE_OBJECT_DEFINE names, centers and outline extent", same_defines(defines(sg), d), f"\n  sx   {defines(sg)[0][:300]}\n  orca {d[0][:300]}")
    if a.model == "cube":
        ok &= check("klipper EXCLUDE_OBJECT_DEFINE lines are identical", defines(sg) == d)
    lo, ls = layers_of(og), layers_of(sg)
    same = all(sorted(set(lo[k])) == sorted(set(ls.get(k, []))) for k in lo if k in ls) and len(lo) == len(ls)
    ok &= check("objects printed on every layer", same)
    norm = lambda g: sorted(set(re.sub(r"id:\d+", "id:N", l) for l in g.splitlines() if l.startswith("; printing object") or l.startswith("; stop printing object")))
    ok &= check("OctoPrint object comments", norm(og) == norm(sg), f"\n  sx {norm(sg)}\n  orca {norm(og)}")

    # Marlin: M486 labels and machine limits.
    om = orca_slice(a.orca, work, "marlin2", {"exclude_object": 1, "brim_type": "no_brim"}, {**{k: v for k, v in LIMITS.items()}, "machine_limits_usage": "emit_to_gcode"}, a.model)
    sm = sx_slice(a.sx, work, "marlin2", {**base, "exclude_object": True, "machine_limits_usage": "emit_to_gcode",
                                          **{k: v.split(",") for k, v in LIMITS.items()}}, centers, names, a.model)
    hdr = lambda g: [l for l in g.splitlines() if re.match(r"M486 (S\d+|A)", l)][:4]
    ok &= check("marlin M486 definitions", hdr(om) == hdr(sm), f"\n  sx {hdr(sm)}\n  orca {hdr(om)}")
    lo, ls = m486_layers(om), m486_layers(sm)
    ok &= check("marlin objects per layer", all(sorted(set(lo[k])) == sorted(set(ls.get(k, []))) for k in lo if k in ls))
    ok &= check("machine limit lines (M201 to M205)", limits_block(om) == limits_block(sm), f"\n  sx {limits_block(sm)}\n  orca {limits_block(om)}")

    # Bambu Lab: M624 labels with a mask, without exclude_object (Orca turns them on for any Bambu Lab printer).
    bambu = {"printer_model": "Bambu Lab X1 Carbon"}
    ob = orca_slice(a.orca, work, "marlin", {"brim_type": "no_brim"}, bambu, a.model)
    sb = sx_slice(a.sx, work, "marlin", {**base, **bambu}, centers, names, a.model)
    bl_ids = {k: bambu_ids(g) for k, g in (("orca", ob), ("sx", sb))}
    ok &= check("bambu model label id header", bool(bl_ids["orca"]) and len(bl_ids["orca"]) == len(bl_ids["sx"]), f"sx {bl_ids['sx']} orca {bl_ids['orca']}")
    lo, ls = bambu_layers(ob), bambu_layers(sb)
    ok &= check("bambu M624 masks match the label id list", lo is not None and ls is not None, f"sx {ls is not None} orca {lo is not None}")
    if lo and ls:
        wraps = lambda g: [(l, n) for l, n in zip(g.splitlines(), g.splitlines()[1:]) if l.startswith("; object ids of layer ")]
        wo, ws = wraps(ob), wraps(sb)
        ok &= check("bambu timelapse mask on every layer", len(wo) == len(lo) and len(ws) == len(ls) and [n for _, n in wo] == [n for _, n in ws], f"sx {len(ws)} {ws[:1]} orca {len(wo)} {wo[:1]}")
        ok &= check("bambu objects per layer", len(lo) == len(ls) and all(sorted(set(lo[k])) == sorted(set(ls.get(k, []))) for k in lo), f"\n  sx {list(ls.items())[:3]}\n  orca {list(lo.items())[:3]}")

    # Progress and statistics.
    ko, k0, kl, kn = stats(om)
    ks, s0, sl, sn = stats(sm)
    ok &= check("statistics keys", sorted(ko) == sorted(ks), f"\n  sx {sorted(ks)}\n  orca {sorted(ko)}")
    if "filament used [mm]" in ko and "filament used [mm]" in ks:
        fo, fs = float(ko["filament used [mm]"]), float(ks["filament used [mm]"])
        ok &= check("filament used within 8 percent", abs(fs - fo) <= 0.08 * fo, f"sx {fs} orca {fo}")
    ok &= check("M73 starts at P0 and ends at P100 R0", bool(s0 and s0.startswith("M73 P0 ") and sl == "M73 P100 R0") and bool(k0 and k0.startswith("M73 P0 ") and kl == "M73 P100 R0"), f"sx {s0} {sl} orca {k0} {kl}")
    ok &= check("M73 lines are written throughout", sn > 20 and kn > 20, f"sx {sn} orca {kn}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
