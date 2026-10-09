#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Parity check: SlicerX against OrcaSlicer on the same model and settings.

    python3 parity.py                       # every case
    python3 parity.py --cases gyroid,table-support
    python3 parity.py --sx path/to/sx --orca path/to/OrcaSlicer --workdir parity-work

Each case slices one generated model with both slicers under the matched settings of
settings.py plus the case's overrides (Orca key names, which both read), then compares what
came out, read from the G-code the same way for both: layer count, filament length per
feature, and the bounding box of each feature. A case passes when every checked number is
within its tolerance. Exit code 1 when any case fails. Standard library only.
"""
import argparse
import json
import os
import re
import subprocess
import sys

import gcode
import models as model_lib
import orca_base
import settings
import slicers
from gcode import is_layer_mark, plain

# Features compared by default: name, relative tolerance, absolute floor in mm of filament.
DEFAULT_CHECKS = {"Outer wall": (0.10, 15.0), "Inner wall": (0.10, 15.0), "Top surface": (0.20, 20.0),
                  "Bottom surface": (0.20, 20.0), "Internal solid infill": (0.25, 30.0), "Sparse infill": (0.15, 30.0)}
DEFAULT_CHECKS["Top surface"] = (0.30, 20.0)

PATTERN_CASES = [
    ("line", "line"), ("grid", "grid"), ("triangles", "triangles"), ("cubic", "cubic"),
    ("crosshatch", "crosshatch"), ("honeycomb", "honeycomb"), ("3dhoneycomb", "3dhoneycomb"),
    ("gyroid", "gyroid"), ("concentric", "concentric"),
    ("trihexagon", "tri-hexagon"), ("adaptivecubic", "adaptivecubic"), ("supportcubic", "supportcubic"), ("lightning", "lightning"),
]

SUPPORT = {"enable_support": 1, "support_type": "normal(auto)", "support_style": "grid", "support_threshold_angle": 30,
           "support_on_build_plate_only": 0, "support_object_xy_distance": 0.35, "support_top_z_distance": 0.2,
           "support_bottom_z_distance": 0.2, "support_interface_top_layers": 2, "support_interface_bottom_layers": 0,
           "support_base_pattern": "rectilinear", "support_base_pattern_spacing": 2.5, "support_interface_spacing": 0.5,
           "support_speed": 150, "support_interface_speed": 80, "raft_layers": 0, "independent_support_layer_height": 0}

CASES = {}


# Orca features SlicerX does not have yet are switched off in the reference so the rest can be compared.
# independent_support_layer_height stays off unless a case turns it on: Orca 2.4.2 crashes slicing two
# filaments with it on (its prime tower check for it is compiled out), and it changes nothing without support.
ORCA_ONLY = {"ensure_vertical_shell_thickness": "none", "thick_bridges": 0, "independent_support_layer_height": 0}


def case(name, model, overrides=None, checks=None, note="", bbox=True, per_layer=None):
    overrides = dict(overrides or {})
    # Orca 2.4.2 names the organic tree style `organic`; it reads `tree_organic` as unknown and falls back to
    # its default style, so the case names keep `tree_organic` and both slicers get `organic`.
    if overrides.get("support_style") == "tree_organic":
        overrides["support_style"] = "organic"
    c = dict(DEFAULT_CHECKS)
    c.update(checks or {})
    # per_layer: {feature: mm} compares the feature layer by layer, so a feature printed on the wrong layer shows.
    CASES[name] = {"model": model, "overrides": overrides or {}, "checks": c, "note": note, "bbox": bbox,
                   "per_layer": per_layer or {}}


for m in ("cube", "gear", "x-reference"):
    case(f"base-{m}", m)
# Brim types around holes (the eccentric ring has one).
for _kind in ("inner_only", "outer_and_inner", "outer_only"):
    case(f"brim-{_kind}-eccentric-ring", "eccentric-ring", {"brim_type": _kind, "brim_width": 3},
         {"Brim": (0.2, 10.0)}, "brim types")
# Brim areas: auto widths, the object gap, and the outline the brim follows under elephant foot compensation.
for _m in ("knot", "gear", "mushroom", "flare", "thin-plate"):
    case(f"brim-auto-{_m}", _m, {"brim_type": "auto_brim"}, {"Brim": (0.2, 10.0)}, "brim areas")
case("brim-gap-gear", "gear", {"brim_type": "outer_only", "brim_width": 4, "brim_object_gap": 1.0}, {"Brim": (0.2, 10.0)}, "brim areas")
case("brim-efc-gear", "gear", {"brim_type": "outer_only", "brim_width": 4, "elefant_foot_compensation": 0.4}, {"Brim": (0.2, 10.0)}, "brim areas")
case("brim-efc-outline-gear", "gear", {"brim_type": "outer_only", "brim_width": 4, "elefant_foot_compensation": 0.4, "brim_use_efc_outline": 1},
     {"Brim": (0.2, 10.0)}, "brim areas")
# Mouse ears: discs at the sharp corners outside the part and inside its holes.
for _m in ("cube", "gear", "eccentric-ring", "x-reference", "thin-plate"):
    case(f"brim-ears-{_m}", _m, {"brim_type": "brim_ears", "brim_width": 5}, {"Brim": (0.2, 10.0)}, "mouse ears")
case("brim-ears-gear-angle", "gear", {"brim_type": "brim_ears", "brim_width": 4, "brim_ears_max_angle": 160, "brim_ears_detection_length": 0.5},
     {"Brim": (0.2, 10.0)}, "mouse ears")
# Fuzzy skin: Orca's noise is random, so length and statistics are compared, not points.
for _kind in ("external", "all", "allwalls"):
    case(f"fuzzy-{_kind}-eccentric-ring", "eccentric-ring",
         {"fuzzy_skin": _kind, "fuzzy_skin_thickness": 0.2, "fuzzy_skin_point_distance": 0.6},
         {"Outer wall": (0.08, 15.0), "Inner wall": (0.08, 15.0)}, "fuzzy skin")
# Fuzzy noise types (Perlin, Billow, ridged multifractal and Voronoi are libnoise's, so the same function
# of position as Orca's; the object origin differs) and the extrusion modes of variable-width walls.
for _noise in ("classic", "perlin", "billow", "ridgedmulti", "voronoi", "ripple"):
    case(f"fuzzy-{_noise}-eccentric-ring", "eccentric-ring",
         {"fuzzy_skin": "external", "fuzzy_skin_noise_type": _noise, "fuzzy_skin_thickness": 0.25,
          "fuzzy_skin_point_distance": 0.5, "wall_generator": "classic"},
         {"Outer wall": (0.08, 15.0)}, "fuzzy noise types")
for _mode in ("displacement", "extrusion", "combined"):
    case(f"fuzzy-arachne-{_mode}-eccentric-ring", "eccentric-ring",
         {"fuzzy_skin": "external", "fuzzy_skin_mode": _mode, "fuzzy_skin_noise_type": "perlin",
          "fuzzy_skin_thickness": 0.25, "fuzzy_skin_point_distance": 0.5, "wall_generator": "arachne"},
         {"Outer wall": (0.08, 15.0)}, "fuzzy modes")
# Draft shield: a skirt on every layer around the hull of the whole part.
for _m in ("mushroom", "table", "flare"):
    case(f"draft-{_m}", _m, {"draft_shield": "enabled", "skirt_loops": 2, "skirt_distance": 3, "skirt_height": 1},
         {"Skirt": (0.1, 10.0)}, "draft shield")
case("skirt-minlen-cube", "cube", {"skirt_loops": 1, "skirt_distance": 3, "skirt_height": 2, "min_skirt_length": 400}, {"Skirt": (0.1, 10.0)}, "min skirt length")
case("skirt-single-mushroom", "mushroom", {"skirt_loops": 3, "skirt_distance": 3, "skirt_height": 5, "single_loop_draft_shield": 1}, {"Skirt": (0.1, 10.0)}, "single loop draft shield")
case("skirt-mushroom", "mushroom", {"skirt_loops": 2, "skirt_distance": 3, "skirt_height": 3}, {"Skirt": (0.1, 10.0)}, "skirt height")
# Size compensation: the walls carry the outline, so their length and box show it.
for m in ("cube", "gear", "eccentric-ring"):
    case(f"elephantfoot-{m}", m, {"elefant_foot_compensation": 0.2})
    case(f"xycomp-{m}", m, {"xy_contour_compensation": 0.1, "xy_hole_compensation": -0.1})
    case(f"xyshrink-{m}", m, {"xy_contour_compensation": -0.1, "xy_hole_compensation": 0.1})
# Spiral vase: one wall climbing above a solid base (the eccentric ring loses its hole above the base).
for _m in ("cube", "flare", "eccentric-ring", "mushroom"):
    case(f"vase-{_m}", _m, {"spiral_mode": 1, "brim_width": 0, "brim_type": "no_brim", "wall_generator": "classic"},
         {"Outer wall": (0.15, 12.0)}, "spiral vase")
for _m in ("flare", "mushroom"):
    case(f"vase-smooth-{_m}", _m, {"spiral_mode": 1, "spiral_mode_smooth": 1, "brim_width": 0, "brim_type": "no_brim", "wall_generator": "classic"},
         {"Outer wall": (0.15, 12.0)}, "smooth spiral vase")
case("vase-ramps-cube", "cube", {"spiral_mode": 1, "brim_width": 0, "brim_type": "no_brim", "wall_generator": "classic",
                                 "spiral_starting_flow_ratio": 0.5, "spiral_finishing_flow_ratio": 0.5}, {"Outer wall": (0.15, 12.0)}, "spiral flow ramps")
# Seam placement: positions are compared with seam_stats.py on the kept G-code; the harness checks the walls.
for _mode in ("aligned", "aligned_back", "back", "nearest", "random"):
    for _m in ("gear", "x-reference", "mushroom", "knot", "flare"):
        case(f"seam-{_mode}-{_m}", _m, {"seam_position": _mode}, {"Outer wall": (0.1, 10.0)}, "seam placement")
# Scarf joint seams and the seam gap (extrusion and Z moves of the walls).
for _m in ("cube", "eccentric-ring", "mushroom"):
    case(f"scarf-{_m}", _m, {"seam_slope_type": "external", "seam_slope_min_length": 10, "seam_slope_steps": 10, "seam_position": "back"},
         {"Outer wall": (0.1, 10.0), "Inner wall": (0.1, 10.0)}, "scarf seam")
case("scarf-all-ring", "eccentric-ring", {"seam_slope_type": "all", "seam_slope_inner_walls": 1, "seam_slope_min_length": 8, "seam_slope_start_height": "50%",
                                       "seam_position": "back", "scarf_joint_flow_ratio": 1.1}, {"Outer wall": (0.1, 10.0), "Inner wall": (0.1, 10.0)}, "scarf seam")
case("scarf-conditional-gear", "gear", {"seam_slope_type": "external", "seam_slope_conditional": 1, "seam_position": "back"},
     {"Outer wall": (0.1, 10.0), "Inner wall": (0.1, 10.0)}, "scarf seam")
case("seam-gap-cube", "cube", {"seam_gap": "50%", "seam_position": "back"}, {"Outer wall": (0.1, 10.0)}, "seam gap")
for label, orca in PATTERN_CASES:
    case(f"pattern-{label}", "block", {"sparse_infill_pattern": orca, "sparse_infill_density": 15},
         {"Sparse infill": (0.20, 40.0)})
case("flare-overhang", "flare", {}, {"Overhang wall": (0.35, 20.0)})
for _top in (30, 43, 50, 60, 80):
    case(f"probe-flare-{_top}", f"flare{_top}", {}, {"Overhang wall": (1.0, 1e9)}, "probe: which flare angles Orca labels as overhang walls")
# Overhang walls as Orca classifies them: a wall whose center line lies more than half the nozzle past the layer
# below. At 0.15 mm layers the 70 degree slab moves 0.41 mm a layer, which puts its outer wall 0.20 mm out: just
# past half the nozzle. Two parts meeting on a cutting plane: that layer is the lower part's top.
# (Orca turns the slabs round on the bed, so their extents are not compared.)
for _h in (0.2, 0.15):
    case(f"overhang-slabs-{_h}", "leaning-slabs", {"layer_height": _h}, {"Overhang wall": (0.05, 1.0)}, "overhang walls",
         bbox=False, per_layer={"Overhang wall": 0.1})
case("overhang-stacked", "stacked", {}, {"Overhang wall": (0.05, 1.0)}, "overhang walls",
     per_layer={"Overhang wall": 0.1, "Outer wall": 0.1})
case("table-bridge", "table", {}, {"Bridge": (0.35, 20.0)})
case("table-support", "table", SUPPORT, {"Support": (0.35, 40.0), "Support interface": (0.5, 40.0)})
case("table-support-angle45", "table", {**SUPPORT, "support_angle": 45}, {"Support": (0.35, 40.0), "Support interface": (0.5, 40.0)})
case("table-support-snug", "table", {**SUPPORT, "support_style": "snug"}, {"Support": (0.35, 40.0), "Support interface": (0.5, 40.0)})
for _label, _extra in (("indep", {"independent_support_layer_height": 1}), ("bottom2", {"support_interface_bottom_layers": 2}),
                       ("widths", {"inner_wall_line_width": 0.45, "sparse_infill_line_width": 0.45, "initial_layer_line_width": 0.5})):
    case(f"table-organic-{_label}", "table", {**SUPPORT, "support_type": "tree(auto)", "support_style": "tree_organic", **_extra},
         {"Support": (0.6, 60.0), "Support interface": (0.8, 60.0)}, "tree", bbox=False)
for _style in ("tree_organic", "tree_slim", "tree_strong", "tree_hybrid"):
    case(f"table-{_style}", "table", {**SUPPORT, "support_type": "tree(auto)", "support_style": _style},
         {"Support": (0.6, 60.0), "Support interface": (0.8, 60.0)}, "tree", bbox=False)
    case(f"mushroom-{_style}", "mushroom", {**SUPPORT, "support_type": "tree(auto)", "support_style": _style},
         {"Support": (0.6, 60.0), "Support interface": (0.8, 60.0)}, "tree", bbox=False)
for _m in ("x-reference", "gear", "flare", "flare50"):
    for _mode in ("ensure_all", "ensure_moderate", "ensure_critical_only", "none"):
        case(f"shell-{_mode}-{_m}", _m, {"ensure_vertical_shell_thickness": _mode},
             {"Internal solid infill": (0.1, 10.0), "Sparse infill": (0.1, 10.0)}, "ensure_vertical_shell_thickness")
for _n in (1, 2, 3, 5):
    case(f"shellbot-{_n}", "flare", {"ensure_vertical_shell_thickness": "ensure_all", "bottom_shell_layers": _n, "top_shell_layers": _n},
         {"Internal solid infill": (0.1, 10.0)}, "ensure shells vs shell layers")
for _m in ("x-reference", "gear", "thin-plate", "flare", "wedge", "eccentric-ring", "crossed-bars", "bar10", "bar12", "bar14", "bar16"):
    # Orca's command line turns the crossed bars 30 degrees on load (the smallest box), so their boxes differ.
    case(f"arachne-{_m}", _m, {"wall_generator": "arachne"}, {"Outer wall": (0.1, 10.0), "Inner wall": (0.1, 10.0)}, "arachne",
         bbox=_m != "crossed-bars")
for _kind in ("top", "topmost", "solid"):
    case(f"ironing-{_kind}", "block", {"ironing_type": _kind, "ironing_speed": 15, "ironing_flow": "15%", "ironing_spacing": 0.15},
         {"Ironing": (0.25, 10.0), "Top surface": (0.2, 15.0)}, "ironing")
case("mushroom-support", "mushroom", SUPPORT, {"Support": (0.4, 40.0), "Support interface": (0.5, 40.0)})
case("mushroom-support-bottom", "mushroom", {**SUPPORT, "support_interface_bottom_layers": 2}, {"Support": (0.4, 40.0), "Support interface": (0.5, 40.0)})
for _b in (1, 3):
    case(f"mushroom-support-bottom{_b}", "mushroom", {**SUPPORT, "support_interface_bottom_layers": _b}, {"Support interface": (0.5, 40.0)})
case("table-support-bottom", "table", {**SUPPORT, "support_interface_bottom_layers": 2}, {"Support": (0.4, 40.0), "Support interface": (0.5, 40.0)})
case("mushroom-support-plate", "mushroom", {**SUPPORT, "support_on_build_plate_only": 1},
     {"Support": (0.4, 40.0), "Support interface": (0.5, 40.0)})
case("thin-plate-gap", "thin-plate", {}, {"Gap infill": (0.4, 3.0)})
for _mode in ("top", "topmost", "solid"):
    case(f"ironing-{_mode}", "cube", {"ironing_type": _mode, "ironing_spacing": 0.15, "ironing_flow": 15, "ironing_speed": 20, "brim_type": "no_brim", "brim_width": 0},
         {"Ironing": (0.3, 10.0)})
case("ironing-concentric", "cube", {"ironing_type": "top", "ironing_pattern": "concentric", "ironing_spacing": 0.15, "ironing_flow": 15, "ironing_speed": 20, "brim_type": "no_brim", "brim_width": 0},
     {"Ironing": (0.3, 10.0)})
for _pat in ("hilbertcurve", "archimedeanchords", "octagramspiral", "concentric"):
    case(f"top-{_pat}", "cube", {"top_surface_pattern": _pat, "brim_type": "no_brim", "brim_width": 0}, {"Top surface": (0.35, 20.0)})
case("bottom-concentric", "cube", {"bottom_surface_pattern": "concentric", "brim_type": "no_brim", "brim_width": 0}, {"Bottom surface": (0.35, 20.0)})
case("cube-skirt", "cube", {"skirt_loops": 2, "skirt_distance": 3, "skirt_height": 2, "brim_type": "no_brim", "brim_width": 0},
     {"Skirt": (0.1, 5.0)})


# Independent support layer height: Orca's default, so the support layers have heights of their own.
case("table-support-indep", "table", {**SUPPORT, "independent_support_layer_height": 1}, {"Support": (0.4, 40.0), "Support interface": (0.5, 40.0)})
case("mushroom-support-indep", "mushroom", {**SUPPORT, "independent_support_layer_height": 1}, {"Support": (0.4, 40.0), "Support interface": (0.5, 40.0)})
# A raft under supports: the raft and the support layers are one plan (contacts low enough sit on the raft).
for _m in ("table", "mushroom"):
    for _r in (1, 3):
        case(f"{_m}-support-raft{_r}", _m, {**SUPPORT, "raft_layers": _r, "brim_type": "no_brim", "brim_width": 0},
             {"Support": (0.4, 40.0), "Support interface": (0.5, 40.0)}, "raft and supports")
        case(f"{_m}-support-indep-raft{_r}", _m, {**SUPPORT, "independent_support_layer_height": 1, "raft_layers": _r, "brim_type": "no_brim", "brim_width": 0},
             {"Support": (0.4, 40.0), "Support interface": (0.5, 40.0)}, "raft and supports")
# Tree supports with independent layer heights: organic stays on the object's layers in Orca, the others plan their own.
for _style in ("tree_slim", "tree_strong", "tree_hybrid", "tree_organic"):
    for _m in ("table", "mushroom"):
        case(f"{_m}-{_style}-indep", _m, {**SUPPORT, "support_type": "tree(auto)", "support_style": _style, "independent_support_layer_height": 1},
             {"Support": (0.6, 60.0), "Support interface": (0.8, 60.0)}, "tree", bbox=False)

# Support keys: ironing of the top contact, interface patterns, contact loops, no support under bridges,
# full support on the first layers.
_SC = {"Support": (0.1, 20.0), "Support interface": (0.1, 20.0)}
case("table-support-ironing", "table", {**SUPPORT, "support_ironing": 1}, {**_SC, "Ironing": (0.15, 5.0)})
for _ip in ("rectilinear", "concentric", "rectilinear_interlaced", "grid"):
    case(f"table-support-iface-{_ip}", "table", {**SUPPORT, "support_style": "snug", "support_interface_pattern": _ip}, _SC)
case("table-support-loops", "table", {**SUPPORT, "support_interface_loop_pattern": 1}, _SC)
for _bs in (0, 1.5):
    case(f"mushroom-support-bottomspacing{_bs}", "mushroom", {**SUPPORT, "support_interface_bottom_layers": 2, "support_bottom_interface_spacing": _bs}, _SC)
case("toadstool-support-snug", "toadstool", {**SUPPORT, "support_style": "snug"}, _SC)
case("toadstool-support", "toadstool", SUPPORT, _SC)
for _style in ("tree_slim", "tree_strong", "tree_hybrid", "tree_organic"):
    case(f"toadstool-{_style}", "toadstool", {**SUPPORT, "support_type": "tree(auto)", "support_style": _style},
         {"Support": (0.6, 60.0), "Support interface": (0.8, 60.0)}, "tree", bbox=False)
case("table-support-nobridge", "table", {**SUPPORT, "bridge_no_support": 1}, _SC)
case("mushroom-support-enforce", "mushroom", {**SUPPORT, "support_threshold_angle": 10, "enforce_support_layers": 40}, _SC)
case("mushroom-support-overlap", "mushroom", {**SUPPORT, "support_threshold_angle": 0}, _SC)

# One wall on top surfaces: the inner walls stop where a top surface is.
for _gen in ("classic", "arachne"):
    case(f"onewalltop-{_gen}-x-reference", "x-reference", {"only_one_wall_top": 1, "wall_loops": 3, "wall_generator": _gen},
         {"Inner wall": (0.1, 10.0), "Top surface": (0.15, 10.0), "Internal solid infill": (0.2, 10.0)}, "only_one_wall_top")
    case(f"onewalltop-{_gen}-mushroom", "mushroom", {"only_one_wall_top": 1, "wall_loops": 3, "wall_generator": _gen},
         {"Inner wall": (0.1, 10.0), "Top surface": (0.15, 10.0), "Internal solid infill": (0.2, 10.0)}, "only_one_wall_top")
    case(f"extrawall-{_gen}-x-reference", "x-reference", {"alternate_extra_wall": 1, "wall_generator": _gen},
         {"Inner wall": (0.05, 10.0)}, "alternate_extra_wall")

# Line widths per feature, as the Bambu profiles set them (first layer 0.5).
WIDTHS = {"outer_wall_line_width": 0.42, "inner_wall_line_width": 0.45, "sparse_infill_line_width": 0.45,
          "internal_solid_infill_line_width": 0.42, "top_surface_line_width": 0.42, "initial_layer_line_width": 0.5}
for _m in ("x-reference", "gear"):
    case(f"widths-{_m}", _m, WIDTHS, {}, "per-feature line widths")

TIME_TOL = 0.03  # the standing gate: estimated print time within 3 percent of Orca's


def print_time(path):
    """Seconds of the estimated printing time in a G-code footer (normal mode), or None."""
    def secs(text):
        return sum(int(n) * {"d": 86400, "h": 3600, "m": 60, "s": 1}[u] for n, u in re.findall(r"(\d+)([dhms])", text))
    with open(path, errors="replace") as f:
        for ln in f:
            if ln.startswith("; estimated printing time (normal mode) = "):
                return secs(ln.split("=", 1)[1])
            # Orca writes Bambu Lab printers' time in the header instead.
            if ln.startswith("; model printing time:") and "total estimated time:" in ln:
                return secs(ln.split("total estimated time:", 1)[1])
    return None


def time_row(sx_s, orca_s, tol=TIME_TOL):
    """The print time row of a comparison: within `tol` of Orca's."""
    ok = bool(sx_s) and bool(orca_s) and abs(sx_s / orca_s - 1) <= tol
    return {"what": "print time s", "sx": sx_s, "orca": orca_s, "tol": tol, "ok": ok}


