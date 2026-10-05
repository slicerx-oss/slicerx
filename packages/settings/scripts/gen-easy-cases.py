#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Writes fixtures/easy-cases.json from the Easy mode concept formulas
plus the flow and acceleration caps. Independent of easy-map.json on purpose: it
is the reference the JSON map is checked against, in Rust and in TypeScript."""
import json, math, os

def snap(v): return round(v * 1e9) / 1e9
def rhu(x): return math.floor(x + 0.5)
def rnd(x, q): return snap(rhu(x / q) * q)
bases = {
 "x1c": {"nozzle_diameter": [0.4], "layer_height": 0.2, "outer_wall_speed": [200, 200], "inner_wall_speed": [300, 300], "sparse_infill_speed": [270, 270], "internal_solid_infill_speed": [250, 250], "top_surface_speed": [200, 200], "gap_infill_speed": [250, 250], "default_acceleration": [10000, 10000], "outer_wall_acceleration": [5000, 5000], "inner_wall_acceleration": [0, 0], "sparse_infill_acceleration": [100, 100], "top_surface_acceleration": [2000, 2000], "machine_max_acceleration_extruding": [20000, 20000], "filament_max_volumetric_speed": [21], "outer_wall_line_width": "0.42", "inner_wall_line_width": "0.45", "sparse_infill_line_width": "0.45", "internal_solid_infill_line_width": "0.42", "top_surface_line_width": "0.42"},
 "mk4s": {"nozzle_diameter": [0.4], "layer_height": 0.2, "outer_wall_speed": 45, "inner_wall_speed": 80, "sparse_infill_speed": 120, "internal_solid_infill_speed": 100, "top_surface_speed": 40, "gap_infill_speed": 40, "filament_max_volumetric_speed": [15], "outer_wall_line_width": 0.45, "inner_wall_line_width": 0.45, "sparse_infill_line_width": 0.45, "internal_solid_infill_line_width": 0.45, "top_surface_line_width": 0.4, "enable_support": False, "brim_type": "no_brim", "brim_width": 0},
 "n06": {"nozzle_diameter": [0.6], "layer_height": 0.3, "outer_wall_speed": [100], "sparse_infill_speed": [150], "outer_wall_line_width": "0", "sparse_infill_line_width": "110%", "filament_max_volumetric_speed": [24]},
 "bare": {"sparse_infill_pattern": "gyroid"},
 "n02": {"nozzle_diameter": [0.2], "layer_height": 0.1},
}
F = {"quality": 0.5, "balanced": 1, "fast": 1.24, "fastest": 1.66}
SPEED_ALIAS = {"silent": "quality", "gentle": "quality", "standard": "balanced", "sport": "fast", "ludicrous": "fastest", "maximum": "fastest"}
SUPPORT_ALIAS = {"everywhere": "auto"}
SP = ["outer_wall_speed", "inner_wall_speed", "sparse_infill_speed", "internal_solid_infill_speed", "top_surface_speed", "gap_infill_speed"]
W = {"outer_wall_speed": "outer_wall_line_width", "inner_wall_speed": "inner_wall_line_width", "sparse_infill_speed": "sparse_infill_line_width", "internal_solid_infill_speed": "internal_solid_infill_line_width", "top_surface_speed": "top_surface_line_width", "gap_infill_speed": "inner_wall_line_width"}
AC = ["default_acceleration", "outer_wall_acceleration", "inner_wall_acceleration", "sparse_infill_acceleration", "top_surface_acceleration"]
def first(v): return v[0] if isinstance(v, list) else v
def wid(b, k, noz):
    r = b.get(k)
    if r is None: return noz
    if isinstance(r, str):
        if r.endswith('%'): return float(r[:-1]) / 100 * noz
        r = float(r)
    return r if r > 0 else noz
def ref(b, e):
    noz = first(b.get("nozzle_diameter", [0.4])) or 0.4
    out = {}
    lh = rnd((0.28 - e["detail"] / 100 * 0.2) * (noz / 0.4), 0.02)
    lh = snap(min(max(lh, 0.2 * noz), 0.75 * noz))
    out["layer_height"] = lh
    out["initial_layer_print_height"] = snap(max(lh, 0.5 * noz))
    out["top_shell_thickness"] = 1.0
    out["bottom_shell_thickness"] = 0.6
    out["top_shell_layers"] = math.ceil(1.0 / lh - 1e-9)
    out["bottom_shell_layers"] = math.ceil(0.6 / lh - 1e-9)
    out["wall_loops"] = 2 + min(4, math.floor(e["strength"] / 25 + 1e-9))
    out["sparse_infill_density"] = rnd(10 + e["strength"] / 100 * 30, 5)
    f = F[SPEED_ALIAS.get(e["speed"], e["speed"])]
    mf = first(b["filament_max_volumetric_speed"]) if "filament_max_volumetric_speed" in b else 0
    lim = first(b["machine_max_acceleration_extruding"]) if "machine_max_acceleration_extruding" in b else 0
    for k in SP:
        if k not in b: continue
        def sc(x):
            if x <= 0: return x
            v = x * f
            if mf > 0 and lh > 0: v = min(v, max(mf / (wid(b, W[k], noz) * lh), x))
            v = max(v, 5)
            return snap(rhu(v))
        v = b[k]; out[k] = [sc(x) for x in v] if isinstance(v, list) else sc(v)
    for k in AC:
        if k not in b: continue
        def sa(x):
            if x <= 0: return x
            v = x * f
            if lim > 0: v = min(v, max(lim, x))
            v = max(v, 100)
            return snap(rhu(v / 100) * 100)
        v = b[k]; out[k] = [sa(x) for x in v] if isinstance(v, list) else sa(v)
    out["sparse_infill_pattern"] = "gyroid"
    if "varyLayerHeight" in e:
        sm = "off" if not e["varyLayerHeight"] else ("strength" if e["strength"] >= 70 else "quality")
    else:
        sm = e.get("smartLayer", "off")
    out["smart_layer"] = sm
    if sm != "off":
        mn = snap(snap(math.ceil(snap(snap(({'quality': 0.2, 'strength': 0.3}[sm]) * noz) / 0.02) - 1e-9) * 1.0) * 0.02)
        mn = max(mn, rnd(snap(0.75 * lh), 0.01))
        top = snap(snap(math.floor(snap(snap(0.5 * noz) / 0.02) + 1e-9) * 1.0) * 0.02)
        mn = min(mn, rnd(snap(top - 0.02), 0.02))
        mx = max(min(top, rnd(snap(1.5 * lh), 0.02)), snap(mn + 0.02))
        out["smart_layer_min_height"] = mn
        out["smart_layer_max_height"] = mx
    sup = SUPPORT_ALIAS.get(e["supports"], e["supports"])
    out["enable_support"] = sup != "off"
    if sup != "off":
        out["support_type"] = "tree(auto)" if sup == "auto" else "tree(manual)"
        out["support_on_build_plate_only"] = sup == "auto"
        out["support_threshold_angle"] = 25
    out["brim_type"] = "auto_brim" if e["brim"] else "no_brim"
    if e["brim"]: out["brim_width"] = 5
    return out
goals = {"draft": (0, 10, "fast", False), "standard": (40, 20, "balanced", True), "fine": (80, 30, "balanced", True), "strong": (40, 85, "balanced", True)}
cases = []
def add(name, base, e):
    exp = ref(bases[base], e)
    for k in list(exp):
        b = bases[base].get(k)
        if isinstance(b, list) and not isinstance(exp[k], list): exp[k] = [exp[k]] * len(b)
    cases.append({"name": name, "base": base, "easy": e, "expect": exp})
E = lambda d, s, sp="balanced", su="auto", br=True, v=False: {"detail": d, "strength": s, "speed": sp, "supports": su, "brim": br, "varyLayerHeight": v}
# Saved files from before the rename: old speed, supports and smartLayer names.
L = lambda d, s, sp="standard", su="auto", br=True, sl="off": {"detail": d, "strength": s, "speed": sp, "supports": su, "brim": br, "smartLayer": sl}
for g, (d, s, sp, v) in goals.items(): add("goal " + g + " on x1c", "x1c", E(d, s, sp, v=v))
add("defaults on x1c are the reference 0.20 mm setup", "x1c", E(40, 20))
add("detail 0", "x1c", E(0, 20)); add("detail 100", "x1c", E(100, 20)); add("detail 60", "x1c", E(60, 20)); add("detail 90", "x1c", E(90, 20))
add("strength 0", "x1c", E(40, 0)); add("strength 24 stays at 2 walls", "x1c", E(40, 24)); add("strength 25 gives 3 walls", "x1c", E(40, 25)); add("strength 100", "x1c", E(40, 100))
add("speed quality", "x1c", E(40, 20, "quality")); add("speed fast", "x1c", E(40, 20, "fast")); add("speed fastest is limited by accel and flow", "x1c", E(40, 20, "fastest"))
add("saved speed gentle and maximum read as quality and fastest", "x1c", L(40, 20, "gentle")); add("saved speed maximum", "x1c", L(40, 20, "maximum"))
add("supports off", "x1c", E(40, 20, "balanced", "off")); add("supports painted", "x1c", E(40, 20, "balanced", "painted"))
add("brim off", "x1c", E(40, 20, "balanced", "auto", False))
add("mk4s scalar values stay scalar", "mk4s", E(40, 20, "fast"))
add("mk4s fastest hits the flow cap", "mk4s", E(40, 20, "fastest"))
add("mk4s fine detail raises shell layers", "mk4s", E(100, 50, "quality"))
add("0.6 nozzle scales layer height", "n06", E(40, 20)); add("0.6 nozzle detail 0", "n06", E(0, 20)); add("0.6 nozzle detail 100", "n06", E(100, 20, "fastest"))
add("bare config defaults nozzle to 0.4", "bare", E(40, 20)); add("bare config, everything maxed", "bare", E(100, 100, "fastest", "painted", False))
add("vary layer height at the standard detail", "x1c", E(40, 20, v=True))
add("vary layer height at strength 70 uses the Strength mode", "x1c", E(40, 70, v=True))
add("smart layer quality at detail 100 narrows the bounds", "x1c", E(100, 20, v=True))
add("smart layer quality at detail 0 uses the full window", "x1c", E(0, 20, v=True))
add("smart layer on a 0.6 mm nozzle", "n06", E(40, 80, v=True))
add("smart layer on a 0.2 mm nozzle", "n02", E(60, 20, v=True))
add("smart layer keeps scalar values scalar", "mk4s", E(80, 30, "quality", v=True))
add("smart layer on a config with no nozzle", "bare", E(40, 20, v=True))
add("smart layer off resets the mode", "x1c", E(40, 20, v=False))
add("saved speed silent reads as quality", "x1c", L(40, 20, "silent"))
add("saved speed ludicrous and supports everywhere", "x1c", L(40, 20, "ludicrous", "everywhere"))
add("saved smartLayer strength keeps its mode at low strength", "x1c", L(40, 20, sl="strength"))
add("saved smartLayer quality", "n06", L(60, 20, sl="quality"))
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "..", "fixtures", "easy-cases.json"), "w") as fh:
    json.dump({"comment": "Both sx-settings and @slicerx/settings must produce exactly these keys. Generated by scripts/gen-easy-cases.py from the Easy mode concept formulas plus the flow and acceleration caps.", "bases": bases, "cases": cases}, fh, indent=1)
    fh.write("\n")
print(len(cases), "cases")
