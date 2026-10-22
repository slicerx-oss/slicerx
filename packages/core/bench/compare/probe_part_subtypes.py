#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Corpus-shaped parity cases for part subtypes (modifier, support blocker, support enforcer, negative part).

The corpus project `packages/geom/tests/corpus/bambu-subtypes.3mf` keeps its volumes outside the body, so it can
only show that they print nothing. This script reshapes that project (moves and scales its parts, changes their
subtypes, gives the modifier settings) into cases where each volume has a measurable effect, slices each with
SlicerX and, when they are given, Bambu Studio and OrcaSlicer, and checks the filament inside boxes of the object:

    dbody, dmod, dmod2, dmod3   a modifier over the right half of the body: no modifier, infill and walls, infill
                                only, walls only
    s0-auto ... s3-both-auto    a slab on two pillars with support off, manual or auto: no volumes, a blocker
                                over the right half of the gap, an enforcer over the left half, a blocker over
                                the whole gap with and without that enforcer

    python probe_part_subtypes.py --sx path/to/sx [--bambu path/to/bambu-studio] [--orca path/to/orca-slicer]
    python probe_part_subtypes.py --selftest

SlicerX is always checked against fixed expectations (a number or a ratio per case). A reference slicer's numbers
are compared to SlicerX's when given. Reference slicers run on a machine where they are installed, with Python
and a native `sx`; the Bambu Studio command line cannot slice some of the corpus projects as shipped, so each
case goes through Bambu Studio's own defaults with the matched settings, as `slicers.Bambu` does.
"""
import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

import measure
import models as model_lib
import parity
import settings
import slicers

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.abspath(os.path.join(HERE, "..", "..", "..", "geom", "tests", "corpus", "bambu-subtypes.3mf"))

# Support settings of the audit cases: grid style, 30 degree threshold, 0.2 mm gaps.
SUP_AUTO = {"enable_support": "1", "support_type": "normal(auto)", "support_style": "grid", "support_threshold_angle": "30",
            "support_on_build_plate_only": "0", "support_object_xy_distance": "0.35", "support_top_z_distance": "0.2",
            "support_bottom_z_distance": "0.2", "support_interface_top_layers": "2", "support_interface_bottom_layers": "0",
            "support_base_pattern": "rectilinear", "support_base_pattern_spacing": "2.5", "support_interface_spacing": "0.5",
            "independent_support_layer_height": "0", "support_remove_small_overhang": "0"}
SUP_MANUAL = dict(SUP_AUTO, support_type="normal(manual)")
SUP_OFF = {"enable_support": "0"}

# Part ids of the corpus project: 1 body, 2 negative, 3 modifier, 4 blocker, 5 enforcer. The body is 20 x 20 x 10
# and each volume a 6 x 6 x 4 box (object-local mm).
MOD = ["--scale", "3:2,4,3", "--move", "3:16,10,5"]
TABLE = ["--subtype", "2:normal_part", "--subtype", "3:normal_part",
         "--scale", "1:2,1,0.2", "--move", "1:20,10,11",
         "--scale", "3:1.333333,3.333333,2.5", "--move", "3:4,10,5",
         "--scale", "2:1.333333,3.333333,1.666667", "--move", "2:36,10,5"]
BLOCK_RIGHT = ["--scale", "4:2,4,3.25", "--move", "4:26,10,5.5"]
BLOCK_ALL = ["--scale", "4:4,4,3.25", "--move", "4:20,10,5.5"]
ENF_LEFT = ["--scale", "5:2,4,3.25", "--move", "5:14,10,5.5"]

MOD_BOXES = {"left": [0.6, 9.4, 0.6, 19.4, 0, 10.5], "right": [10.6, 19.4, 0.6, 19.4, 0, 10.5],
             "band": [9.6, 10.4, 1.5, 18.5, 1.0, 9.0], "outside": [20.5, 22.5, -2.5, 22.5, 0, 11]}
SUP_BOXES = {"gap_left": [8.6, 19.4, 0.5, 19.5, 0, 9.95], "gap_right": [20.6, 31.4, 0.5, 19.5, 0, 9.95]}

# Each case: drop (part ids), arguments for the reshaping, support preset, boxes, expectations. An expectation
# is (name, box, features, op, value): the filament in `box` over the listed features, compared with a number
# ("<", ">") or with another measurement ("ratio>": value times the second operand, written as box2).
SPARSE = ("sparse_infill",)
WALL = ("outer_wall",)
SUPPORT = ("support", "support_interface")
CASES = {
    "dbody": dict(drop="2,3,4,5", args=[], sup=SUP_OFF, boxes=MOD_BOXES, expect=[
        ("equal halves", "right", SPARSE, "ratio<", 1.15, "left"), ("equal halves", "right", SPARSE, "ratio>", 0.85, "left"),
        ("no wall at the middle", "band", WALL, "<", 1.0, None)]),
    "dmod": dict(drop="2,4,5", args=MOD + ["--part-meta", "3:sparse_infill_density=60%", "--part-meta", "3:wall_loops=4",
                                           "--part-meta", "3:sparse_infill_pattern=grid"], sup=SUP_OFF, boxes=MOD_BOXES, expect=[
        ("denser infill inside", "right", SPARSE, "ratio>", 1.8, "left"),
        ("walls along the boundary", "band", WALL, ">", 20.0, None),
        ("nothing past the body", "outside", ("sparse_infill", "solid_infill", "outer_wall", "inner_wall", "top_surface"), "<", 1.0, None)]),
    "dmod2": dict(drop="2,4,5", args=MOD + ["--part-meta", "3:sparse_infill_density=60%", "--part-meta", "3:sparse_infill_pattern=grid"],
                  sup=SUP_OFF, boxes=MOD_BOXES, expect=[
        ("denser infill inside", "right", SPARSE, "ratio>", 2.5, "left"),
        ("infill only adds no boundary wall", "band", WALL, "<", 1.0, None)]),
    "dmod3": dict(drop="2,4,5", args=MOD + ["--part-meta", "3:wall_loops=4"], sup=SUP_OFF, boxes=MOD_BOXES, expect=[
        ("more walls leave less infill", "right", SPARSE, "ratio<", 0.9, "left"),
        ("walls along the boundary", "band", WALL, ">", 20.0, None)]),
    "s0-auto": dict(drop="4,5", args=TABLE, sup=SUP_AUTO, boxes=SUP_BOXES, expect=[
        ("support under both halves", "gap_left", SUPPORT, ">", 50.0, None), ("support under both halves", "gap_right", SUPPORT, ">", 50.0, None)]),
    "s1-blocker": dict(drop="5", args=TABLE + BLOCK_RIGHT, sup=SUP_AUTO, boxes=SUP_BOXES, expect=[
        ("left keeps its support", "gap_left", SUPPORT, ">", 50.0, None), ("blocked half is empty", "gap_right", SUPPORT, "<", 10.0, None)]),
    "s2-enf-off": dict(drop="4", args=TABLE + ENF_LEFT, sup=SUP_OFF, boxes=SUP_BOXES, expect=[
        ("support off beats an enforcer", "gap_left", SUPPORT, "<", 1.0, None), ("support off beats an enforcer", "gap_right", SUPPORT, "<", 1.0, None)]),
    "s2-none-manual": dict(drop="4,5", args=TABLE, sup=SUP_MANUAL, boxes=SUP_BOXES, expect=[
        ("manual without enforcers", "gap_left", SUPPORT, "<", 1.0, None), ("manual without enforcers", "gap_right", SUPPORT, "<", 1.0, None)]),
    "s2-enf-manual": dict(drop="4", args=TABLE + ENF_LEFT, sup=SUP_MANUAL, boxes=SUP_BOXES, expect=[
        ("manual prints under the enforcer", "gap_left", SUPPORT, ">", 50.0, None), ("and nowhere else", "gap_right", SUPPORT, "<", 10.0, None)]),
    "s3-blockall-auto": dict(drop="5", args=TABLE + BLOCK_ALL, sup=SUP_AUTO, boxes=SUP_BOXES, expect=[
        ("a blocker over the gap", "gap_left", SUPPORT, "<", 1.0, None), ("a blocker over the gap", "gap_right", SUPPORT, "<", 10.0, None)]),
    "s3-both-auto": dict(drop="", args=TABLE + BLOCK_ALL + ENF_LEFT, sup=SUP_AUTO, boxes=SUP_BOXES, expect=[
        ("the enforcer wins over the blocker", "gap_left", SUPPORT, ">", 50.0, None), ("blocked half is empty", "gap_right", SUPPORT, "<", 10.0, None)]),
}


def fmt(v):
    return " ".join(f"{x:g}" for x in v)


def reshape(src, drop="", args=()):
    """The corpus project with parts dropped, moved, scaled, retyped or given settings. Returns {name: bytes}."""
    ap = argparse.ArgumentParser()
    ap.add_argument("--move", action="append", default=[])
    ap.add_argument("--scale", action="append", default=[])
    ap.add_argument("--subtype", action="append", default=[])
    ap.add_argument("--part-meta", action="append", default=[])
    a = ap.parse_args(list(args))
    drop = {s for s in drop.split(",") if s}
    moves = {m.split(":")[0]: [float(v) for v in m.split(":")[1].split(",")] for m in a.move}
    scales = {m.split(":")[0]: [float(v) for v in m.split(":")[1].split(",")] for m in a.scale}
    subs = dict(s.split(":", 1) for s in a.subtype)
    metas = {}
    for m in a.part_meta:
        i, kv = m.split(":", 1)
        k, v = kv.split("=", 1)
        metas.setdefault(i, []).append((k, v))
    with zipfile.ZipFile(src) as z:
        files = {n: z.read(n) for n in z.namelist()}
    model = files["3D/3dmodel.model"].decode()

    def comp(m):
        oid = m.group(1)
        if oid in drop:
            return ""
        s = m.group(0)
        tm = re.search(r'transform="([^"]+)"', s)
        t = [float(v) for v in tm.group(1).split()]
        if oid in scales:
            t[0] *= scales[oid][0]
            t[4] *= scales[oid][1]
            t[8] *= scales[oid][2]
        if oid in moves:
            t[9:12] = moves[oid]
        return s.replace(tm.group(0), f'transform="{fmt(t)}"')
    files["3D/3dmodel.model"] = re.sub(r'<component [^>]*objectid="(\d+)"[^>]*/>', comp, model).encode()
    cfg = files["Metadata/model_settings.config"].decode()

    def part(m):
        pid = m.group(1)
        if pid in drop:
            return ""
        s = m.group(0)
        if pid in subs:
            s = re.sub(r'subtype="[^"]+"', f'subtype="{subs[pid]}"', s, count=1)
        if pid in moves or pid in scales:
            mm = re.search(r'key="matrix" value="([^"]+)"', s)
            v = [float(x) for x in mm.group(1).split()]
            if pid in scales:
                v[0] *= scales[pid][0]
                v[5] *= scales[pid][1]
                v[10] *= scales[pid][2]
            if pid in moves:
                v[3], v[7], v[11] = moves[pid]
            s = s.replace(mm.group(0), f'key="matrix" value="{fmt(v)}"')
        if pid in metas:
            s = s.replace("</part>", "".join(f'<metadata key="{k}" value="{v}"/>' for k, v in metas[pid]) + "</part>")
        return s
    files["Metadata/model_settings.config"] = re.sub(r'<part id="(\d+)".*?</part>', part, cfg, flags=re.S).encode()
    return files


def write_project(path, files, project_settings, plain=False):
    """`plain` drops the application header (OrcaSlicer refuses a Bambu Studio header) and the project settings."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for n, b in files.items():
            if n == "Metadata/project_settings.config":
                continue
            if plain and n == "3D/3dmodel.model":
                b = re.sub(rb'\s*<metadata name="(Application|BambuStudio:3mfVersion|OrcaSlicer)">[^<]*</metadata>', b"", b)
            z.writestr(n, b)
        if not plain:
            z.writestr("Metadata/project_settings.config", json.dumps(project_settings))