def parse(path):
    """Per feature: extruded length (mm of filament), bounding box of its moves, plus layers and totals."""
    rel = False
    e = 0.0
    x = y = None
    kind = "unlabeled"
    feats = {}
    by_layer = {}
    layers = 0
    with open(path, errors="replace") as f:
        for ln in f:
            if ln[0] == ";":
                tag = plain(ln)
                if tag.startswith(";TYPE:"):
                    kind = tag[6:].strip()
                elif is_layer_mark(ln):
                    layers += 1
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
            f_ = {w[0]: w[1:] for w in words[1:] if len(w) > 1}
            try:
                nx = float(f_["X"]) if "X" in f_ else x
                ny = float(f_["Y"]) if "Y" in f_ else y
                v = float(f_["E"]) if "E" in f_ else None
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
            if delta > 0 and ("X" in f_ or "Y" in f_) and nx is not None and ny is not None:
                d = feats.setdefault(kind, {"mm": 0.0, "bbox": [1e9, 1e9, -1e9, -1e9]})
                d["mm"] += delta
                per = by_layer.setdefault(kind, {})
                per[layers] = per.get(layers, 0.0) + delta
                b = d["bbox"]
                for px, py in ((x, y), (nx, ny)):
                    if px is not None:
                        b[0], b[1], b[2], b[3] = min(b[0], px), min(b[1], py), max(b[2], px), max(b[3], py)
            x, y = nx, ny
    return {"layers": layers, "features": feats, "total_mm": sum(d["mm"] for d in feats.values()),
            "time_s": print_time(path), "by_layer": by_layer}


