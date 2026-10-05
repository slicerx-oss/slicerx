#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Whole-profile parity: OrcaSlicer slices a model on the Bambu Lab P1S profile (0.20mm Standard, generic PLA),
the settings it resolved (the config block at the end of its G-code) go to SlicerX, and the two outputs are
compared feature by feature.

    python3 profile_parity.py --sx path/to/sx --orca path/to/OrcaSlicer --workdir profile-work [--models gear,x-reference]
"""
import argparse
import json
import os
import re
import subprocess
import sys

import models as model_lib
import parity
import settings
import slicers


def config_block(gcode_path):
    """The settings Orca wrote at the end of its G-code, as a dict of strings."""
    out, on = {}, False
    with open(gcode_path, errors="replace") as f:
        for ln in f:
            if ln.startswith("; CONFIG_BLOCK_START"):
                on = True
            elif ln.startswith("; CONFIG_BLOCK_END"):
                break
            elif on and ln.startswith("; ") and " = " in ln:
                k, v = ln[2:].rstrip("\n").split(" = ", 1)
                out[k.strip()] = v
    return out


def to_sx(block):
    """Settings for SlicerX from the serialized config block: numbers and booleans as such, lists split."""
    cfg = {}
    for k, v in block.items():
        v = v.strip()
        if v in ("nil", ""):
            continue
        if re.fullmatch(r"-?\d+(\.\d+)?", v):
            cfg[k] = float(v) if "." in v else int(v)
        elif re.fullmatch(r"-?\d+(\.\d+)?%", v):
            cfg[k] = v
        elif "," in v and all(re.fullmatch(r"-?\d+(\.\d+)?", t.strip()) for t in v.split(",")):
            cfg[k] = [float(t) for t in v.split(",")]
        elif re.fullmatch(r"\d+x\d+(,\d+x\d+)+", v):
            cfg[k] = [[float(t) for t in p.split("x")] for p in v.split(",")]
        else:
            cfg[k] = v.strip('"')
        # The config block writes line breaks in G-code settings as a backslash and n.
        if k.endswith("gcode") and isinstance(cfg.get(k), str):
            cfg[k] = cfg[k].replace("\\n", "\n").replace('\\"', '"')
    return cfg


def sx_config_from_block(block):
    """SlicerX settings from the config block Orca wrote, with the lint workarounds the harness needs."""
    import orca_base

    cfg = to_sx(block)
    # Schema keys Orca does not have get the value that prints like Orca, not the schema default.
    for k, v in orca_base.SX_ONLY.items():
        cfg.setdefault(k, v)
    # Printers that end with a macro (END_PRINT) trip SlicerX's safety preflight; the harness adds the heater-off lines.
    # (SlicerX's lint also reads `filament_end_gcode` as a print end; that one runs at a filament change, so it is dropped.)
    cfg.pop("filament_end_gcode", None)
    # SlicerX's lint blocks these printer-memory and baby-step commands even in a stock Bambu start G-code.
    for key in [k for k in cfg if k.endswith("gcode")]:
        if isinstance(cfg.get(key), str):
            cfg[key] = "\n".join(l for l in cfg[key].split("\n") if l.strip().split(" ")[0] not in ("M710", "M290", "M500"))
    # SlicerX refuses a filament that needs a hardened nozzle on a soft one; Orca only warns.
    cfg.pop("required_nozzle_HRC", None)
    end = str(cfg.get("machine_end_gcode", ""))
    if "M104 S0" not in end:
        cfg["machine_end_gcode"] = end + "\nM104 S0\nM140 S0"
    return cfg


# (vendor folder, machine, process, filament) presets per printer.
PROFILES = {
    "bbl": ("BBL", "Bambu Lab P1S 0.4 nozzle", "0.20mm Standard @BBL X1C", "Bambu PLA Basic @BBL X1C"),
    "a1": ("BBL", "Bambu Lab A1 0.4 nozzle", "0.20mm Standard @BBL A1", "Bambu PLA Basic @BBL A1"),
    "mk4s": ("Prusa", "Prusa MK4S 0.4 nozzle", "0.20mm SPEED @MK4S 0.4", "Prusa Generic PLA @MK4S"),
    "k1": ("Creality", "Creality K1 (0.4 nozzle)", "0.20mm Standard @Creality K1 (0.4 nozzle)", "Creality Generic PLA @K1-all"),
}
PROFILE_DIRS = [
    "/Applications/OrcaSlicer.app/Contents/Resources/profiles",
    os.path.expanduser("~/private/orca-2.4.2/resources/profiles"),
]


def flatten(vendor, kind, name):
    """A system preset with everything it inherits merged in (Orca's CLI does not follow `inherits` for user presets)."""
    for root in PROFILE_DIRS:
        path = os.path.join(root, vendor, kind, name + ".json")
        if os.path.exists(path):
            break
    else:
        raise FileNotFoundError(f"{vendor}/{kind}/{name}")
    cur = json.load(open(path))
    parent = cur.get("inherits")
    base = flatten(vendor, kind, parent) if parent else {}
    base.update({k: v for k, v in cur.items() if k != "inherits"})
    return base


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default="bbl", choices=sorted(PROFILES))
    ap.add_argument("--set", action="append", default=[], help="process key=value given to Orca on top of the profile (SlicerX gets the resolved result)")
    ap.add_argument("--sx")
    ap.add_argument("--orca")
    ap.add_argument("--workdir", default="profile-work")
    ap.add_argument("--models", default="gear,x-reference,mushroom,block")
    a = ap.parse_args()
    d = os.path.abspath(a.workdir)
    os.makedirs(os.path.join(d, "models"), exist_ok=True)
    sx = slicers.SlicerX(a.sx).path
    ok = True
    for name in a.models.split(","):
        w = os.path.join(d, name)
        os.makedirs(os.path.join(w, "models"), exist_ok=True)
        stl = os.path.join(w, "models", f"{name}.stl")
        model_lib.write_stl(stl, model_lib.MODELS[name]())
        orca = parity.ParityOrca(slicers.Orca(a.orca).path, {})
        orca.prepare(w, {"cube": stl})
        vendor, machine, process, filament = PROFILES[a.profile]
        mach = flatten(vendor, "machine", machine)
        # Orca's CLI takes a user preset only with an `inherits`, and then keeps just what the file lists:
        # so the preset names its system parent and carries every inherited value itself.
        mach.update({"type": "machine", "name": "compare machine", "from": "User", "inherits": machine, "layer_change_gcode": "G92 E0"})
        json.dump(mach, open(orca.files["machine"], "w"))
        proc = flatten(vendor, "process", process)
        proc.update({"type": "process", "name": "compare process", "from": "User", "inherits": process,
                     "compatible_printers": ["compare machine", machine]})
        proc.pop("compatible_printers_condition", None)
        proc.update(kv.split("=", 1) for kv in a.set)
        json.dump(proc, open(orca.files["process"], "w"))
        fil = flatten(vendor, "filament", filament)
        fil.update({"type": "filament", "name": "compare filament", "from": "User", "inherits": filament,
                    "compatible_printers": ["compare machine", machine]})
        fil.pop("compatible_printers_condition", None)
        json.dump(fil, open(orca.files["filament"], "w"))
        out = os.path.join(w, "orca")
        os.makedirs(out, exist_ok=True)
        r = subprocess.run(orca._cmd(stl, out, ["--debug", "1", "--arrange", "0"]), capture_output=True, text=True)
        og = os.path.join(out, "plate_1.gcode")
        if not os.path.exists(og):
            print(name, "Orca produced no G-code:", (r.stdout + r.stderr)[-400:])
            ok = False
            continue
        block = config_block(og)
        cfg = sx_config_from_block(block)
        json.dump(cfg, open(os.path.join(w, "sx-config.json"), "w"), indent=1)
        sg = os.path.join(w, "sx.gcode")
        r = slicers.slice_trusted(sx, stl, cfg, sg)
        if not os.path.exists(sg):
            print(name, "SlicerX produced no G-code:", r.stderr[-400:])
            ok = False
            continue
        checks = dict(parity.DEFAULT_CHECKS)
        if str(cfg.get("enable_support", 0)) not in ("0", "false"):
            checks.update({"Support": (0.05, 20.0), "Support interface": (0.05, 20.0)})
        res = parity.compare(name, {"checks": checks, "note": "", "bbox": False}, parity.parse(sg), parity.parse(og))
        ok &= res["ok"]
        print(("ok  " if res["ok"] else "FAIL"), name, f"({len(block)} settings read from Orca)")
        for row in res["rows"]:
            print(f"       {row['what']:<28} sx {row['sx']:>9}  orca {row['orca']:>9}" + ("" if row["ok"] else "  <-- out of tolerance"))
        if res["only_in_one"]:
            print("       features in only one:", ", ".join(res["only_in_one"]))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