CANON = {"outer wall": "outer_wall", "external perimeter": "outer_wall", "inner wall": "inner_wall", "perimeter": "inner_wall",
         "sparse infill": "sparse_infill", "internal infill": "sparse_infill", "internal solid infill": "solid_infill",
         "solid infill": "solid_infill", "top surface": "top_surface", "support": "support", "support material": "support",
         "support interface": "support_interface", "support material interface": "support_interface", "brim": "brim"}


def feature_moves(path):
    """Extruding moves as (feature, x0, y0, x1, y1, z, mm of filament)."""
    rel, e, kind = False, 0.0, "none"
    x = y = z = None
    with open(path, errors="replace") as f:
        for raw in f:
            ln = raw.strip()
            if ln.startswith(";TYPE:") or ln.startswith("; FEATURE:"):
                name = ln.split(":", 1)[1].strip().lower()
                kind = CANON.get(name, name.replace(" ", "_"))
                continue
            w = ln.split(";", 1)[0].split()
            if not w:
                continue
            if w[0] in ("M82", "M83"):
                rel = w[0] == "M83"
                continue
            if w[0] not in ("G0", "G1", "G92"):
                continue
            v = {t[0]: float(t[1:]) for t in w[1:] if len(t) > 1 and t[0] in "XYZE" and re.match(r"^-?[\d.]+$", t[1:])}
            if w[0] == "G92":
                e = v.get("E", e)
                continue
            nx, ny, nz = v.get("X", x), v.get("Y", y), v.get("Z", z)
            de = 0.0
            if "E" in v:
                de = v["E"] if rel else v["E"] - e
                e = 0.0 if rel else v["E"]
            if de > 0 and x is not None and nx is not None and (nx != x or ny != y):
                yield kind, x, y, nx, ny, nz, de
            x, y, z = nx, ny, nz