class ParityOrca(slicers.Orca):
    def __init__(self, path, extra):
        super().__init__(path)
        self.extra = {k: str(v) for k, v in extra.items()}

    def prepare(self, work, models):
        original = settings.slicer_process

        def patched(flavor):
            p = original(flavor)
            p.update(self.extra)
            return p

        original_filament = settings.slicer_filament

        def patched_filament():
            f = original_filament()
            # Filament keys belong in the filament preset, one entry per filament.
            f.update({k: [v] for k, v in self.extra.items() if k.startswith("filament_") and k not in ("filament_diameter",)})
            return f

        settings.slicer_process = patched
        settings.slicer_filament = patched_filament
        try:
            super().prepare(work, models)
        finally:
            settings.slicer_process = original
            settings.slicer_filament = original_filament


def run_case(name, c, sx_path, orca_path, work):
    d = os.path.join(work, name)
    os.makedirs(os.path.join(d, "models"), exist_ok=True)
    model = c["model"]
    stl = os.path.join(d, "models", f"{model}.stl")
    model_lib.write_stl(stl, model_lib.MODELS[model]())
    # Every key stated: what Orca 2.4.2 resolves for the reference (orca_base.json), then the case.
    cfg = orca_base.sx_base()
    cfg.update(ORCA_ONLY)
    cfg.update(c["overrides"])
    if cfg.get("brim_type") == "no_brim":
        cfg["brim_width"] = 0
    cfg_path = os.path.join(d, "sx.json")
    json.dump(cfg, open(cfg_path, "w"))
    sx_gcode = os.path.join(d, "sx.gcode")
    subprocess.run([sx_path, "slice", stl, "--config", cfg_path, "-o", sx_gcode], capture_output=True, check=True)
    orca = ParityOrca(orca_path, {**ORCA_ONLY, **c["overrides"]})
    orca.prepare(d, {"cube": stl})
    job = orca.job(model, d)
    r = subprocess.run(job.cmd, capture_output=True, text=True)
    if not os.path.exists(job.gcode):
        return {"name": name, "error": f"Orca produced no G-code: {r.stderr[-300:]}"}
    res = compare(name, c, parse(sx_gcode), parse(job.gcode))
    res["settings_differ"] = settings_drift(cfg, job.gcode)
    return res


