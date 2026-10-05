#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Output options: SlicerX against OrcaSlicer on one model.

    python3 output_parity.py --sx path/to/sx --orca path/to/OrcaSlicer [--model gear]

Checks, each with the same setting given to both: verbose G-code comments (the comment
texts), slope z-hop (moves that rise while traveling), absolute extruder distances (M82 and a
G92 E0 for every layer), and retraction on layer change turned off (how many retractions
are left). Counts pass within 30 percent. Standard library only.
"""
import argparse
import os
import re
import sys

import firmware_parity as fp
import settings
import time_parity as tp
from gcode import is_layer_mark


def both(a, work, model, process, machine, extra_cfg):
    og = fp.orca_slice(a.orca, work, "marlin2", {**process, "brim_type": "no_brim", "slow_down_for_layer_cooling": 0}, machine, model, 1)
    cfg = settings.sx_config()
    cfg.update({"brim_width": 0, "slow_down_for_layer_cooling": False, **extra_cfg})
    return og, tp.one_object(a.sx, work, cfg, model)


def close(a, b, tol=0.3):
    return abs(a - b) <= max(3, tol * max(a, b))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sx", required=True)
    ap.add_argument("--orca", required=True)
    ap.add_argument("--model", default="gear")
    ap.add_argument("--workdir", default="output-work")
    a = ap.parse_args()
    work = os.path.abspath(a.workdir)
    ok = True

    def check(name, good, detail=""):
        nonlocal ok
        ok &= good
        print(("ok   " if good else "FAIL ") + name + (f"  {detail}" if detail else ""))

    og, sg = both(a, work, a.model, {"gcode_comments": 1}, {}, {"gcode_comments": True})
    texts = lambda g: set(re.findall(r" ; ([a-z][a-z ]+)$", g, re.M))
    want = {"perimeter", "infill", "retract", "unretract", "move to first perimeter point", "move to first infill point"}
    check("comment texts", want <= texts(og) and want <= texts(sg), f"orca {sorted(want - texts(og))} sx {sorted(want - texts(sg))}")

    og, sg = both(a, work, a.model, {"z_hop_types": "Slope Lift", "travel_slope": 3}, {"z_hop": 0.4, "retract_lift_above": 0},
                  {"z_hop": 0.4, "retract_lift_above": 0, "z_hop_types": "Slope Lift", "travel_slope": 3})
    ramps = lambda g: len(re.findall(r"^G[01] X[^E]* Z[\d.]+[^E]*$", g, re.M))
    retr = lambda g: len(re.findall(r"^G1 E-", g, re.M))
    ro, rs = ramps(og) / max(retr(og), 1), ramps(sg) / max(retr(sg), 1)
    check("slope lift: ramps per retraction", abs(ro - rs) <= 0.35, f"orca {ro:.2f} sx {rs:.2f}")

    og, sg = both(a, work, a.model, {"z_hop_types": "Spiral Lift"}, {"z_hop": 0.4, "retract_lift_above": 0, "gcode_comments": 1},
                  {"z_hop": 0.4, "retract_lift_above": 0, "z_hop_types": "Spiral Lift"})
    spirals = lambda g: g.count(";spiral lift Z")
    check("spiral lift: spirals per retraction", abs(spirals(og) / max(retr(og), 1) - spirals(sg) / max(retr(sg), 1)) <= 0.35, f"orca {spirals(og)}/{retr(og)} sx {spirals(sg)}/{retr(sg)}")

    og, sg = both(a, work, a.model, {"use_relative_e_distances": 0}, {"use_relative_e_distances": 0, "layer_change_gcode": ""}, {"use_relative_e_distances": False})
    check("absolute E: M82", "\nM82" in og and "\nM82" in sg)
    layers = lambda g: sum(1 for ln in g.splitlines() if is_layer_mark(ln))
    resets = lambda g: len(re.findall(r"^G92 E0", g, re.M))
    # Orca counts on without a reset (its layer G-code may not hold one); ours resets every layer so chunks join.
    check("absolute E: G92 E0 at the start of every layer (ours)", resets(sg) >= layers(sg), f"orca {resets(og)}/{layers(og)} sx {resets(sg)}/{layers(sg)}")
    total = lambda g: float(re.search(r"filament used \[mm\] = ([\d.]+)", g).group(1))
    check("absolute E: same filament as relative", abs(total(og) - total(sg)) <= 0.12 * total(og), f"orca {total(og)} sx {total(sg)}")

    og, sg = both(a, work, a.model, {"wipe_on_loops": 1, "gcode_comments": 1}, {}, {"wipe_on_loops": True, "gcode_comments": True})
    inward = lambda g: g.count("move inwards before travel")
    check("wipe on loops: inward moves", close(inward(og), inward(sg), 0.5) and inward(sg) > 0, f"orca {inward(og)} sx {inward(sg)}")

    og, sg = both(a, work, a.model, {"wall_sequence": "outer wall/inner wall", "wipe_before_external_loop": 1}, {},
                  {"wall_sequence": "outer wall/inner wall", "wipe_before_external_loop": True})
    landing = lambda g: len(re.findall(r"^G1 X[\d.]+ Y[\d.]+(?: ;.*)?$", g, re.M))
    base_o, base_s = both(a, work, a.model, {"wall_sequence": "outer wall/inner wall"}, {}, {"wall_sequence": "outer wall/inner wall"})
    do, ds = landing(og) - landing(base_o), landing(sg) - landing(base_s)
    check("wipe before external loop: landing moves", close(do, ds, 0.4) and ds > 0, f"orca {do} sx {ds}")

    on_o, on_s = both(a, work, a.model, {}, {}, {})
    off_o, off_s = both(a, work, a.model, {}, {"retract_when_changing_layer": 0}, {"retract_when_changing_layer": False})
    drop_o, drop_s = retr(on_o) - retr(off_o), retr(on_s) - retr(off_s)
    check("no retraction on layer change: retractions saved", close(drop_o, drop_s), f"orca {drop_o} sx {drop_s} (layers {layers(on_o)})")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