def measure_boxes(gcode, boxes):
    """mm of filament per box and feature, in object-local mm. The local origin is the min corner of the printed
    walls (their centerlines sit half a line inside the model edge), so objects placed differently still line up."""
    ms = list(feature_moves(gcode))
    wall = [m for m in ms if m[0] in ("outer_wall", "inner_wall")]
    if not wall:
        raise RuntimeError(f"no walls in {gcode}")
    ox = min(min(m[1], m[3]) for m in wall) - 0.21
    oy = min(min(m[2], m[4]) for m in wall) - 0.21
    out = {n: {} for n in boxes}
    for kind, x0, y0, x1, y1, z, d in ms:
        n = max(1, int(math.hypot(x1 - x0, y1 - y0) / 0.1))
        for name, (bx0, bx1, by0, by1, bz0, bz1) in boxes.items():
            if not bz0 <= z <= bz1:
                continue
            hit = sum(1 for i in range(n)
                      if bx0 <= x0 + (x1 - x0) * (i + 0.5) / n - ox <= bx1 and by0 <= y0 + (y1 - y0) * (i + 0.5) / n - oy <= by1)
            if hit:
                out[name][kind] = out[name].get(kind, 0.0) + d * hit / n
    return out


def total(m, box, features):
    return sum(m[box].get(f, 0.0) for f in features)