def _norm(v):
    """A setting value in one comparable spelling: 0.20 and "0.2", true and "1", [0.4] and "0.4"."""
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (list, tuple)):
        # a bed outline is a list of points, which the config block writes as 0x0,256x0,...
        return ",".join("x".join(_norm(p) for p in x) if isinstance(x, (list, tuple)) else _norm(x) for x in v)
    t = str(v).strip().strip('"')
    if t.lower() in ("true", "false"):
        return "1" if t.lower() == "true" else "0"
    try:
        return f"{float(t):g}"
    except ValueError:
        return t.replace("\\n", "\n")


# Keys whose spelling differs between the two configs without a different print.
DRIFT_SKIP = {"machine_end_gcode", "prime_tower_auto_position", "sparse_infill_pattern",
              # derived by Orca from the objects' own settings, not an input
              "has_scarf_joint_seam"}
# Spiral vase: Orca writes the values the vase forces (one wall, no top shell); SlicerX applies them itself.
VASE_FORCED = {"wall_loops", "top_shell_layers", "top_shell_thickness", "sparse_infill_density", "enable_support",
               "ensure_vertical_shell_thickness"}


def settings_drift(cfg, orca_gcode):
    """Keys SlicerX was given with a value other than the one Orca wrote for this case: each one means the
    two slicers did not get the same settings."""
    import profile_parity

    block = profile_parity.config_block(orca_gcode)
    out = []
    for k, v in sorted(cfg.items()):
        a, b = _norm(v), _norm(block.get(k, ""))
        if k in ("sparse_infill_density", "ironing_flow"):  # 15 and 15% are the same percent
            a, b = a.rstrip("%"), b.rstrip("%")
        vase = str(cfg.get("spiral_mode", 0)) in ("1", "True", "true")
        if k in block and k not in DRIFT_SKIP and not (vase and k in VASE_FORCED) and not k.endswith("gcode") and a != b:
            out.append(f"{k}: sx {_norm(v)[:30]} orca {_norm(block[k])[:30]}")
    return out


