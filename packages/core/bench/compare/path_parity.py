#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Path parity: SlicerX against OrcaSlicer on what each feature's toolpaths look like, not only how long they are.

    python3 path_parity.py                          # every case below
    python3 path_parity.py --cases top-monotonic,ironing-top
    python3 path_parity.py --sx path/to/sx --orca path/to/OrcaSlicer --workdir path-work

Both slicers get the same model and settings (the cases and overrides of parity.py). From each
G-code file, per feature, this reads: the number of extruding moves, the number of strokes
(runs of extruding moves without a travel between them), filament length, the bounding box, and
a histogram of move directions (18 bins of 10 degrees, folded so a line and its reverse share a
bin, weighted by length). A feature passes when its bounding boxes agree within 2 mm, its
direction histograms differ by less than 0.25 (half the summed absolute difference of the
normalized bins), its move count agrees within the case's tolerance and it has no more strokes
than Orca beyond that tolerance (fewer strokes for the same lines means fewer travels). So that
fewer strokes cannot hide bad joins, sparse infill also measures its connectors: extruding moves
within 1 mm of a wall of the same layer and within 20 degrees of parallel to it (the joins and
anchor hooks that follow the boundary), runs of them in one stroke counting as one connector; a
stroke of a single move is a lone line and has none. The
longest connector must not exceed Orca's by more than 5 percent plus 0.5 mm, and the total by more
than 5 percent plus 1 mm plus one connector of Orca's mean length for each stroke fewer than Orca:
each join that saves a stroke adds a connector, so the total may grow by what the joins explain,
not more. Infill lines that happen to run beside a wall count too; both slicers draw the same
lines, so they mostly cancel. Exit code 1 when any case
fails. Standard library only.
"""
import argparse
import json
import math
import os
import subprocess
import sys

import models as model_lib
import parity
import settings
import slicers
from gcode import is_layer_mark, plain

BINS = 18
BBOX_MM = 2.0
HIST_MAX = 0.25
# Connectors: infill moves this close to a wall and this near parallel to it.
CONNECTOR_MM = 1.0
CONNECTOR_DEG = 20.0
# Connectors may exceed Orca's by this share, plus the slack in mm (total, longest).
CONNECTOR_MARGIN = 0.05
CONNECTOR_SLACK = (1.0, 0.5)
WALLS = ("Outer wall", "Inner wall")
# The features joined along their boundary (anchor.rs); solid infill lines often run beside a wall.
CONNECTED = ("Sparse infill",)

# name, model, overrides, features, count tolerance (relative), note
PATH_CASES = []


def path_case(name, model, overrides, features, tol=0.35, note=""):
    PATH_CASES.append({"name": name, "model": model, "overrides": overrides, "features": features, "tol": tol, "note": note})
    if name not in parity.CASES:
        parity.case(name, model, overrides, {}, note)


CUBE = {"brim_type": "no_brim", "brim_width": 0}
for _pat in ("monotonic", "monotonicline", "alignedrectilinear", "rectilinear"):
    path_case(f"top-{_pat}", "cube", {**CUBE, "top_surface_pattern": _pat}, ["Top surface"])
for _pat in ("monotonic", "monotonicline", "alignedrectilinear", "concentric"):
    path_case(f"bottom-{_pat}", "cube", {**CUBE, "bottom_surface_pattern": _pat}, ["Bottom surface"])
for _pat in ("hilbertcurve", "archimedeanchords", "octagramspiral"):
    path_case(f"bottom-{_pat}", "cube", {**CUBE, "bottom_surface_pattern": _pat}, ["Bottom surface"])
for _pat in ("monotonic", "monotonicline", "alignedrectilinear", "rectilinear", "concentric", "hilbertcurve", "archimedeanchords", "octagramspiral"):
    path_case(f"solid-{_pat}", "cube", {**CUBE, "internal_solid_infill_pattern": _pat}, ["Internal solid infill"])
for _pat in ("hilbertcurve", "archimedeanchords", "octagramspiral", "concentric"):
    path_case(f"top-{_pat}", "cube", {**CUBE, "top_surface_pattern": _pat}, ["Top surface"])
for _name, _a in (("a2-m5", {"infill_anchor": "2", "infill_anchor_max": "5"}), ("pct", {"infill_anchor": "100%", "infill_anchor_max": "300%"}),
                  ("zero", {"infill_anchor_max": "0"}), ("default", {}), ("a10-m20", {"infill_anchor": "10", "infill_anchor_max": "20"}), ("a2-m20", {"infill_anchor": "2", "infill_anchor_max": "20"}), ("none", {"infill_anchor": "0", "infill_anchor_max": "20"})):
    path_case(f"anchor-{_name}-gear", "gear", {**CUBE, **_a, "sparse_infill_pattern": "grid", "sparse_infill_density": 15}, ["Sparse infill"])
for _model in ("gear", "flare", "x-reference", "table", "wedge", "mushroom"):
    for _t in ("topbottom", "everywhere"):
        path_case(f"fillgap-{_t}-{_model}", _model, {**CUBE, "gap_fill_target": _t, "wall_generator": "classic"},
                  ["Gap infill", "Top surface", "Internal solid infill", "Bottom surface"])
for _kind in ("top", "topmost", "solid"):
    path_case(f"ironing-{_kind}", "cube",
              {**CUBE, "ironing_type": _kind, "ironing_spacing": 0.15, "ironing_flow": 15, "ironing_speed": 20},
              ["Ironing", "Top surface"])
path_case("ironing-concentric", "cube",
          {**CUBE, "ironing_type": "top", "ironing_pattern": "concentric", "ironing_spacing": 0.15, "ironing_flow": 15,
           "ironing_speed": 20}, ["Ironing"])
for _pat in ("grid", "line", "triangles", "cubic", "crosshatch", "honeycomb", "gyroid", "3dhoneycomb", "tri-hexagon", "concentric"):
    path_case(f"sparse-{_pat}", "block", {"sparse_infill_pattern": _pat, "sparse_infill_density": 15}, ["Sparse infill"], 0.5)
for _pat in ("rectilinear", "alignedrectilinear", "monotonic", "monotonicline", "zigzag", "crosszag", "lockedzag", "quartercubic",
             "lateral-honeycomb", "lateral-lattice", "tpmsd", "tpmsfk", "hilbertcurve", "archimedeanchords", "octagramspiral",
             "lightning", "adaptivecubic", "supportcubic"):
    path_case(f"sparse-{_pat}", "block", {"sparse_infill_pattern": _pat, "sparse_infill_density": 15}, ["Sparse infill"], 0.5)
for _n in (1, 2, 3, 4, 5):
    path_case(f"raft-{_n}-cube", "cube", {**CUBE, "raft_layers": _n}, ["Support", "Support interface", "Bottom surface", "Skirt"], 0.5)
path_case("raft-3-mushroom", "mushroom", {"raft_layers": 3}, ["Support", "Support interface", "Bottom surface"], 0.5)
path_case("raft-3-table", "table", {"raft_layers": 3}, ["Support", "Support interface", "Bottom surface"], 0.5)
path_case("raft-3-mushroom-x0", "mushroom", {"raft_layers": 3, "raft_expansion": 0}, ["Support", "Support interface"], 0.5)
path_case("raft-3-mushroom-x3", "mushroom", {"raft_layers": 3, "raft_expansion": 3}, ["Support", "Support interface"], 0.5)
for _m in ("thin-plate", "flare", "block", "bar12", "eccentric-ring"):
    path_case(f"raft-3-{_m}", _m, {"raft_layers": 3}, ["Support", "Support interface"], 0.5)
path_case("raft-3-cube-brim", "cube", {"raft_layers": 3}, ["Support", "Support interface", "Brim", "Skirt"], 0.5)
path_case("raft-3-block-nobrim", "block", {**CUBE, "raft_layers": 3}, ["Support", "Support interface"], 0.5)
path_case("raft-3-block-nobrim-e0", "block", {**CUBE, "raft_layers": 3, "raft_first_layer_expansion": 0.5, "raft_expansion": 0}, ["Support", "Support interface"], 0.5)
path_case("raft-3-block-ex0.5", "block", {**CUBE, "raft_layers": 3, "raft_first_layer_expansion": 0.5, "raft_expansion": 0.5}, ["Support", "Support interface"], 0.5)
path_case("raft-3-cube-ex0.5", "cube", {**CUBE, "raft_layers": 3, "raft_first_layer_expansion": 0.5, "raft_expansion": 0.5}, ["Support", "Support interface"], 0.5)
path_case("raft-3-block-ex1.0", "block", {**CUBE, "raft_layers": 3, "raft_first_layer_expansion": 0.5, "raft_expansion": 1.0}, ["Support", "Support interface"], 0.5)
path_case("raft-3-cube-ex1.0", "cube", {**CUBE, "raft_layers": 3, "raft_first_layer_expansion": 0.5, "raft_expansion": 1.0}, ["Support", "Support interface"], 0.5)
path_case("raft-3-block-ex3.0", "block", {**CUBE, "raft_layers": 3, "raft_first_layer_expansion": 0.5, "raft_expansion": 3.0}, ["Support", "Support interface"], 0.5)
path_case("raft-3-cube-ex3.0", "cube", {**CUBE, "raft_layers": 3, "raft_first_layer_expansion": 0.5, "raft_expansion": 3.0}, ["Support", "Support interface"], 0.5)
path_case("raft-3-gear", "gear", {"raft_layers": 3}, ["Support", "Support interface", "Bottom surface"], 0.5)
path_case("raft-4-gear-contact", "gear", {"raft_layers": 4, "raft_contact_distance": 0.0}, ["Support", "Support interface", "Bottom surface"], 0.5)
for _m in ("gear", "x-reference", "mushroom"):
    path_case(f"sparse-lightning-{_m}", _m, {"sparse_infill_pattern": "lightning", "sparse_infill_density": 15}, ["Sparse infill"], 0.5)
for _pat in ("zigzag", "crosszag", "lockedzag"):
    path_case(f"sparse-{_pat}-gear", "gear", {"sparse_infill_pattern": _pat, "sparse_infill_density": 15}, ["Sparse infill"], 0.5)
for _m in ("gear", "x-reference"):
    path_case(f"base-{_m}", _m, {}, ["Brim", "Outer wall", "Inner wall", "Top surface", "Bottom surface", "Internal Bridge", "Bridge", "Internal solid infill", "Sparse infill"], 0.5)


def parse_paths(path):
    """Per feature: moves, strokes, mm of filament, bbox and direction histogram of the extruding moves."""
    rel = False
    e = 0.0
    x = y = None
    kind = "unlabeled"
    feats = {}
    stroke_open = False
    layer = 0
    stroke_id = 0
    # Per layer: wall segments, and the infill segments of the connected features with their stroke.
    walls = {}
    infill = {}
    with open(path, errors="replace") as f:
        for ln in f:
            if ln[0] == ";":
                tag = plain(ln)
                if tag.startswith(";TYPE:"):
                    kind = tag[6:].strip()
                    stroke_open = False
                elif is_layer_mark(ln):
                    stroke_open = False
                    layer += 1
                continue
            words = ln.split(";", 1)[0].split()
            if not words:
                continue
            g = words[0]
            if g == "M82":
                rel = False
            elif g == "M83":
                rel = True
            if g not in ("G0", "G1", "G2", "G3", "G92"):
                continue
            fields = {w[0]: w[1:] for w in words[1:] if len(w) > 1}
            try:
                nx = float(fields["X"]) if "X" in fields else x
                ny = float(fields["Y"]) if "Y" in fields else y
                v = float(fields["E"]) if "E" in fields else None
            except ValueError:
                continue
            if g == "G92":
                if v is not None:
                    e = v
                continue
            delta = 0.0
            if v is not None:
                delta = v if rel else v - e
                if not rel:
                    e = v
            moved = ("X" in fields or "Y" in fields) and nx is not None and ny is not None and x is not None
            if delta > 0 and moved:
                d = feats.setdefault(kind, {"moves": 0, "strokes": 0, "mm": 0.0, "len": 0.0,
                                            "bbox": [1e9, 1e9, -1e9, -1e9], "hist": [0.0] * BINS})
                d["moves"] += 1
                if not stroke_open:
                    d["strokes"] += 1
                    stroke_open = True
                    stroke_id += 1
                if kind in WALLS:
                    walls.setdefault(layer, []).append((x, y, nx, ny))
                elif kind in CONNECTED:
                    infill.setdefault(layer, []).append((kind, stroke_id, x, y, nx, ny))
                d["mm"] += delta
                dx, dy = nx - x, ny - y
                ln_ = math.hypot(dx, dy)
                d["len"] += ln_
                if ln_ > 1e-6:
                    ang = math.degrees(math.atan2(dy, dx)) % 180.0
                    d["hist"][min(int(ang / (180.0 / BINS)), BINS - 1)] += ln_
                b = d["bbox"]
                for px, py in ((x, y), (nx, ny)):
                    b[0], b[1], b[2], b[3] = min(b[0], px), min(b[1], py), max(b[2], px), max(b[3], py)
            else:
                stroke_open = False
            x, y = nx, ny
    for kind, (total, longest, runs) in connectors(walls, infill).items():
        if kind in feats:
            feats[kind]["connector_mm"] = total
            feats[kind]["connector_max"] = longest
            feats[kind]["connector_mean"] = total / runs if runs else 0.0
    return feats


def connectors(walls, infill):
    """Per feature: total length of the moves that follow a wall (joins and anchor hooks), the longest run of them in one stroke, and the number of runs."""
    cell = 5.0
    out = {}
    cos_max = math.cos(math.radians(CONNECTOR_DEG))
    for layer, segs in infill.items():
        grid = {}
        for w in walls.get(layer, []):
            x0, x1 = sorted((w[0], w[2]))
            y0, y1 = sorted((w[1], w[3]))
            for cx in range(int((x0 - CONNECTOR_MM) // cell), int((x1 + CONNECTOR_MM) // cell) + 1):
                for cy in range(int((y0 - CONNECTOR_MM) // cell), int((y1 + CONNECTOR_MM) // cell) + 1):
                    grid.setdefault((cx, cy), []).append(w)
        # A stroke of one straight move is a lone line, never a join or a hook (stubs in a gear's teeth run
        # beside the wall).
        per_stroke = {}
        for kind, stroke, *_ in segs:
            per_stroke[(kind, stroke)] = per_stroke.get((kind, stroke), 0) + 1
        run_key, run_len = None, 0.0
        for kind, stroke, ax, ay, bx, by in segs:
            ln_ = math.hypot(bx - ax, by - ay)
            hit = False
            if ln_ > 1e-6 and per_stroke[(kind, stroke)] > 1:
                mx, my = (ax + bx) / 2, (ay + by) / 2
                ux, uy = (bx - ax) / ln_, (by - ay) / ln_
                for w in grid.get((int(mx // cell), int(my // cell)), []):
                    wx, wy = w[2] - w[0], w[3] - w[1]
                    wl = math.hypot(wx, wy)
                    if wl < 1e-6 or abs(ux * wx + uy * wy) / wl < cos_max:
                        continue
                    t = max(0.0, min(1.0, ((mx - w[0]) * wx + (my - w[1]) * wy) / (wl * wl)))
                    if math.hypot(mx - (w[0] + t * wx), my - (w[1] + t * wy)) <= CONNECTOR_MM:
                        hit = True
                        break
            tot = out.setdefault(kind, [0.0, 0.0, 0])
            if hit:
                tot[0] += ln_
                if run_key != (kind, stroke):
                    tot[2] += 1
                run_len = run_len + ln_ if run_key == (kind, stroke) else ln_
                run_key = (kind, stroke)
                tot[1] = max(tot[1], run_len)
            else:
                run_key, run_len = None, 0.0
    return {k: (v[0], v[1], v[2]) for k, v in out.items()}


def normalized(h):
    s = sum(h)
    return [v / s for v in h] if s > 0 else [0.0] * len(h)


def hist_distance(a, b):
    """Half the summed absolute difference of the normalized histograms: 0 equal, 1 disjoint."""
    na, nb = normalized(a), normalized(b)
    return 0.5 * sum(abs(p - q) for p, q in zip(na, nb))


def compare_paths(case, a, b):
    rows, ok = [], True
    for feat in case["features"]:
        fa, fb = a.get(feat), b.get(feat)
        if not fa and not fb:
            continue
        if not fa or not fb:
            rows.append({"feature": feat, "ok": False, "what": "missing in " + ("sx" if not fa else "orca")})
            ok = False
            continue
        tol = case["tol"]
        row = {"feature": feat,
               "moves": [fa["moves"], fb["moves"]], "strokes": [fa["strokes"], fb["strokes"]],
               "mm": [round(fa["mm"], 1), round(fb["mm"], 1)],
               "bbox_delta": [round(p - q, 2) for p, q in zip(fa["bbox"], fb["bbox"])],
               "hist_distance": round(hist_distance(fa["hist"], fb["hist"]), 3)}
        good_moves = abs(fa["moves"] - fb["moves"]) <= max(tol * fb["moves"], 10)
        # One-sided: fewer strokes than Orca for the same lines is better, as long as the joins are no longer.
        good_strokes = fa["strokes"] - fb["strokes"] <= max(tol * fb["strokes"], 5)
        good_bbox = max(abs(v) for v in row["bbox_delta"]) <= BBOX_MM
        good_hist = row["hist_distance"] <= HIST_MAX
        good_joins = True
        if feat in CONNECTED:
            ta, tb = fa.get("connector_mm", 0.0), fb.get("connector_mm", 0.0)
            la, lb = fa.get("connector_max", 0.0), fb.get("connector_max", 0.0)
            row["connector_mm"] = [round(ta, 1), round(tb, 1)]
            row["connector_max"] = [round(la, 2), round(lb, 2)]
            gained = max(0, fb["strokes"] - fa["strokes"]) * fb.get("connector_mean", 0.0)
            good_joins = (ta <= tb * (1 + CONNECTOR_MARGIN) + CONNECTOR_SLACK[0] + gained
                          and la <= lb * (1 + CONNECTOR_MARGIN) + CONNECTOR_SLACK[1])
        row["ok"] = good_moves and good_strokes and good_bbox and good_hist and good_joins
        row["failed"] = [n for n, g in (("moves", good_moves), ("strokes", good_strokes), ("bbox", good_bbox),
                                        ("direction", good_hist), ("joins", good_joins)) if not g]
        rows.append(row)
        ok &= row["ok"]
    return {"name": case["name"], "ok": ok, "rows": rows, "note": case["note"]}


def run_case(case, sx_path, orca_path, work):
    c = parity.CASES[case["name"]]
    d = os.path.join(work, case["name"])
    os.makedirs(os.path.join(d, "models"), exist_ok=True)
    model = c["model"]
    stl = os.path.join(d, "models", f"{model}.stl")
    model_lib.write_stl(stl, model_lib.MODELS[model]())
    cfg = settings.sx_config()
    # Both sides run the same vertical shell mode (PP_ENSURE, default Orca's none in the harness).
    mode = {"ensure_vertical_shell_thickness": os.environ.get("PP_ENSURE", parity.ORCA_ONLY["ensure_vertical_shell_thickness"])}
    cfg.update(mode)
    cfg.update(c["overrides"])
    if cfg.get("brim_type") == "no_brim":
        cfg["brim_width"] = 0
    cfg["slow_down_for_layer_cooling"] = False
    cfg_path = os.path.join(d, "sx.json")
    json.dump(cfg, open(cfg_path, "w"))
    sx_gcode = os.path.join(d, "sx.gcode")
    subprocess.run([sx_path, "slice", stl, "--config", cfg_path, "-o", sx_gcode], capture_output=True, check=True)
    orca = parity.ParityOrca(orca_path, {**parity.ORCA_ONLY, **mode, **c["overrides"]})
    orca.prepare(d, {"cube": stl})
    job = orca.job(model, d)
    r = subprocess.run(job.cmd, capture_output=True, text=True)
    if not os.path.exists(job.gcode):
        return {"name": case["name"], "error": f"Orca produced no G-code: {r.stderr[-300:]}"}
    return compare_paths(case, parse_paths(sx_gcode), parse_paths(job.gcode))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", default="")
    ap.add_argument("--sx")
    ap.add_argument("--orca")
    ap.add_argument("--workdir", default="path-work")
    ap.add_argument("--out", default="path-parity-results.json")
    a = ap.parse_args()
    sx = slicers.SlicerX(a.sx)
    orca = slicers.Orca(a.orca)
    if not sx.available() or not orca.available():
        print("need both sx and OrcaSlicer (--sx, --orca)", file=sys.stderr)
        return 2
    want = {n for n in a.cases.split(",") if n}
    results = []
    for case in PATH_CASES:
        if want and case["name"] not in want:
            continue
        res = run_case(case, sx.path, orca.path, os.path.abspath(a.workdir))
        results.append(res)
        if "error" in res:
            print(f"ERROR {case['name']}: {res['error']}")
            continue
        print(("ok   " if res["ok"] else "FAIL ") + case["name"])
        for r in res["rows"]:
            if "what" in r:
                print(f"       {r['feature']:<22} {r['what']}")
                continue
            bad = f"  <-- {', '.join(r['failed'])}" if r["failed"] else ""
            print(f"       {r['feature']:<22} moves {r['moves'][0]:>6}/{r['moves'][1]:<6} strokes {r['strokes'][0]:>5}/{r['strokes'][1]:<5} "
                  f"mm {r['mm'][0]:>7}/{r['mm'][1]:<7} dir {r['hist_distance']:.2f} bbox {max(abs(v) for v in r['bbox_delta']):.1f}"
                  + (f" joins {r['connector_mm'][0]}/{r['connector_mm'][1]} mm, longest {r['connector_max'][0]}/{r['connector_max'][1]}" if "connector_mm" in r else "")
                  + bad)
    json.dump({"cases": results}, open(a.out, "w"), indent=1)
    return 0 if all(r.get("ok") for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