def check(case, m, who):
    ok = True
    for what, box, feats, op, val, box2 in CASES[case]["expect"]:
        a = total(m, box, feats)
        if op in ("<", ">"):
            good = a < val if op == "<" else a > val
            shown = f"{a:8.2f} {op} {val}"
        else:
            b = total(m, box2, feats)
            r = a / b if b else float("inf")
            good = r < val if op == "ratio<" else r > val
            shown = f"{a:8.2f} / {box2} {b:8.2f} = {r:5.2f} {op[5:]} {val}"
        ok &= good
        print(f"  {'ok  ' if good else 'FAIL'} {who:<6} {what:<36} {box:<10} {shown}")
    return ok


def agree(case, mine, theirs, who, tol=0.1, floor=3.0):
    """The reference slicer's filament in the same boxes, within `tol` of its own number or `floor` mm."""
    ok, seen = True, set()
    for what, box, feats, op, val, box2 in CASES[case]["expect"]:
        for b in sorted({box, box2} - {None}):
            if (b, feats) in seen:
                continue
            seen.add((b, feats))
            a, r = total(mine, b, feats), total(theirs, b, feats)
            good = abs(a - r) <= max(tol * r, floor)
            ok &= good
            print(f"  {'ok  ' if good else 'FAIL'} {who:<6} {b:<10} {'+'.join(feats):<28} sx {a:8.2f}  {who} {r:8.2f}")
    return ok


def run(cmd, timeout):
    """Starts one child and waits; on a timeout only that child is stopped. Returns True unless it timed out."""
    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        p.wait(timeout=timeout)
        return True
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait()
        return False


def cube_stl(work):
    path = os.path.join(work, "cube.stl")
    model_lib.write_stl(path, model_lib.cube())
    return path