def compare(name, c, a, b):
    check_bbox = c.get("bbox", True)
    rows, ok = [], True
    if a["layers"] != b["layers"]:
        rows.append({"what": "layers", "sx": a["layers"], "orca": b["layers"], "ok": abs(a["layers"] - b["layers"]) <= 1})
        ok &= rows[-1]["ok"]
    rel = 0.07
    rows.append({"what": "total filament mm", "sx": round(a["total_mm"], 1), "orca": round(b["total_mm"], 1),
                 "ok": abs(a["total_mm"] - b["total_mm"]) <= max(rel * b["total_mm"], 30.0)})
    ok &= rows[-1]["ok"]
    rows.append(time_row(a.get("time_s"), b.get("time_s")))
    ok &= rows[-1]["ok"]
    for feat, (tol, floor) in c["checks"].items():
        fa, fb = a["features"].get(feat), b["features"].get(feat)
        ma, mb = (fa or {"mm": 0.0})["mm"], (fb or {"mm": 0.0})["mm"]
        good = abs(ma - mb) <= max(tol * mb, floor)
        row = {"what": f"{feat} mm", "sx": round(ma, 1), "orca": round(mb, 1), "tol": tol, "ok": good}
        if fa and fb:
            row["bbox_delta"] = [round(p - q, 2) for p, q in zip(fa["bbox"], fb["bbox"])]
            if check_bbox and feat in ("Outer wall", "Support", "Skirt", "Bridge"):
                row["ok"] = good and max(abs(v) for v in row["bbox_delta"]) <= 2.0
        rows.append(row)
        ok &= row["ok"]
    for feat, tol in c.get("per_layer", {}).items():
        pa, pb = a["by_layer"].get(feat, {}), b["by_layer"].get(feat, {})
        worst = max([(abs(pa.get(k, 0.0) - pb.get(k, 0.0)), k) for k in set(pa) | set(pb)] or [(0.0, 0)])
        rows.append({"what": f"{feat} worst layer", "sx": round(pa.get(worst[1], 0.0), 2), "orca": round(pb.get(worst[1], 0.0), 2),
                     "layer": worst[1], "ok": worst[0] <= tol})
        ok &= rows[-1]["ok"]
    extra = sorted(set(a["features"]) ^ set(b["features"]))
    return {"name": name, "ok": ok, "rows": rows, "only_in_one": extra, "note": c["note"]}


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", default="")
    ap.add_argument("--sx")
    ap.add_argument("--orca")
    ap.add_argument("--workdir", default="parity-work")
    ap.add_argument("--out", default="parity-results.json")
    a = ap.parse_args()
    sx = slicers.SlicerX(a.sx)
    orca = slicers.Orca(a.orca)
    if not sx.available() or not orca.available():
        print("need both sx and OrcaSlicer (--sx, --orca)", file=sys.stderr)
        return 2
    names = [n for n in (a.cases.split(",") if a.cases else CASES) if n]
    results = []
    for n in names:
        res = run_case(n, CASES[n], sx.path, orca.path, os.path.abspath(a.workdir))
        results.append(res)
        if "error" in res:
            print(f"ERROR {n}: {res['error']}")
            continue
        print(("ok   " if res["ok"] else "FAIL ") + n)
        for r in res["rows"]:
            flag = "" if r["ok"] else "  <-- out of tolerance"
            print(f"       {r['what']:<28} sx {r['sx']:>9} orca {r['orca']:>9}{flag}")
        if res["only_in_one"]:
            print(f"       features in only one: {', '.join(res['only_in_one'])}")
        for d in res.get("settings_differ", []):
            print(f"       settings differ: {d}")
    json.dump({"cases": results}, open(a.out, "w"), indent=1)
    return 0 if all(r.get("ok") for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())