def project_base(work, bambu):
    """Project settings: Bambu Studio's own defaults with the matched settings when it is installed, else the matched
    settings alone."""
    if bambu and bambu.available():
        bambu.prepare(work, {"cube": cube_stl(work)})
        return dict(bambu.project)
    base = {}
    for src in (settings.slicer_process("marlin"), settings.slicer_machine("marlin"), settings.slicer_filament()):
        for k, v in src.items():
            settings.assign(base, k, v)
    return base


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sx")
    ap.add_argument("--bambu", nargs="?", const="", help="also slice with Bambu Studio (a path, or the default install)")
    ap.add_argument("--orca", nargs="?", const="", help="also slice with OrcaSlicer (a path, or the default install)")
    ap.add_argument("--workdir", default="subtype-work")
    ap.add_argument("--cases", help="comma separated; default all")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    work = os.path.abspath(a.workdir)
    os.makedirs(work, exist_ok=True)
    sx = slicers.SlicerX(a.sx)
    if not sx.available():
        print("sx not found; pass --sx")
        return 2
    bambu = slicers.Bambu(a.bambu or None) if a.bambu is not None else None
    orca_path = slicers.Orca(a.orca or None).path if a.orca is not None else None
    base = project_base(work, bambu)
    ok = True
    for name in (a.cases.split(",") if a.cases else CASES):
        c = CASES[name]
        print(f"{name}")
        files = reshape(CORPUS, c["drop"], c["args"])
        cfg = dict(base)
        for k, v in c["sup"].items():
            settings.assign(cfg, k, v)
        proj = os.path.join(work, f"m-{name}.3mf")
        write_project(proj, files, cfg)
        d = os.path.join(work, name)
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
        g = os.path.join(d, "sx.gcode")
        if not run([sx.path, "slice", proj, "-o", g], measure.REF_TIMEOUT) or not os.path.exists(g):
            print("  FAIL sx produced no G-code")
            ok = False
            continue
        mine = measure_boxes(g, c["boxes"])
        ok &= check(name, mine, "sx")
        if bambu and bambu.available():
            bd = os.path.join(d, "bambu")
            run([bambu.path, "--slice", "1", "--debug", "1", "--outputdir", bd, proj], measure.REF_TIMEOUT)
            bg = os.path.join(bd, "plate_1.gcode")
            if os.path.exists(bg):
                ok &= agree(name, mine, measure_boxes(bg, c["boxes"]), "bambu")
            else:
                print("  FAIL bambu produced no G-code")
                ok = False
        if orca_path:
            extra = dict(parity.ORCA_ONLY)
            extra.update(c["sup"])
            orca = parity.ParityOrca(orca_path, extra)
            orca.prepare(d, {"cube": cube_stl(work)})
            op = os.path.join(d, "o-plain.3mf")
            write_project(op, files, None, plain=True)
            od = os.path.join(d, "orca")
            os.makedirs(od, exist_ok=True)
            run(orca._cmd(op, od, ["--debug", "1", "--arrange", "0"]), measure.REF_TIMEOUT)
            og = os.path.join(od, "plate_1.gcode")
            if os.path.exists(og):
                ok &= agree(name, mine, measure_boxes(og, c["boxes"]), "orca")
            else:
                print("  FAIL orca produced no G-code")
                ok = False
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


def selftest():
    """Builds every case and checks the project and the G-code reader; no slicer is run."""
    bad = []
    with tempfile.TemporaryDirectory() as t:
        for name, c in CASES.items():
            files = reshape(CORPUS, c["drop"], c["args"])
            p = os.path.join(t, name + ".3mf")
            write_project(p, files, {})
            cfg = zipfile.ZipFile(p).read("Metadata/model_settings.config").decode()
            subs = re.findall(r'subtype="([^"]+)"', cfg)
            want = 5 - len([s for s in c["drop"].split(",") if s])
            if len(subs) != want:
                bad.append(f"{name}: {len(subs)} parts, wanted {want}")
            blockers, enforcers = subs.count("support_blocker"), subs.count("support_enforcer")
            if ("4" not in c["drop"].split(",")) != (blockers == 1) or ("5" not in c["drop"].split(",")) != (enforcers == 1):
                bad.append(f"{name}: blocker/enforcer parts {blockers}/{enforcers}")
            for what, box, feats, op, val, box2 in c["expect"]:
                if box not in c["boxes"] or (box2 and box2 not in c["boxes"]):
                    bad.append(f"{name}: unknown box in {what}")
        # The G-code reader: two walls and a support line, one crossing a box edge, absolute and relative E.
        g = os.path.join(t, "t.gcode")
        with open(g, "w") as f:
            f.write("M83\n;TYPE:Outer wall\nG1 X10.21 Y10.21 Z0.2\nG1 X20.21 Y10.21 E1.0\nG1 X20.21 Y20.21 E1.0\n"
                    ";TYPE:Support\nG1 X10.21 Y12 E0.0\nG1 X14.21 Y12 E4.0\n")
        m = measure_boxes(g, {"all": [0, 30, 0, 30, 0, 1], "half": [0, 2, 0, 30, 0, 1]})
        if abs(m["all"].get("support", 0) - 4.0) > 0.01 or abs(m["all"]["outer_wall"] - 2.0) > 0.01:
            bad.append(f"reader totals {m['all']}")
        if abs(m["half"].get("support", 0) - 1.79) > 0.02:
            bad.append(f"reader box edge {m['half']}")
    for b in bad:
        print("FAIL", b)
    print(f"selftest {'FAIL' if bad else 'ok'}: {len(CASES)} cases")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
